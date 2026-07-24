import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  FlaskConical,
  FolderOpen,
  Loader2,
  NotebookPen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PlugZap,
  X,
} from "lucide-react";
import type { RuntimeStatus } from "@ai4s/shared";
import { DRAFT_KEY, rootSessionOf, useRuntimeStore } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";
import { startPaneDrag } from "@/lib/dragPane";
import { isGatewayWeb } from "@/lib/webMode";
import { useIsMobile } from "@/lib/useIsMobile";
import { queryRuns } from "@/lib/runs";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { useScrollMemory } from "@/lib/scrollMemory";
import { BlockList, type BlockHandlers } from "@/components/thread/BlockList";
import { Elapsed } from "@/components/thread/ToolGroup";
import { Composer } from "@/components/thread/Composer";
import { GOAL_RESUME_NUDGE, GoalPill } from "@/components/thread/GoalPill";
import { baseName } from "@/components/thread/WorkspaceChip";
import { WorkflowStarters } from "@/components/thread/WorkflowStarters";
import { InteractionPrompt } from "@/components/thread/InteractionPrompt";
import { InspectorShell } from "@/components/inspector/InspectorShell";
import { MaximizePaneButton, RightPane } from "@/components/inspector/RightPane";
import { SessionFilesPane } from "@/app/routes/FilesPage";
import { RunsPane } from "@/app/routes/RunsPage";
import { cn } from "@/lib/cn";

/**
 * One agent session — header + conversation + composer + optional right pane.
 * Bound to `sessionId` (null = the single draft pane), NOT the global
 * `currentId`, so any number of these tile side-by-side in the pane tree and
 * each streams and sends on its own. The focused-session lifecycle (openSession,
 * URL, reconcile) lives in the LiveSessionPage wrapper, not here.
 */
