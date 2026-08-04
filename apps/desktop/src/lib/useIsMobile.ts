import { useSyncExternalStore } from "react";

import { useUiStore } from "@/lib/store";
import { isTauri } from "@/lib/tauri";

// A viewport is "mobile" at or below this width (phones / narrow LAN-web
// windows). The desktop shell (fixed sidebar that shares horizontal space) is
// unusable there, so mobile turns the sidebar into an overlay drawer.
const MOBILE_MAX_PX = 768;

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function widthSnapshot(): number {
  // No window (SSR / node tests): never mobile, as before.
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

/**
 * True on phone-width viewports. SSR/test-safe (returns false).
 *
 * Measured against the WINDOW's width, not the CSS-pixel viewport. Page zoom
 * shrinks the CSS viewport — at 175% a 1200 px window reports ~686 CSS px — so a
 * plain `(max-width: 768px)` media query flipped the desktop into phone layout
 * (sidebar becomes an overlay drawer, pickers become bottom sheets) purely
 * because the user asked for bigger text. Multiplying the zoom back out keeps
 * the breakpoint about the window, which is what it was always meant to describe
 * (#63). At 100% zoom this is exactly the old behavior.
 *
 * The zoom factor only counts in the desktop app: `ZoomProvider` applies it to
 * the webview there, while in a browser the user's own zoom is invisible to us
 * and the stored factor stays 1.
 */
export function useIsMobile(): boolean {
  const zoom = useUiStore((s) => s.zoom);
  const cssWidth = useSyncExternalStore(
    subscribe,
    widthSnapshot,
    () => Number.POSITIVE_INFINITY,
  );
  return cssWidth * (isTauri ? zoom : 1) <= MOBILE_MAX_PX;
}
