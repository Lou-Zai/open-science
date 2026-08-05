// AcpRuntime against a REAL ACP agent, through the real spawning transport.
//
// Skipped unless `ACP_TEST_COMMAND` names an agent binary, exactly like the
// remote-ssh test that needs a host you can already log in to: it spawns a
// process and spends the agent's own model quota, so it must never run in the
// default suite. The fake-agent tests next door prove the mapping against wire
// shapes I wrote; this proves it against an agent nobody here controls.
//
//   ACP_TEST_COMMAND=/path/to/codex-acp pnpm --filter @ai4s/desktop test -- src/test/acp-real-agent.node.test.ts
//
// Verified 2026-08-05 against `@agentclientprotocol/codex-acp` 1.1.9.
// `gemini --acp` 0.33.1 reaches `initialize` but its `session/new` is refused
// for personal Google accounts ("migrate to the Antigravity suite"), and
// `@zed-industries/claude-code-acp` 0.16.2 refuses to start inside another
// Claude Code session — both are environment limits, not protocol ones.
import { describe, expect, it } from "vitest";


import { AcpRuntime } from "@ai4s/sdk/acp";
import type { OpenCodeEvent } from "@ai4s/sdk/acp";
import { stdioTransport } from "@ai4s/sdk/acp/stdio";

/** Last element. `Array.prototype.at` is outside this tsconfig's lib target. */
function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

const COMMAND = process.env.ACP_TEST_COMMAND;

describe.skipIf(!COMMAND)("AcpRuntime against a real ACP agent", () => {
  it(
    "completes one turn: initialize → session/new → streamed answer → idle",
    async () => {
      const events: OpenCodeEvent[] = [];
      const runtime = new AcpRuntime({
        transport: stdioTransport({ command: COMMAND!, cwd: process.cwd() }),
        cwd: process.cwd(),
      });
      runtime.onEvent((e) => events.push(e));

      await runtime.connect();
      expect(runtime.getStatus()).toBe("ready");
      // Whatever it calls itself — proves `initialize` really answered.
      expect(runtime.displayName.length).toBeGreaterThan(0);

      const sessionId = await runtime.createSession("real-agent check");
      expect(sessionId).toMatch(/\S/);

      await runtime.sendPrompt(sessionId, "Reply with exactly: ok");

      // The turn ended, and it ended by completing rather than erroring.
      expect(last(events)).toEqual({ type: "session.idle", sessionId });
      expect(events.filter((e) => e.type === "error")).toEqual([]);

      // The answer arrived as deltas and was accumulated: the last text.updated
      // holds the whole reply, not the final fragment.
      const texts = events.filter((e) => e.type === "text.updated") as Array<{ text: string; partId: string }>;
      if (process.env.ACP_TEST_DEBUG)
        console.log(texts.map((t) => `${t.partId}: ${JSON.stringify(t.text)}`).join("\n"));
      expect(texts.length).toBeGreaterThan(0);
      expect(last(texts)!.text.toLowerCase()).toContain("ok");
      // Monotonic growth WITHIN a part is the property that distinguishes
      // accumulation from passing the raw delta through. Per part, not across:
      // one real turn carries several — codex-acp precedes the answer with an
      // id-less notice, which is its own block.
      const byPart = new Map<string, string[]>();
      for (const t of texts) byPart.set(t.partId, [...(byPart.get(t.partId) ?? []), t.text]);
      for (const [partId, seq] of byPart) {
        for (let i = 1; i < seq.length; i++) {
          expect(seq[i]!.startsWith(seq[i - 1]!), `part ${partId} grew non-monotonically`).toBe(true);
        }
      }

      runtime.close();
      expect(runtime.getStatus()).toBe("offline");
    },
    180_000,
  );
});
