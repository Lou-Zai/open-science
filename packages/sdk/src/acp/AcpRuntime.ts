// AcpRuntime: drive ANY agent that speaks the Agent Client Protocol (#14, #25).
//
// This is the second `AgentRuntime` alongside `OpenCodeClient`, and the point of
// the seam: the UI, provenance and run recording already talk to `AgentRuntime`,
// so "support Codex / Gemini CLI / Claude Code" becomes "configure a command"
// rather than "write another adapter".
//
// It takes a TRANSPORT rather than spawning the agent itself. The webview has no
// `child_process`, and the gateway web client (a phone) has no local process at
// all — so the child is supervised where the OpenCode sidecar already is, on the
// Rust side, and relayed here. Node tests inject a stdio transport that really
// does spawn one (`./stdio`), which is how this is verified against real agents.
//
// What ACP v1 does NOT give us, and is therefore honest about below rather than
// faked: conversation history on reopen (`session/load` replays notifications,
// it does not answer with a transcript), model SELECTION (no `session/set_model`
// — the agent owns its model list; codex-acp even encodes reasoning effort in
// the model id, `gpt-5.6-sol[high]`), revert/unrevert, skills, and archiving.
import { BaseAgentRuntime } from "../base-runtime";
import type { AgentRuntime } from "../runtime";
import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  SessionMeta,
  SessionPage,
  SessionQuery,
  SkillInfo,
  ToolCallStatus,
} from "../types";
import {
  ACP_PROTOCOL_VERSION,
  JsonRpcPeer,
  type AcpAgentCapabilities,
  type AcpAgentInfo,
  type AcpCommand,
  type AcpInitializeResult,
  type AcpModelInfo,
  type AcpNewSessionResult,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpToolCallUpdate,
  type JsonRpcTransport,
} from "./protocol";

/** A turn has no deadline: an agent legitimately works for many minutes. */
const NO_TIMEOUT = 0;

export interface AcpRuntimeOptions {
  transport: JsonRpcTransport;
  /** Workspace folder every session is created in — ACP takes it per session
   *  (`session/new`'s `cwd`), which is exactly our per-session workspace. */
  cwd: string;
  /** Optional label for errors and Settings ("Codex", "Gemini CLI"). Falls back
   *  to whatever the agent calls itself in `initialize`. */
  name?: string;
}

interface SessionState {
  title: string;
  /** Accumulated text per `messageId`. ACP streams agent_message_chunk as
   *  DELTAS (verified against codex-acp 1.1.9), while our `text.updated` carries
   *  the full current value and the app upserts by `partId` — so the runtime
   *  accumulates, exactly as `OpenCodeClient` does for its own deltas. */
  text: Map<string, string>;
  reasoning: Map<string, string>;
  models: AcpModelInfo[];
  currentModelId?: string;
  /** Resolve for the in-flight `session/prompt`, so `abortSession` can settle. */
  promptRunning: boolean;
  /** Turns started, so a chunk that carries NO `messageId` can still be keyed to
   *  its own turn. Verified against codex-acp 1.1.9: its pre-answer notices (a
   *  skills-budget warning) arrive id-less, and a single shared fallback key
   *  would glue every such notice in the session into one growing block. */
  turn: number;
}

export class AcpRuntime extends BaseAgentRuntime implements AgentRuntime {
  private readonly peer: JsonRpcPeer;
  private readonly sessions = new Map<string, SessionState>();
  private readonly cwd: string;
  private readonly label?: string;
  private agentInfo?: AcpAgentInfo;
  private agentCapabilities?: AcpAgentCapabilities;
  private commands: CommandInfo[] = [];
  /** Permission requests the agent is blocked on, keyed by our own request id.
   *  ACP answers a permission by RESPONDING to the agent's request, so the
   *  resolver has to be held until the user replies. */
  private readonly permissions = new Map<
    string,
    { event: PermissionAskedEvent; options: AcpPermissionRequest["options"]; resolve: (v: unknown) => void }
  >();
  private permissionSeq = 0;

