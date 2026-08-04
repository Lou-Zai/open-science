import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { AgentModelsCard } from "./AgentModelsCard";

const models = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const variants = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const setAgentModel = vi.hoisted(() => vi.fn(async () => {}));
const setAgentVariant = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/tauri", () => ({
  getAgentModels: async () => models.current,
  getAgentVariants: async () => variants.current,
  setAgentModel,
  setAgentVariant,
}));

// One reasoning model with its own effort vocabulary, one without any levels.
const providers: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "opus", name: "Opus", variants: ["low", "high"] },
      { id: "haiku", name: "Haiku" },
    ],
  },
];

beforeEach(() => {
  models.current = {};
  variants.current = {};
  setAgentModel.mockClear();
  setAgentVariant.mockClear();
  useRuntimeStore.setState({
    agents: [{ name: "reviewer", mode: "subagent" }],
    defaultModel: "anthropic/opus",
    connectRetry: async () => {},
  } as never);
});

describe("AgentModelsCard", () => {
  it("offers the effective model's effort levels and none for a model without any", async () => {
    const first = render(<AgentModelsCard providers={providers} />);
    const effort = await screen.findByLabelText("Reasoning effort for reviewer");
    expect([...effort.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Default effort",
      "Low",
      "High",
    ]);
    first.unmount();

    // Pinned to a model with no reasoning levels: there is nothing to choose,
    // so the control is not rendered at all.
    models.current = { reviewer: "anthropic/haiku" };
    render(<AgentModelsCard providers={providers} />);
    await screen.findByLabelText("Model for reviewer");
    await waitFor(() =>
      expect(screen.queryByLabelText("Reasoning effort for reviewer")).toBeNull(),
    );
  });

  it("clears a pinned effort the newly chosen model cannot honour", async () => {
    variants.current = { reviewer: "high" };
    render(<AgentModelsCard providers={providers} />);
    const model = await screen.findByLabelText("Model for reviewer");
    await waitFor(() =>
      expect((screen.getByLabelText("Reasoning effort for reviewer") as HTMLSelectElement).value).toBe(
        "high",
      ),
    );

    // "haiku" has no levels at all, so "high" cannot be sent — it is dropped
    // rather than left as a setting the runtime would reject.
    await userEvent.selectOptions(model, "anthropic/haiku");
    await waitFor(() => expect(setAgentVariant).toHaveBeenCalledWith("reviewer", ""));
    expect(setAgentModel).toHaveBeenCalledWith("reviewer", "anthropic/haiku");
  });

  it("keeps a pinned effort the new model still offers", async () => {
    variants.current = { reviewer: "low" };
    const withBoth: ProviderInfo[] = [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          { id: "opus", name: "Opus", variants: ["low", "high"] },
          { id: "sonnet", name: "Sonnet", variants: ["low", "medium"] },
        ],
      },
    ];
    render(<AgentModelsCard providers={withBoth} />);
    const model = await screen.findByLabelText("Model for reviewer");
    await userEvent.selectOptions(model, "anthropic/sonnet");
    await waitFor(() => expect(setAgentModel).toHaveBeenCalledWith("reviewer", "anthropic/sonnet"));
    expect(setAgentVariant).not.toHaveBeenCalled();
  });
});
