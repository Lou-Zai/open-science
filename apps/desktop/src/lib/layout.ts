import { create } from "zustand";

/**
 * Ghostty/tmux-style recursive split layout. Each leaf holds one session; a
 * split node divides its area between two children along an axis at a ratio.
 *
 * Draft rule: the runtime has a single global draft slot (DRAFT_KEY), so at
 * most ONE leaf may be an unbound draft (`sessionId: null`). `split()` always
 * binds a real, caller-supplied session to the NEW leaf — only the initial
 * single pane is ever a draft.
 */
export type SplitDir = "row" | "col";

export interface PaneLeaf {
  kind: "leaf";
  id: string;
  /** The bound session, or null for the (at most one) draft pane. */
  sessionId: string | null;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  /** "row" = children sit side-by-side (a | b); "col" = stacked (a / b). */
  dir: SplitDir;
  /** Fraction of the axis given to child `a`, clamped to [RATIO_MIN, RATIO_MAX]. */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export const RATIO_MIN = 0.15;
export const RATIO_MAX = 0.85;

let nodeSeq = 0;
const genId = (): string => `p${++nodeSeq}`;

export function makeLeaf(sessionId: string | null): PaneLeaf {
  return { kind: "leaf", id: genId(), sessionId };
}

const clampRatio = (r: number): number => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

/** All leaves, left-to-right / top-to-bottom (in-order) — the focus-cycle order. */
export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.a), ...leaves(node.b)];
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  return leaves(node).find((l) => l.id === id) ?? null;
}

function mapNode(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  const mapped = node.kind === "split" ? { ...node, a: mapNode(node.a, fn), b: mapNode(node.b, fn) } : node;
  return fn(mapped);
}

/** Replace the leaf `targetId` with `replacement` anywhere in the tree. */
function replaceLeaf(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  return mapNode(node, (n) => (n.kind === "leaf" && n.id === targetId ? replacement : n));
}

/**
 * Split the leaf `targetId` along `dir`, putting a new leaf (bound to
 * `sessionId`) after the existing one. Returns the new tree and the new leaf's
 * id (so the caller can focus it).
 */
export function splitLeaf(
  tree: PaneNode,
  targetId: string,
  dir: SplitDir,
  sessionId: string,
): { tree: PaneNode; newLeafId: string } {
  const target = findLeaf(tree, targetId);
  if (!target) return { tree, newLeafId: targetId };
  const newLeaf = makeLeaf(sessionId);
  const split: PaneSplit = { kind: "split", id: genId(), dir, ratio: 0.5, a: target, b: newLeaf };
  return { tree: replaceLeaf(tree, targetId, split), newLeafId: newLeaf.id };
}

/**
 * Remove the leaf `targetId`, promoting its sibling into the parent's place.
 * Returns null when it is the only leaf (the last pane can't be closed).
 * `nextFocusId` is the first leaf of the promoted sibling.
 */
export function closeLeaf(
  tree: PaneNode,
  targetId: string,
): { tree: PaneNode; nextFocusId: string } | null {
  if (tree.kind === "leaf") return null;
  let sibling: PaneNode | null = null;

  function walk(node: PaneNode): PaneNode | null {
    if (node.kind === "leaf") return null;
    if (node.a.kind === "leaf" && node.a.id === targetId) {
      sibling = node.b;
      return node.b;
    }
    if (node.b.kind === "leaf" && node.b.id === targetId) {
      sibling = node.a;
      return node.a;
    }
    const a = walk(node.a);
    if (a) return { ...node, a };
    const b = walk(node.b);
    if (b) return { ...node, b };
    return null;
  }

  const next = walk(tree);
  if (!next || !sibling) return null;
  // Focus the promoted sibling's first leaf — the pane that visually takes over
  // the closed one's space.
  return { tree: next, nextFocusId: leaves(sibling)[0].id };
}

export function setRatio(tree: PaneNode, splitId: string, ratio: number): PaneNode {
  return mapNode(tree, (n) =>
    n.kind === "split" && n.id === splitId ? { ...n, ratio: clampRatio(ratio) } : n,
  );
}

export function setLeafSession(tree: PaneNode, leafId: string, sessionId: string | null): PaneNode {
  return mapNode(tree, (n) => (n.kind === "leaf" && n.id === leafId ? { ...n, sessionId } : n));
}