  constructor(opts: AcpRuntimeOptions) {
    super();
    this.cwd = opts.cwd;
    this.label = opts.name;
    this.peer = new JsonRpcPeer(opts.transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onClose: (reason) => {
        this.setStatus("offline");
        // Every session's turn dies with the process; say so once rather than
        // leaving the UI spinning on a turn that can never finish.
        for (const [id, s] of this.sessions) {
          if (!s.promptRunning) continue;
          s.promptRunning = false;
          this.emit({ type: "error", sessionId: id, message: reason ?? "the agent exited" });
          this.emit({ type: "session.idle", sessionId: id });
        }
      },
    });
  }

  /** What the agent calls itself, for Settings and error messages. */
  get displayName(): string {
    return this.label ?? this.agentInfo?.title ?? this.agentInfo?.name ?? "ACP agent";
  }

  /** Whether the agent can replay a past conversation (`initialize`'s
   *  `loadSession`). Recorded now because it decides whether reopening an ACP
   *  session can ever show its history — see `getMessages`. */
  get supportsSessionReplay(): boolean {
    return this.agentCapabilities?.loadSession === true;
  }

  /** Models the agent reported for the session it created, if any. ACP has no
   *  model-setting method, so this is display/diagnostic only. */
  modelsFor(sessionId: string): AcpModelInfo[] {
    return this.sessions.get(sessionId)?.models ?? [];
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      const result = await this.peer.request<AcpInitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Both false on purpose for this slice: with `fs` advertised the agent
        // would send us `fs/read_text_file` / `fs/write_text_file` requests, and
        // answering those means handing an external process file access from
        // inside the app — which AGENTS.md puts behind approval. The agent still
        // reads and writes through its OWN tools, which stay subject to its own
        // permission requests, and those we do answer.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      this.agentInfo = result.agentInfo;
      this.agentCapabilities = result.agentCapabilities;
      if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
        // Not fatal: v1 is what every agent tested answers, and a higher number
        // means the agent is newer, not incompatible. Recorded, not enforced.
        this.emit({
          type: "error",
          message: `${this.displayName} negotiated ACP protocol version ${result.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`,
        });
      }
      this.setStatus("ready");
    } catch (err) {
      this.setStatus("offline");
      throw err;
    }
  }

  close(): void {
    this.peer.close();
    this.setStatus("offline");
  }

  // ---- sessions ----

  async createSession(title?: string): Promise<string> {
    const result = await this.peer.request<AcpNewSessionResult>("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    });
    this.sessions.set(result.sessionId, {
      // ACP has no session title, so the app's own is kept here — it is what the
      // sidebar shows, and the agent never needs to know it.
      title: title ?? "New session",
      text: new Map(),
      reasoning: new Map(),
      models: result.models?.availableModels ?? [],
      currentModelId: result.models?.currentModelId,
      promptRunning: false,
      turn: 0,
    });
    return result.sessionId;
  }

  async listSessions(): Promise<SessionMeta[]> {
    // Only the sessions this client created. ACP v1 standardizes no listing (the
    // `session/list` some agents advertise is an extension), and inventing one
    // would make the sidebar claim a history we cannot actually load.
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      title: s.title,
      directory: this.cwd,
    }));
  }

  async querySessions(_query?: SessionQuery): Promise<SessionPage> {
    return { sessions: await this.listSessions(), nextCursor: null };
  }

  async setSessionArchived(_sessionId: string, _archived: boolean): Promise<void> {
    throw new Error(`${this.displayName} does not support archiving conversations`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }

  async getMessages(_sessionId: string): Promise<HistoryMessage[]> {
    // ACP's `session/load` REPLAYS `session/update` notifications rather than
    // answering with a transcript, so there is nothing to return synchronously.
    // The thread is built from live events; reopening an ACP session shows it
    // empty until replay is wired (the next slice).
    return [];
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    _agent?: string,
    _model?: string | null,
    _variant?: string | null,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown session ${sessionId}`);
    state.promptRunning = true;
    state.turn += 1;
    // `agent`, `model` and `variant` are deliberately dropped, not silently
    // approximated: ACP v1 has no per-turn agent, no `session/set_model`, and no
    // effort vocabulary. codex-acp folds effort INTO the model id, so honouring
    // `variant` would mean guessing another agent's id grammar.
    try {
      const result = await this.peer.request<AcpPromptResult>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        NO_TIMEOUT,
      );
      state.promptRunning = false;
      if (result?.stopReason && result.stopReason !== "end_turn" && result.stopReason !== "cancelled") {
        // "max_tokens", "refusal", … — the turn ended for a reason the user has
        // to know about, in the agent's own word for it.
        this.emit({ type: "error", sessionId, message: `the turn stopped: ${result.stopReason}` });
      }
      this.emit({ type: "session.idle", sessionId });
    } catch (err) {
      state.promptRunning = false;
      this.emit({
        type: "error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      this.emit({ type: "session.idle", sessionId });
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    // A notification, not a request: ACP's `session/cancel` has no response, and
    // the turn's own `session/prompt` settles with stopReason "cancelled".
    this.peer.notify("session/cancel", { sessionId });
  }

  async revert(_sessionId: string, _messageID: string, _partID?: string): Promise<void> {
    throw new Error(`${this.displayName} does not support reverting messages`);
  }

  async unrevert(_sessionId: string): Promise<void> {
    throw new Error(`${this.displayName} does not support reverting messages`);
  }

  // ---- capability discovery ----

  async listSkills(): Promise<SkillInfo[]> {
    return []; // Not an ACP concept; an agent's skills are its own business.
  }

  async listAgents(): Promise<AgentInfo[]> {
    // ACP has no sub-agent catalog. Reporting the connected agent itself keeps
    // the UI's "which agent am I talking to" honest without inventing modes.
    return [{ name: this.agentInfo?.name ?? "acp", description: this.displayName }];
  }

  async listCommands(): Promise<CommandInfo[]> {
    // Filled from `available_commands_update`, which arrives unprompted right
    // after `session/new` (verified against codex-acp: plan, mcp, skills,
    // status, review, …).
    return this.commands;
  }

  // ---- model selection ----

  async getDefaultModel(): Promise<string | null> {
    for (const s of this.sessions.values()) if (s.currentModelId) return s.currentModelId;
    return null;
  }

  async setDefaultModel(_model: string): Promise<void> {
    throw new Error(
      `${this.displayName} owns its own model choice — ACP has no model-setting method (see docs/rfc/multi-agent-acp.md)`,
    );
  }

  // ---- agent-driven execution ----

  async runShell(_sessionId: string, _command: string, _agent?: string): Promise<void> {
    // Running a command OUTSIDE a turn has no ACP equivalent. The agent's own
    // shell tool still works — it just goes through a prompt.
    throw new Error(`${this.displayName} does not support running a shell command outside a turn`);
  }

  async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    // ACP's own commands are invoked as prompt text, which is how the agents
    // that advertise them expect it (`/review`, `/plan`).
    await this.sendPrompt(sessionId, args ? `/${command} ${args}` : `/${command}`);
  }

  // ---- interactive requests ----

  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    return []; // ACP has no "question" kind; everything is a permission request.
  }

  async listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]> {
    return [...this.permissions.values()]
      .map((p) => p.event)
      .filter((e) => !sessionId || e.sessionId === sessionId);
  }

  async answerQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    throw new Error(`${this.displayName} does not ask questions`);
  }

  async rejectQuestion(_requestId: string): Promise<void> {
    throw new Error(`${this.displayName} does not ask questions`);
  }

  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const entry = this.permissions.get(requestId);
    if (!entry) return; // already answered, or resolved by the agent giving up
    this.permissions.delete(requestId);
    const option = pickPermissionOption(entry.options, reply);
    // The reply IS the response to the agent's blocked request.
    entry.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.emit({ type: "permission.resolved", sessionId: entry.event.sessionId, requestId });
  }

  // ---- inbound ----

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const note = params as AcpSessionNotification;
    if (!note?.sessionId || !note.update) return;
    this.applyUpdate(note.sessionId, note.update);
  }

  private applyUpdate(sessionId: string, update: AcpSessionUpdate): void {
    const state = this.sessions.get(sessionId);
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const partId = update.messageId ?? `message@${state?.turn ?? 0}`;
        const text = accumulate(state?.text, partId, update.content?.text ?? "");
        this.emit({ type: "text.updated", sessionId, partId, text });
        return;
      }
      case "agent_thought_chunk": {
        const partId = update.messageId ?? `thought@${state?.turn ?? 0}`;
        const text = accumulate(state?.reasoning, partId, update.content?.text ?? "");
        this.emit({ type: "reasoning.updated", sessionId, partId, text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const call = update as unknown as AcpToolCallUpdate;
        if (!call.toolCallId) return;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId: call.toolCallId,
          tool: call.kind ?? call.title ?? "tool",
          status: mapToolStatus(call.status),
          title: call.title,
          input: call.rawInput,
          output: toolOutput(call),
        });
        return;
      }
      case "available_commands_update": {
        this.commands = (update.availableCommands ?? []).map((c: AcpCommand) => ({
          name: c.name,
          description: c.description,
          source: "command",
        }));
        return;
      }
      // Deliberately ignored: `plan` (no thread block for it yet),
      // `usage_update` and `session_info_update` (agent-specific bookkeeping),
      // `current_mode_update` (no ACP mode concept in our UI), and
      // `user_message_chunk` (the app already shows what the user sent).
      default:
        return;
    }
  }

  private onAgentRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (method !== "session/request_permission") {
      throw new Error(`unsupported: ${method}`);
    }
    const req = params as AcpPermissionRequest;
    const requestId = `acp-perm-${++this.permissionSeq}`;
    const event: PermissionAskedEvent = {
      type: "permission.asked",
      sessionId: req.sessionId,
      requestId,
      action: req.toolCall?.kind ?? req.toolCall?.title ?? "run",
      resources: permissionResources(req.toolCall),
    };
    return new Promise((resolve) => {
      this.permissions.set(requestId, { event, options: req.options, resolve });
      this.emit(event);
    });
  }
}

/** Append a delta and return the accumulated value. */
function accumulate(store: Map<string, string> | undefined, key: string, delta: string): string {
  if (!store) return delta;
  const next = (store.get(key) ?? "") + delta;
  store.set(key, next);
  return next;
}

/** ACP tool statuses → ours. ACP uses "pending" | "in_progress" | "completed" |
 *  "failed"; anything unknown is treated as still running, which is the safe
 *  reading (a tool that never reports completion must not look finished). */
export function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

/** The text an ACP tool call reported, flattened — its `content` is a list of
 *  blocks, each either a bare `text` or a nested content block. */
function toolOutput(call: AcpToolCallUpdate): string | undefined {
  const parts = (call.content ?? [])
    .map((c) => c.content?.text ?? c.text ?? "")
    .filter((t) => t.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** What the permission is ABOUT, for the approval dialog: the command line or
 *  file path the agent named, falling back to the tool's own title. */
function permissionResources(call?: AcpToolCallUpdate): string[] {
  if (!call) return [];
  const raw = call.rawInput ?? {};
  const named = ["command", "filePath", "file_path", "path", "abs_path"]
    .map((k) => raw[k])
    .find((v) => typeof v === "string" && v.length > 0);
  if (typeof named === "string") return [named];
  return call.title ? [call.title] : [];
}

/**
 * Our three-way reply → one of the agent's own option ids.
 *
 * ACP does not name its options: the agent sends a list and we must pick an
 * `optionId` from it, so the mapping goes through each option's `kind`
 * ("allow_once" | "allow_always" | "reject_once" | "reject_always"). Falling
 * back to position would be wrong in the one case that matters — picking
 * "always allow" when the user said "once".
 */
export function pickPermissionOption(
  options: AcpPermissionRequest["options"],
  reply: PermissionReply,
): string | undefined {
  const wanted =
    reply === "once" ? ["allow_once", "allow_always"] : reply === "always" ? ["allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const hit = (options ?? []).find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  // No option of the kind we need. Rejecting has a safe fallback — cancel, which
  // `replyPermission` sends when this returns undefined — but allowing does not,
  // so an unmatched allow must NOT silently become some other option.
  return undefined;
}
