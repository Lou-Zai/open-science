import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { Toaster } from "@/components/ui/Toaster";
import { mockProject } from "@/lib/mock";
import { useRuntimeStore } from "@/lib/runtime";
import { ensureSetupProgressListener } from "@/lib/setup";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { ensureJupyter, openExternal, watchFullscreen } from "@/lib/tauri";
import { useUpdateStore } from "@/lib/update";

export function AppShell() {
  const { t } = useTranslation("nav");
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();

  // Cmd/Ctrl+B toggles the sidebar, matching the button's tooltip. Not in
  // settings: there the sidebar IS the settings navigation (with the only way
  // back to the app), so it must not collapse.
  const inSettings = useLocation().pathname.startsWith("/settings");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (!window.location.pathname.startsWith("/settings"))
          useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // In the packaged desktop app, auto-start the bundled OpenCode and connect,
  // and bring the Jupyter server back up if the user enabled it before.
  useEffect(() => {
    void useRuntimeStore.getState().bootstrap();
    void ensureJupyter();
    // One app-lifetime listener for uv provisioning progress, so a running
    // download's live output survives navigating between pages.
    ensureSetupProgressListener();
    if (!import.meta.env.TEST) {
      void useUpdateStore.getState().maybeAutoCheck();
    }
  }, []);

  // Track native fullscreen: macOS hides the traffic lights there, so headers
  // must drop their traffic-light inset (see useOverlayTitlebar).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void watchFullscreen((fs) => useUiStore.getState().setIsFullscreen(fs)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // External links open in the system browser. Navigating the webview away
  // from the app would strand the user — there is no back button.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a[href]");
      const href = anchor?.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The live session page's own header doubles as the titlebar when the
  // sidebar is collapsed; every other route gets this fallback strip so the
  // macOS traffic lights don't overlap content, the window stays draggable,
  // and the sidebar can be re-expanded.
  const isMac = navigator.userAgent.includes("Mac");
  const overlayTitlebar = useOverlayTitlebar();
  const pageOwnsTitlebar = useLocation().pathname.startsWith("/live");

  return (
    // The window background lives on <main>, not the shell: under vibrancy
    // the area behind the (translucent) sidebar must stay transparent.
    <div className="flex h-screen w-screen overflow-hidden text-text">
      <Sidebar project={mockProject} />
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* Titlebar strip for pages that don't own one: keeps the whole top
            of the content area draggable under the macOS overlay titlebar,
            and hosts the expand button while the sidebar is collapsed. */}
        {!pageOwnsTitlebar && (overlayTitlebar || (sidebarCollapsed && !inSettings)) && (
          <div
            data-tauri-drag-region={overlayTitlebar || undefined}
            style={
              overlayTitlebar
                ? overlayTitlebarStyle(sidebarCollapsed && !inSettings)
                : undefined
            }
            className={cn("flex shrink-0 items-center", !overlayTitlebar && "h-12 pl-2")}
          >
            {sidebarCollapsed && !inSettings && (
              <button
                onClick={() => setSidebarCollapsed(false)}
                aria-label={t("sidebar.expand")}
                title={t("sidebar.expandTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
                className="fade-in rounded p-1 text-text hover:bg-surface-2"
              >
                <PanelLeft size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
      <Toaster />
    </div>
  );
}