/** The leaf adjacent to `id` in focus-cycle order (wraps around). */
export function adjacentLeafId(tree: PaneNode, id: string, dir: "next" | "prev"): string {
  const order = leaves(tree);
  const i = order.findIndex((l) => l.id === id);
  if (i < 0) return order[0]?.id ?? id;
  const j = dir === "next" ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
  return order[j].id;
}

// ---- Store ----

// The tree is in-memory only (v1): each launch starts as a single pane, exactly
// like the pre-split app. Persisting a tiled layout across full reloads collides
// with URL deep-links and sessions deleted between runs — deferred until the
// reconciliation story is worth the surface.

/** The session id in a deep-linked/reloaded `/live/:id` URL, so the initial
 *  pane is already bound to it — no null-focus transient for the URL↔focus sync
 *  to clobber (which, under StrictMode's double-invoked effects, would loop). */
function initialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/\/live\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

interface LayoutState {
  tree: PaneNode;
  focusedLeafId: string;
  /** A transiently maximized leaf (Cmd+Shift+Enter); not persisted. */
  zoomedLeafId: string | null;
  /** Split the focused leaf, binding `sessionId` to the new pane; focuses it. */
  split: (dir: SplitDir, sessionId: string) => void;
  /** Close the focused leaf (no-op on the last pane). */
  closeFocused: () => void;
  closePane: (leafId: string) => void;
  focusLeaf: (leafId: string) => void;
  focusAdjacent: (dir: "next" | "prev") => void;
  setRatio: (splitId: string, ratio: number) => void;
  /** Bind (or clear, with null) the session shown in a leaf. */
  bindSession: (leafId: string, sessionId: string | null) => void;
  toggleZoom: (leafId?: string) => void;
  /** Collapse to a single pane bound to `sessionId`. */
  reset: (sessionId: string | null) => void;
  /** Drop leaves whose session vanished (deleted / not in `valid`), collapsing
   *  toward a single pane. A null-session (draft) leaf is always kept. */
  pruneSessions: (valid: Set<string>) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const root = makeLeaf(initialSessionId());
  const commit = (tree: PaneNode, focusedLeafId: string, zoomedLeafId: string | null = get().zoomedLeafId) => {
    set({ tree, focusedLeafId, zoomedLeafId });
  };
  return {
    tree: root,
    focusedLeafId: root.id,
    zoomedLeafId: null,
    split: (dir, sessionId) => {
      const { tree, focusedLeafId } = get();
      const { tree: next, newLeafId } = splitLeaf(tree, focusedLeafId, dir, sessionId);
      commit(next, newLeafId, null); // splitting exits zoom
    },
    closeFocused: () => get().closePane(get().focusedLeafId),
    closePane: (leafId) => {
      const { tree, focusedLeafId } = get();
      const res = closeLeaf(tree, leafId);
      if (!res) return;
      const nextFocus = leafId === focusedLeafId ? res.nextFocusId : focusedLeafId;
      commit(res.tree, nextFocus, null);
    },
    focusLeaf: (leafId) => {
      if (!findLeaf(get().tree, leafId)) return;
      set({ focusedLeafId: leafId });
    },
    focusAdjacent: (dir) => get().focusLeaf(adjacentLeafId(get().tree, get().focusedLeafId, dir)),
    setRatio: (splitId, ratio) => {
      const next = setRatio(get().tree, splitId, ratio);
      commit(next, get().focusedLeafId);
    },
    bindSession: (leafId, sessionId) => {
      const next = setLeafSession(get().tree, leafId, sessionId);
      commit(next, get().focusedLeafId);
    },
    toggleZoom: (leafId) => {
      const target = leafId ?? get().focusedLeafId;
      set({ zoomedLeafId: get().zoomedLeafId === target ? null : target });
    },
    reset: (sessionId) => {
      const root = makeLeaf(sessionId);
      commit(root, root.id, null);
    },
    pruneSessions: (valid) => {
      const { tree, focusedLeafId } = get();
      let next = tree;
      for (const l of leaves(tree)) {
        if (l.sessionId !== null && !valid.has(l.sessionId)) {
          const res = closeLeaf(next, l.id);
          if (res) next = res.tree;
        }
      }
      if (next === tree) return;
      const focus = findLeaf(next, focusedLeafId) ? focusedLeafId : leaves(next)[0].id;
      commit(next, focus, null);
    },
  };
});
