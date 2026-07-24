import { describe, it, expect } from "vitest";
import {
  makeLeaf,
  leaves,
  findLeaf,
  splitLeaf,
  closeLeaf,
  setRatio,
  setLeafSession,
  adjacentLeafId,
  RATIO_MIN,
  RATIO_MAX,
  type PaneNode,
} from "./layout";

describe("pane-tree ops", () => {
  it("splitLeaf turns a leaf into a split with the original + a new bound leaf", () => {
    const root = makeLeaf("A");
    const { tree, newLeafId } = splitLeaf(root, root.id, "row", "B");
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") throw new Error("expected split");
    expect(tree.dir).toBe("row");
    expect(tree.ratio).toBe(0.5);
    expect(tree.a).toEqual(root); // original stays on side a
    expect((tree.b as { sessionId: string }).sessionId).toBe("B");
    expect(newLeafId).toBe(tree.b.id);
    // Focus order is in-order: original then new.
    expect(leaves(tree).map((l) => l.sessionId)).toEqual(["A", "B"]);
  });

  it("splitLeaf on a non-existent leaf is a no-op", () => {
    const root = makeLeaf("A");
    const { tree, newLeafId } = splitLeaf(root, "nope", "row", "B");
    expect(tree).toBe(root);
    expect(newLeafId).toBe("nope");
  });

  it("nested splits keep a stable in-order leaf list", () => {
    let tree: PaneNode = makeLeaf("A");
    const s1 = splitLeaf(tree, tree.id, "row", "B");
    tree = s1.tree;
    // Split the new B pane vertically → C under it.
    const s2 = splitLeaf(tree, s1.newLeafId, "col", "C");
    tree = s2.tree;
    expect(leaves(tree).map((l) => l.sessionId)).toEqual(["A", "B", "C"]);
  });

  it("closeLeaf promotes the sibling and returns it as next focus", () => {
    const root = makeLeaf("A");
    const { tree, newLeafId } = splitLeaf(root, root.id, "row", "B");
    const res = closeLeaf(tree, newLeafId); // close B
    expect(res).not.toBeNull();
    expect(res!.tree).toEqual(root); // collapses back to the lone A leaf
    expect(res!.nextFocusId).toBe(root.id);
  });

  it("closeLeaf on a middle pane keeps the rest and focuses the surviving sibling", () => {
    let tree: PaneNode = makeLeaf("A");
    const s1 = splitLeaf(tree, tree.id, "row", "B");
    tree = s1.tree;
    const s2 = splitLeaf(tree, s1.newLeafId, "col", "C"); // B splits into B / C
    tree = s2.tree;
    const res = closeLeaf(tree, s1.newLeafId); // close B; C promoted
    expect(res).not.toBeNull();
    expect(leaves(res!.tree).map((l) => l.sessionId)).toEqual(["A", "C"]);
    expect(findLeaf(res!.tree, res!.nextFocusId)?.sessionId).toBe("C");
  });

  it("closeLeaf on the only pane returns null (can't close the last)", () => {
    const root = makeLeaf("A");
    expect(closeLeaf(root, root.id)).toBeNull();
  });

  it("setRatio clamps to [RATIO_MIN, RATIO_MAX]", () => {
    const root = makeLeaf("A");
    const { tree } = splitLeaf(root, root.id, "row", "B");
    const split = tree as Extract<PaneNode, { kind: "split" }>;
    expect((setRatio(tree, split.id, 0.99) as typeof split).ratio).toBe(RATIO_MAX);
    expect((setRatio(tree, split.id, 0.01) as typeof split).ratio).toBe(RATIO_MIN);
    expect((setRatio(tree, split.id, 0.42) as typeof split).ratio).toBeCloseTo(0.42);
  });

  it("setLeafSession rebinds one leaf without touching others", () => {
    const root = makeLeaf("A");
    const { tree, newLeafId } = splitLeaf(root, root.id, "row", "B");
    const next = setLeafSession(tree, root.id, "A2");
    expect(leaves(next).map((l) => l.sessionId)).toEqual(["A2", "B"]);
    expect(findLeaf(next, newLeafId)?.sessionId).toBe("B");
  });

  it("adjacentLeafId cycles focus in-order and wraps", () => {
    let tree: PaneNode = makeLeaf("A");
    const s1 = splitLeaf(tree, tree.id, "row", "B");
    tree = s1.tree;
    const s2 = splitLeaf(tree, s1.newLeafId, "row", "C");
    tree = s2.tree;
    const [a, b, c] = leaves(tree).map((l) => l.id);
    expect(adjacentLeafId(tree, a, "next")).toBe(b);
    expect(adjacentLeafId(tree, c, "next")).toBe(a); // wrap
    expect(adjacentLeafId(tree, a, "prev")).toBe(c); // wrap
    expect(adjacentLeafId(tree, b, "prev")).toBe(a);
  });
});