export function SessionView({
  sessionId,
  leafId,
  focused,
  /** The primary pane doubles as the macOS titlebar and hosts the sidebar
   *  expand button (only one pane may — otherwise every header clears the
   *  traffic lights). In single-pane mode this is always the one view. */
  chromeAsTitlebar = true,
  /** Per-pane content zoom (1 = 100%); scales the conversation + composer. */
  zoom = 1,
  /** The only pane in its group. A tiled (non-solo) pane is narrow, so the
   *  files/artifact inspector fills the pane instead of sitting in a side
   *  column, and header toggles show icon-only. */
  solo = true,
  /** Close this pane (shown as an ✕ in the header). Omitted for the sole pane
   *  and on web/mobile. */
  onClose,
}: {
  sessionId: string | null;
  leafId: string;
  focused: boolean;
  chromeAsTitlebar?: boolean;
  zoom?: number;
  solo?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  // `sid` is what this pane WRITES to (null = draft → create on first send).
  // `eid` is what it DISPLAYS: a real pane is its own session, but the focused
  // draft follows `currentId` so a first send's draft→session graft (which moves
  // the thread off DRAFT_KEY and sets currentId) never blanks the pane. `key`
  // addresses the per-session maps (threads/panes/agents), DRAFT_KEY on a draft.
  const sid = sessionId;
  const currentId = useRuntimeStore((s) => s.currentId);
  const eid = sid ?? (focused ? currentId : null);
  const key = eid ?? DRAFT_KEY;

  // Per-field selection (never a bare useRuntimeStore()): a background session's
  // SSE folds must not repaint this pane. The active thread is selected on its
  // own below (#34).
  const status = useRuntimeStore((s) => s.status);
  const switching = useRuntimeStore((s) => s.switching);
  const webReadOnly = useRuntimeStore((s) => s.webReadOnly);
  const sendingSessions = useRuntimeStore((s) => s.sendingSessions);
  const runningSessions = useRuntimeStore((s) => s.runningSessions);
  const stepCounts = useRuntimeStore((s) => s.stepCounts);
  const retryNotices = useRuntimeStore((s) => s.retryNotices);
  const serverUrl = useRuntimeStore((s) => s.serverUrl);
  const sessions = useRuntimeStore((s) => s.sessions);
  const error = useRuntimeStore((s) => s.error);
  const questions = useRuntimeStore((s) => s.questions);
  const permissions = useRuntimeStore((s) => s.permissions);
  const sessionParents = useRuntimeStore((s) => s.sessionParents);
  const workspace = useRuntimeStore((s) => s.workspace);
  const panes = useRuntimeStore((s) => s.panes);
  const commands = useRuntimeStore((s) => s.commands);
  const connect = useRuntimeStore((s) => s.connect);
  const sendPrompt = useRuntimeStore((s) => s.sendPrompt);
  const runShell = useRuntimeStore((s) => s.runShell);
  const runCommand = useRuntimeStore((s) => s.runCommand);
  const openArtifact = useRuntimeStore((s) => s.openArtifact);
  const closeArtifact = useRuntimeStore((s) => s.closeArtifact);
  const setShowFiles = useRuntimeStore((s) => s.setShowFiles);
  const setShowRuns = useRuntimeStore((s) => s.setShowRuns);
  const answerQuestion = useRuntimeStore((s) => s.answerQuestion);
  const rejectQuestion = useRuntimeStore((s) => s.rejectQuestion);
  const replyPermission = useRuntimeStore((s) => s.replyPermission);
  const interrupt = useRuntimeStore((s) => s.interrupt);
  const editMessage = useRuntimeStore((s) => s.editMessage);
  const revertMessage = useRuntimeStore((s) => s.revertMessage);
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);
  const approvalMode = useRuntimeStore((s) => s.approvalMode);
  const setApprovalMode = useRuntimeStore((s) => s.setApprovalMode);
  const agents = useRuntimeStore((s) => s.agents);
  const sessionAgents = useRuntimeStore((s) => s.sessionAgents);
  const setAgentMode = useRuntimeStore((s) => s.setAgentMode);
  const bindSession = useLayoutStore((s) => s.bindSession);
  const dockSession = useLayoutStore((s) => s.dockSession);
  const setLeafZoom = useLayoutStore((s) => s.setLeafZoom);
  const newTiledSession = useRuntimeStore((s) => s.newTiledSession);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // Split buttons/drag only make sense where tiling works (desktop, not web).
  const canSplit = !isGatewayWeb && !isMobile;

  const connected = status === "ready" || switching;
  const connecting = status === "connecting" && !switching;
  const displayStatus = switching ? "ready" : status;

  // A newly-created session (draft's first send) binds onto this leaf; the
  // wrapper then follows it into the URL and opens its folder.
  const bindIfCreated = (created: string | null) => {
    if (created && sid === null) bindSession(leafId, created);
  };
  // Split THIS pane: create a fresh session in the same folder and dock it to
  // the given edge (the visible, no-shortcut-needed entry to tiling).
  const onSplit = async (edge: "right" | "bottom") => {
    const id = await newTiledSession();
    if (id) dockSession(leafId, edge, id);
  };
  const onSend = async (text: string) => bindIfCreated(await sendPrompt(text, sid ?? undefined));
  const onRunShell = async (command: string) =>
    bindIfCreated(await runShell(command, sid ?? undefined));
  const onRunCommand = async (name: string, args: string) => {
    const localClear = name === "new" || name === "clear";
    const created = await runCommand(name, args, sid ?? undefined);
    if (localClear) {
      // /new and /clear reset this pane to a fresh draft in the same folder.
      // focus→URL never navigates to bare "/live", so do it here (the draft
      // has no session id for the URL to reflect).
      bindSession(leafId, null);
      if (focused) navigate("/live");
    } else bindIfCreated(created);
  };
  const composerCommands = useMemo(() => {
    const local = [
      { name: "new", description: t("localCommand.newDescription"), source: "local" },
      { name: "clear", description: t("localCommand.clearDescription"), source: "local" },
    ];
    const localNames = new Set(local.map((c) => c.name));
    return [...local, ...commands.filter((c) => !localNames.has(c.name))];
  }, [commands, t]);

  const handlers: BlockHandlers = useMemo(
    () => ({
      onArtifactOpen: (a) => openArtifact(a, sid ?? undefined),
      onFigureComment: (a, title) =>
        void sendPrompt(
          `On the figure ${title}, at (${a.x.toFixed(0)}%, ${a.y.toFixed(0)}%): ${a.note}`,
          sid ?? undefined,
        ),
      onEditMessage: (id, text) => editMessage(id, text, sid ?? undefined),
      onRevertMessage: async (id, text) => {
        if (await revertMessage(id, sid ?? undefined)) setComposerDraft(text);
      },
    }),
    [openArtifact, sendPrompt, editMessage, revertMessage, setComposerDraft, sid],
  );
  const onEvaluate = (expr: string) =>
    void sendPrompt(`Evaluate in the notebook kernel:\n\`\`\`python\n${expr}\n\`\`\``, sid ?? undefined);

  // This session's thread, selected on its own so only its own folds repaint.
  const thread = useRuntimeStore((s) => s.threads[key]);
  const historyLoading = connected && !!eid && !thread?.loaded;
  const title = sessions.find((s) => s.id === eid)?.title;
  const isEmpty = !thread || thread.blocks.length === 0;
  const sending = !!sendingSessions[key];
  const running = !!(eid && runningSessions[eid]);
  const working = sending || running;
  const retryNotice = eid ? retryNotices[eid] : undefined;
  const step = eid ? (stepCounts[eid] ?? 0) : 0;
  const currentTool = working
    ? [...(thread?.blocks ?? [])]
        .reverse()
        .find(
          (b): b is Extract<typeof b, { kind: "tool-call" }> =>
            b.kind === "tool-call" && b.status === "running",
        )
    : undefined;
  const lastBlock = thread?.blocks[thread.blocks.length - 1];
  const liveReasoningIndex =
    running && thread && lastBlock?.kind === "reasoning" ? thread.blocks.length - 1 : undefined;

  // Esc interrupts the running turn — but only in the FOCUSED pane, so a split
  // layout doesn't broadcast one Esc to every running session.
  useEffect(() => {
    if (!running || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      void interrupt(sid ?? undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, focused, interrupt, sid]);

  // The oldest unanswered request for THIS session (subagent asks resolve
  // through the parent chain to their root session).
  const belongsHere = (s: string) => !!eid && (s === eid || rootSessionOf(sessionParents, s) === eid);
  const activeQuestion = questions.find((q) => belongsHere(q.sessionId));
  const activePermission = permissions.find((p) => belongsHere(p.sessionId));
  const activeRequest = activeQuestion ?? activePermission;
  const requestOrigin =
    activeRequest && activeRequest.sessionId !== eid
      ? (sessions.find((s) => s.id === activeRequest.sessionId)?.title ?? t("live.subagentFallback"))
      : undefined;

  const sessionNotebooks = (thread?.blocks ?? []).filter(
    (b): b is Extract<typeof b, { kind: "artifact" }> =>
      b.kind === "artifact" && b.filename.endsWith(".ipynb"),
  );
  const uniqueNotebooks = [...new Map(sessionNotebooks.map((b) => [b.path, b])).values()];

  const pane = panes[key];
  const planAvailable = agents.some((a) => a.name === "plan");
  const agentMode = sessionAgents[key] ?? "build";
  const activeArtifact = pane?.artifact ?? null;
  const showFiles = !activeArtifact && !!pane?.showFiles;
  const showRuns = !activeArtifact && !showFiles && !!pane?.showRuns;
  const inspectorActive = !!activeArtifact || showFiles || showRuns;
  // A tiled (non-solo) pane is narrow: fill it with the inspector rather than a
  // side column that would squeeze the chat or overflow the pane.
  const inspectorFillsPane = inspectorActive && !solo;
  // The folder shown in the Files toggle: this session's own directory (falling
  // back to the active workspace on a draft that has none yet).
  const sessionDir = sessions.find((s) => s.id === eid)?.directory ?? workspace;

  const [hasRuns, setHasRuns] = useState(false);
  useEffect(() => {
    if (!eid) return setHasRuns(false);
    let cancelled = false;
    void queryRuns({ sessionId: eid, limit: 1 }).then((p) => !cancelled && setHasRuns(p.total > 0));
    return () => {
      cancelled = true;
    };
  }, [eid]);

  const chatRef = useRef<HTMLDivElement>(null);
  const onChatScroll = useScrollMemory(chatRef, `chat:${key}`, !historyLoading);

  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    const agentNb = uniqueNotebooks.find(
      (b) => b.tool.toLowerCase().includes("jupyter") && !autoOpened.current.has(b.path),
    );
    if (agentNb) {
      autoOpened.current.add(agentNb.path);
      openArtifact(agentNb, sid ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueNotebooks.length]);

  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const isMac = navigator.userAgent.includes("Mac");
  const overlayTitlebar = useOverlayTitlebar();
  // Only the primary pane clears the traffic lights / hosts the expand button.
  const asTitlebar = chromeAsTitlebar && overlayTitlebar;
  const showSidebarExpand = chromeAsTitlebar && sidebarCollapsed;

  // The files/artifact/runs inspector content — reused whether it fills a tiled
  // pane or sits in the solo pane's resizable side column.
  const inspectorNode = activeArtifact ? (
    <InspectorShell
      inspector={fileInspectorFromBlock(activeArtifact)}
      onClose={() => closeArtifact(sid ?? undefined)}
      onEvaluate={onEvaluate}
      controls={<MaximizePaneButton />}
    />
  ) : showRuns ? (
    <RunsPane sessionId={eid!} onClose={() => setShowRuns(false, sid ?? undefined)} controls={<MaximizePaneButton />} />
  ) : showFiles ? (
    <SessionFilesPane onClose={() => setShowFiles(false, sid ?? undefined)} controls={<MaximizePaneButton />} />
  ) : null;

  return (
    <div className="flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div
          data-tauri-drag-region={asTitlebar || undefined}
          style={sidebarCollapsed && asTitlebar ? overlayTitlebarStyle(true) : undefined}
          className={cn(
            "flex shrink-0 items-center border-faint",
            // Tiled panes get a compact header — h-12 wastes vertical space in
            // a small pane. Solo/web keeps the full-height titlebar row.
            solo ? "gap-2 px-6" : "gap-1 px-2.5",
            eid && "border-b",
            !(sidebarCollapsed && asTitlebar) && (solo ? "h-12" : "h-8"),
          )}
        >
          {showSidebarExpand && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              aria-label={t("live.header.expandSidebarAria")}
              title={t("live.header.expandSidebarTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
              className="fade-in rounded p-1 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          )}
          {eid && (
            // The title doubles as a drag handle to re-dock this pane. Opt it
            // out of the macOS window-drag region so grabbing it moves the pane,
            // not the window.
            <h1
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              // eslint-disable-next-line i18next/no-literal-string -- DragSource kind, not UI copy
              onPointerDown={(e) => startPaneDrag(e, { kind: "pane", leafId, sessionId: eid }, title ?? "")}
              // `select-none` stops the title text from being selected while
              // dragging (the reason a header drag looked like a text selection).
              className="min-w-0 shrink cursor-grab select-none truncate text-[13px] font-medium text-text active:cursor-grabbing"
            >
              {title ?? ""}
            </h1>
          )}
          {eid && (
            <GoalPill sessionId={eid} onResumed={() => void sendPrompt(GOAL_RESUME_NUDGE, sid ?? undefined)} />
          )}
          <div data-tauri-drag-region={asTitlebar || undefined} className="flex-1" />
          {eid && (
            <button
              onClick={() => setShowFiles(!showFiles, sid ?? undefined)}
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-surface-2",
                showFiles ? "bg-surface-2 text-text" : "text-muted",
              )}
              title={`${t("live.filesToggle.title")}${sessionDir ? ` — ${sessionDir}` : ""}`}
              aria-pressed={showFiles}
            >
              <FolderOpen size={13} />
              {/* Tiled panes are narrow — show just the icon, not the folder name. */}
              {solo && (
                <span className="max-w-[160px] truncate">
                  {sessionDir ? baseName(sessionDir) : t("live.filesToggle.default")}
                </span>
              )}
            </button>
          )}
          {eid && hasRuns && (
            <button
              onClick={() => setShowRuns(!showRuns, sid ?? undefined)}
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-surface-2",
                showRuns ? "bg-surface-2 text-text" : "text-muted",
              )}
              title={t("live.runsToggle.title")}
              aria-pressed={showRuns}
            >
              <FlaskConical size={13} />
              {solo && <span>{t("live.runsToggle.label")}</span>}
            </button>
          )}
          {/* Split this pane — the visible, discoverable way to tile (no
              keyboard shortcut needed). Right = side-by-side, down = stacked. */}
          {canSplit && (
            <>
              <ZoomMenu zoom={zoom} onPick={(z) => setLeafZoom(leafId, z)} />
              <button
                onClick={() => void onSplit("right")}
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                title={t("group.splitRight")}
                aria-label={t("group.splitRight")}
              >
                <PanelRight size={13} strokeWidth={1.5} />
              </button>
              <button
                onClick={() => void onSplit("bottom")}
                className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                title={t("group.splitDown")}
                aria-label={t("group.splitDown")}
              >
                <PanelBottom size={13} strokeWidth={1.5} />
              </button>
              {onClose && (
                <button
                  onClick={onClose}
                  className="rounded-md p-1 text-muted transition-colors hover:bg-border hover:text-error"
                  title={t("group.closePane")}
                  aria-label={t("group.closePane")}
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              )}
            </>
          )}
          {/* The green "ready" dot is noise per pane — only surface trouble. */}
          {displayStatus !== "ready" && <ConnBadge status={displayStatus} />}
          {uniqueNotebooks.map((nb) => (
            <button
              key={nb.path}
              onClick={() => openArtifact(nb, sid ?? undefined)}
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-xs transition-colors hover:bg-surface-2",
                activeArtifact?.path === nb.path ? "bg-surface-2 text-text" : "text-muted",
              )}
              title={t("live.notebook.openTitle", { path: nb.path })}
            >
              <NotebookPen size={12} />
              <span className="max-w-[180px] truncate">{nb.filename}</span>
            </button>
          ))}
          {!connected && (
            <button
              onClick={connect}
              disabled={connecting}
              className="flex items-center gap-1.5 rounded-input bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              {t("live.connect")}
            </button>
          )}
        </div>

        {inspectorFillsPane ? (
          // Tiled pane: the inspector fills the pane (chat/composer hidden), so a
          // narrow pane isn't squeezed and nothing overflows. Its own header's
          // close (and the pressed folder/runs toggle) returns to the chat.
          <div className="min-h-0 flex-1 overflow-hidden">{inspectorNode}</div>
        ) : (
          <>
        <div
          ref={chatRef}
          onScroll={onChatScroll}
          style={zoom !== 1 ? { zoom } : undefined}
          className="flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-6">
            {!connected && !connecting && (
              <div className="rounded-card border border-border bg-surface p-5 shadow-card">
                <div className="text-sm font-medium text-text">{t("live.runtime.title")}</div>
                <p className="mt-1 text-sm text-muted">
                  {t("live.runtime.bodyPrefix")}{" "}
                  {/* eslint-disable-next-line i18next/no-literal-string -- literal shell command, not prose */}
                  <span className="font-mono">opencode serve</span>
                  {t("live.runtime.bodySuffix")}
                </p>
                <div className="mt-3 rounded-input bg-surface-2 px-3 py-2 font-mono text-xs text-text">
                  {serverUrl}
                </div>
              </div>
            )}
            {error && focused && (
              <div className="rounded-input border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}
            {connected && isEmpty && !eid && !webReadOnly && (
              <WorkflowStarters onPick={(p) => void onSend(p)} />
            )}
            {historyLoading && <ThreadSkeleton />}
            {!historyLoading && thread && (
              <BlockList
                blocks={thread.blocks}
                handlers={handlers}
                liveReasoningIndex={liveReasoningIndex}
              />
            )}
            {working && (
              <div className="flex min-w-0 items-center gap-2 text-sm text-muted">
                <Loader2 size={14} className="shrink-0 animate-spin" />
                <span className="shrink-0">
                  {activeRequest
                    ? t("live.status.paused")
                    : retryNotice
                      ? t("live.status.retrying", { attempt: Math.max(1, retryNotice.attempt) })
                      : sending && !eid
                        ? t("live.status.startingSession")
                        : t("live.status.working")}
                </span>
                {!activeRequest && !retryNotice && step >= 2 && (
                  <span className="shrink-0 text-xs text-muted/70">
                    {t("live.status.step", { count: step })}
                  </span>
                )}
                {!activeRequest && retryNotice && (
                  <span className="truncate font-mono text-xs text-warn" title={retryNotice.message}>
                    {retryNotice.message}
                  </span>
                )}
                {!activeRequest && !retryNotice && currentTool && (
                  <>
                    <span
                      className="truncate font-mono text-xs"
                      title={currentTool.command ?? currentTool.title}
                    >
                      {currentTool.title}
                    </span>
                    {currentTool.startedAt !== undefined && <Elapsed start={currentTool.startedAt} />}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* `pointer-events-none` on the gutter + `-auto` on the input so the
            empty area beside the composer never blocks the conversation behind
            it. Tiled panes use tighter padding and the full width. */}
        <div
          style={zoom !== 1 ? { zoom } : undefined}
          className={cn("pointer-events-none", solo ? "px-8 pb-5 pt-2" : "px-2.5 pb-2.5 pt-1")}
        >
          {/* Centered + capped so the input never spans edge-to-edge — full
              width looked cramped in a tiled pane, especially when zoomed. */}
          <div className={cn("pointer-events-auto mx-auto space-y-3", solo ? "max-w-[760px]" : "max-w-[560px]")}>
            {activeRequest && (
              <InteractionPrompt
                question={activeQuestion}
                permission={activeQuestion ? undefined : activePermission}
                origin={requestOrigin}
                onAnswer={(id, answers) => void answerQuestion(id, answers)}
                onReject={(id) => void rejectQuestion(id)}
                onPermission={(id, reply) => void replyPermission(id, reply)}
              />
            )}
            <Composer
              onSend={onSend}
              onRunShell={(c) => void onRunShell(c)}
              onRunCommand={(n, a) => void onRunCommand(n, a)}
              commands={composerCommands}
              disabled={!connected || working || webReadOnly}
              working={running}
              onStop={() => void interrupt(sid ?? undefined)}
              placeholder={
                webReadOnly
                  ? t("live.placeholder.readOnly")
                  : working
                    ? t("live.placeholder.waiting")
                    : !connected
                      ? t("live.placeholder.disconnected")
                      : planAvailable && agentMode === "plan"
                        ? t("composer.placeholder.plan")
                        : t("composer.placeholder.default")
              }
              approvalMode={approvalMode}
              onApprovalModeChange={(mode) => void setApprovalMode(mode)}
              agentMode={planAvailable ? agentMode : undefined}
              onAgentModeChange={planAvailable ? (mode) => setAgentMode(mode, sid ?? undefined) : undefined}
              showModelPicker={connected && !webReadOnly}
              modelSessionId={key}
              showWorkspaceChip={eid === null}
            />
          </div>
        </div>
          </>
        )}
      </div>

      {/* Solo pane (or web/mobile): the inspector is a resizable side column.
          Tiled panes fill instead (handled above). */}
      {inspectorActive && solo && (
        <RightPane
          onClose={
            activeArtifact
              ? () => closeArtifact(sid ?? undefined)
              : showRuns
                ? () => setShowRuns(false, sid ?? undefined)
                : () => setShowFiles(false, sid ?? undefined)
          }
        >
          {inspectorNode}
        </RightPane>
      )}
    </div>
  );
}

/** Per-pane zoom control: a compact "NN%" button opening preset levels. Lets a
 *  narrow tiled pane shrink its content so the text isn't oversized. */
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5];
function ZoomMenu({ zoom, onPick }: { zoom: number; onPick: (z: number) => void }) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-1 py-1 text-xs tabular-nums text-muted transition-colors hover:bg-surface-2 hover:text-text"
        title={t("group.zoom")}
        aria-label={t("group.zoom")}
      >
        {Math.round(zoom * 100)}%
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 flex flex-col rounded-md border border-border bg-surface p-1 shadow-card">
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z}
              onClick={() => {
                onPick(z);
                setOpen(false);
              }}
              className={cn(
                "rounded px-3 py-1 text-left text-xs tabular-nums hover:bg-surface-2",
                z === zoom ? "text-text" : "text-muted",
              )}
            >
              {Math.round(z * 100)}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Loading placeholder mirroring the thread's real shapes. */
function ThreadSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden>
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-11/12 rounded bg-surface-2" />
        <div className="h-3.5 w-4/5 rounded bg-surface-2" />
        <div className="h-3.5 w-2/3 rounded bg-surface-2" />
      </div>
      <div className="ml-2 h-4 w-2/5 rounded bg-surface-2 opacity-60" />
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-5/6 rounded bg-surface-2" />
        <div className="h-3.5 w-3/5 rounded bg-surface-2" />
      </div>
    </div>
  );
}

function ConnBadge({ status }: { status: RuntimeStatus }) {
  const { t } = useTranslation(["session", "common"]);
  const tone = status === "ready" ? "text-ok" : status === "error" ? "text-error" : "text-muted";
  return (
    <span
      className={cn("flex items-center gap-1.5 text-xs", tone)}
      title={t("live.connBadge.title", { status: t(`live.connBadge.status.${status}`) })}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "ready" ? "bg-ok" : status === "error" ? "bg-error" : "bg-muted",
          status === "connecting" && "animate-pulse",
        )}
      />
      {status !== "ready" && t("live.connBadge.title", { status: t(`live.connBadge.status.${status}`) })}
    </span>
  );
}
