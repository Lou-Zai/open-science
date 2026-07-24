import { useRef } from "react";
import {
  RATIO_MAX,
  RATIO_MIN,
  leaves,
  useLayoutStore,
  type PaneNode,
  type PaneSplit,
} from "@/lib/layout";
import { useDragDivider } from "@/lib/useDragDivider";
import { cn } from "@/lib/cn";
import { SessionView } from "./SessionView";

/**
 * Ghostty-style recursive split renderer. Splits become flex rows/columns with
 * a draggable divider; leaves host a SessionView wrapped in a click-to-focus
 * ring. A zoomed leaf renders alone, full-area, without discarding the tree.
 */
export function PaneTree() {
  const tree = useLayoutStore((s) => s.tree);
  const focusedLeafId = useLayoutStore((s) => s.focusedLeafId);
  const zoomedLeafId = useLayoutStore((s) => s.zoomedLeafId);
  // The primary (top-left) leaf carries the titlebar chrome; the rest get a
  // plain header (only one pane may clear the macOS traffic lights).
  const primaryLeafId = leaves(tree)[0]?.id;

  if (zoomedLeafId) {
    const zoomed = leaves(tree).find((l) => l.id === zoomedLeafId);
    if (zoomed) {
      return (
        <Leaf
          leafId={zoomed.id}
          sessionId={zoomed.sessionId}
          focused
          primary={zoomed.id === primaryLeafId}
        />
      );
    }
  }

  return <Node node={tree} focusedLeafId={focusedLeafId} primaryLeafId={primaryLeafId} />;
}

function Node({
  node,
  focusedLeafId,
  primaryLeafId,
}: {
  node: PaneNode;
  focusedLeafId: string;
  primaryLeafId: string | undefined;
}) {
  if (node.kind === "leaf") {
    return (
      <Leaf
        leafId={node.id}
        sessionId={node.sessionId}
        focused={node.id === focusedLeafId}
        primary={node.id === primaryLeafId}
      />
    );
  }
  return <Split node={node} focusedLeafId={focusedLeafId} primaryLeafId={primaryLeafId} />;
}

function Split({
  node,
  focusedLeafId,
  primaryLeafId,
}: {
  node: PaneSplit;
  focusedLeafId: string;
  primaryLeafId: string | undefined;
}) {
  const setRatio = useLayoutStore((s) => s.setRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const row = node.dir === "row";

  const { dragging, dragValue, handleProps } = useDragDivider({
    value: node.ratio,
    compute: (p) => {
      const el = containerRef.current;
      if (!el) return node.ratio;
      const r = el.getBoundingClientRect();
      const f = row ? (p.x - r.left) / r.width : (p.y - r.top) / r.height;
      return Math.min(RATIO_MAX, Math.max(RATIO_MIN, f));
    },
    onCommit: (v) => setRatio(node.id, v),
  });

  const ratio = dragValue ?? node.ratio;
  const aBasis = `${(ratio * 100).toFixed(3)}%`;

  return (
    <div ref={containerRef} className={cn("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col")}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `0 0 ${aBasis}` }}>
        <Node node={node.a} focusedLeafId={focusedLeafId} primaryLeafId={primaryLeafId} />
      </div>
      {/* Divider: a thin hit strip with a hairline that lights up on hover/drag. */}
      <div
        {...handleProps}
        className={cn(
          "group relative z-10 shrink-0",
          row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
          "bg-border",
        )}
      >
        <div
          className={cn(
            "absolute transition-colors",
            row ? "inset-y-0 -left-[2px] -right-[2px]" : "inset-x-0 -top-[2px] -bottom-[2px]",
            dragging ? "bg-accent/60" : "group-hover:bg-accent/40",
          )}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Node node={node.b} focusedLeafId={focusedLeafId} primaryLeafId={primaryLeafId} />
      </div>
    </div>
  );
}

function Leaf({
  leafId,
  sessionId,
  focused,
  primary,
}: {
  leafId: string;
  sessionId: string | null;
  focused: boolean;
  primary: boolean;
}) {
  const focusLeaf = useLayoutStore((s) => s.focusLeaf);
  return (
    // Focus follows the click, terminal-style: pointer-down capture wins even
    // over a button inside, so tapping anywhere in a pane focuses it first.
    <div
      onPointerDownCapture={() => {
        if (!focused) focusLeaf(leafId);
      }}
      className={cn(
        "relative h-full min-h-0 w-full min-w-0",
        // A soft inset ring marks the focused pane; unfocused panes dim slightly.
        focused ? "ring-1 ring-inset ring-accent/50" : "opacity-[0.97]",
      )}
    >
      <SessionView
        sessionId={sessionId}
        leafId={leafId}
        focused={focused}
        chromeAsTitlebar={primary}
      />
    </div>
  );
}
