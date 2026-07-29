import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { leaves, makeLeaf, useLayoutStore } from "@/lib/layout";
import { renderAt } from "@/test/render";

// The route change is asserted through useNavigate: react-router's own
// navigation does not complete under this jsdom setup (its AbortController is
// rejected), so the spy is what proves the click asks for the session view.
const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

/** The user is reading session "A" in the only Screen. */
function busyScreen() {
  const leaf = makeLeaf("A");
  useLayoutStore.setState({
    groups: [{ id: "g0", name: "", tree: leaf, focusedLeafId: leaf.id, zoomedLeafId: null }],
    activeGroupId: "g0",
    tree: leaf,
    focusedLeafId: leaf.id,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
}

beforeEach(() => {
  navigateSpy.mockClear();
  busyScreen();
  useRuntimeStore.setState({
    sessions: [
      { id: "A", title: "current work", directory: "/base/2026-07-01-0900" },
      { id: "B", title: "older question", directory: "/base/2026-07-02-0900" },
    ],
    projects: [],
  });
});
afterEach(() => useRuntimeStore.setState({ sessions: [], projects: [], workspace: null }));

describe("Sidebar sessions, away from the session route", () => {
  it("clicking a session shows it instead of only rearranging panes", async () => {
    renderAt("/skills");
    await userEvent.click(await screen.findByText("older question"));

    // Used to change the layout and nothing else — from Skills/Runs/Files the
    // click looked dead because those routes render instead of the panes.
    expect(navigateSpy).toHaveBeenCalledWith("/live/B");
    const layout = useLayoutStore.getState();
    expect(leaves(layout.tree!).map((l) => l.sessionId)).toEqual(["B"]);
    // The pane the user was reading is untouched, in its own Screen.
    expect(leaves(layout.groups[0].tree!).map((l) => l.sessionId)).toEqual(["A"]);
  });

  it("New opens its own Screen instead of replacing the pane in use", async () => {
    renderAt("/skills");
    await userEvent.click(await screen.findByRole("button", { name: "New" }));

    expect(navigateSpy).toHaveBeenCalledWith("/live");
    const layout = useLayoutStore.getState();
    expect(layout.groups).toHaveLength(2);
    expect(layout.activeGroupId).not.toBe("g0");
    expect(leaves(layout.tree!).map((l) => l.sessionId)).toEqual([null]); // a draft
    expect(leaves(layout.groups[0].tree!).map((l) => l.sessionId)).toEqual(["A"]);
  });
});
