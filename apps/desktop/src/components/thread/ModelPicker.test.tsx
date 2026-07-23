import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { ModelPicker } from "./ModelPicker";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5", name: "GPT-5", variants: ["low", "medium", "high"] },
      { id: "gpt-mini", name: "GPT-mini", variants: [] }, // no reasoning levels
    ],
  },
];

const renderPicker = () =>
  render(
    <MemoryRouter>
      <ModelPicker />
    </MemoryRouter>,
  );

const chip = () => screen.getByRole("button", { name: /switch model/i });

describe("ModelPicker", () => {
  const initial = useRuntimeStore.getState();
  let setDefaultModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    setDefaultModel = vi.fn().mockResolvedValue(undefined);
    useRuntimeStore.setState({
      providers,
      defaultModel: "openai/gpt-5",
      reasoningVariant: null,
      setDefaultModel,
      switching: false,
    });
  });
  afterEach(() => {
    useRuntimeStore.setState(initial, true);
  });

  it("labels the chip with the current model", () => {
    renderPicker();
    expect(chip()).toHaveTextContent("GPT-5");
  });

  it("opens and lists every model", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("GPT-5")).toBeInTheDocument();
    expect(within(dialog).getByText("GPT-mini")).toBeInTheDocument();
  });

  it("builds the reasoning control from the current model's variants and pins the choice", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByText(/reasoning effort/i)); // expand Advanced
    // Exactly the model's own levels — ordered — are offered.
    for (const level of ["Low", "Medium", "High"])
      expect(within(dialog).getByRole("button", { name: level })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "High" }));
    expect(useRuntimeStore.getState().reasoningVariant).toBe("high");
    expect(chip()).toHaveTextContent("High"); // effort surfaces on the chip
  });

  it("hides the reasoning control for a model with no levels", async () => {
    useRuntimeStore.setState({ defaultModel: "openai/gpt-mini" });
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    expect(within(screen.getByRole("dialog")).queryByText(/reasoning effort/i)).toBeNull();
  });

  it("switches the default model and closes for a model with no reasoning levels", async () => {
    const user = userEvent.setup();
    renderPicker(); // current model is gpt-5
    await user.click(chip());
    await user.click(within(screen.getByRole("dialog")).getByText("GPT-mini"));
    expect(setDefaultModel).toHaveBeenCalledWith("openai/gpt-mini");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays open after switching to a reasoning-capable model (so effort can be tuned)", async () => {
    useRuntimeStore.setState({ defaultModel: "openai/gpt-mini" });
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    await user.click(within(screen.getByRole("dialog")).getByText("GPT-5"));
    expect(setDefaultModel).toHaveBeenCalledWith("openai/gpt-5");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
