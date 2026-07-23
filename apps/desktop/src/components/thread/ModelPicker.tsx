import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, Cpu, Loader2, Search, Star, X, Zap } from "lucide-react";
import { useRuntimeStore } from "@/lib/runtime";
import { useIsMobile } from "@/lib/useIsMobile";
import { cn } from "@/lib/cn";
import {
  flattenModelOptions,
  filterModelOptions,
  type ModelFilter,
} from "@/components/settings/modelCatalog";
import {
  loadModelPreferences,
  recordRecent,
  saveModelPreferences,
  toggleFavorite,
  type ModelPreferences,
} from "@/components/settings/modelPreferences";

/** Display label for a reasoning-effort variant. Variant names are provider
 *  tokens (like model ids), the same in every language, so we title-case them
 *  in place rather than translating: "high" → "High", "xhigh" → "X-High". */
function labelVariant(name: string): string {
  if (name === "xhigh") return "X-High";
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * Inline model + reasoning-effort switcher for the composer (issues #48, #40).
 * A compact chip ("model · effort ⌄") that opens a picker: search, All /
 * Favorites / Recent / per-provider filters, a model list, and — only for models
 * that expose reasoning levels — an "Advanced" section with a segmented effort
 * control built from that model's own `variants`.
 *
 * Reads the runtime store directly (like the composer's own `getState()` calls):
 * the picker is a live-session concern and the store is the one source of truth
 * for providers / default model / reasoning variant. The composer renders it
 * only in the live session, so its `useNavigate` never runs in a mock surface.
 *
 * One picker body renders in two shells: an anchored popover on desktop/wide
 * web, a bottom sheet on phone-width viewports (`useIsMobile`).
 */
export function ModelPicker() {
  const { t } = useTranslation(["session", "common"]);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const providers = useRuntimeStore((s) => s.providers);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const reasoningVariant = useRuntimeStore((s) => s.reasoningVariant);
  const setDefaultModel = useRuntimeStore((s) => s.setDefaultModel);
  const setReasoningVariant = useRuntimeStore((s) => s.setReasoningVariant);
  const switching = useRuntimeStore((s) => s.switching);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>({ kind: "all" });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [prefs, setPrefs] = useState<ModelPreferences>(() => loadModelPreferences());
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const variantsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of providers)
      for (const m of p.models) map.set(`${p.id}/${m.id}`, m.variants ?? []);
    return map;
  }, [providers]);

  const current = options.find((o) => o.key === defaultModel);
  const currentVariants = (defaultModel && variantsByKey.get(defaultModel)) || [];
  // The effort actually in force: the user's pick, but only when the current
  // model exposes it (else the model falls back to its own default — mirrors the
  // store's `activeVariant`, so the chip never claims an effort that won't send).
  const activeVariant =
    reasoningVariant && currentVariants.includes(reasoningVariant) ? reasoningVariant : null;
  const activeIdx = activeVariant ? currentVariants.indexOf(activeVariant) : -1;

  const visible = filterModelOptions(options, filter, query, prefs.favorites, prefs.recent);

  // Manual outside-press dismissal — WKWebView never focuses a clicked button, so
  // relying on blur would leave the popover stuck open. (The composer's other
  // menus do the same.) The mobile sheet closes via its scrim instead.
  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, isMobile]);

  // Close on Escape from anywhere in the picker.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // On open: reset the query, focus search on desktop (skip on mobile so the
  // sheet doesn't yank up the keyboard), and default Advanced open when an
  // effort is already pinned so the user sees their setting.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAdvancedOpen(!!activeVariant);
    if (!isMobile) searchRef.current?.focus();
    // Only when the popover transitions to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const persistPrefs = (next: ModelPreferences) => {
    saveModelPreferences(next);
    setPrefs(next);
  };

  const selectModel = async (key: string) => {
    persistPrefs(recordRecent(prefs, key));
    // Reasoning-capable models keep the picker open so the user can dial in the
    // effort right after the switch; models with nothing more to adjust close it.
    if ((variantsByKey.get(key) ?? []).length > 0) setAdvancedOpen(true);
    else setOpen(false);
    if (key !== defaultModel) {
      try {
        await setDefaultModel(key);
      } catch {
        // setDefaultModel records modelSwitchError / toasts on its own.
      }
    }
  };

  const chipLabel = current?.modelName ?? t("composer.model.none");

  const filterChips: { key: string; label: string; icon?: typeof Star; value: ModelFilter }[] = [
    { key: "all", label: t("composer.model.filter.all"), value: { kind: "all" } },
    {
      key: "favorites",
      label: t("composer.model.filter.favorites"),
      icon: Star,
      value: { kind: "favorites" },
    },
    { key: "recent", label: t("composer.model.filter.recent"), value: { kind: "recent" } },
    ...providers.map((p) => ({
      key: `provider:${p.id}`,
      label: p.name,
      value: { kind: "provider", providerID: p.id } as ModelFilter,
    })),
  ];
  const isActiveFilter = (value: ModelFilter) =>
    value.kind === filter.kind &&
    (value.kind !== "provider" ||
      (filter.kind === "provider" && value.providerID === filter.providerID));

  const body = (
    <div className="flex min-h-0 flex-col">
      {/* Search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-faint px-2.5 py-2">
        <Search size={13} className="shrink-0 text-muted" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("composer.model.search")}
          className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-muted focus:outline-none"
        />
        {isMobile && (
          <button
            aria-label={t("composer.model.close")}
            className="shrink-0 rounded-full p-1 text-muted hover:bg-surface-2 hover:text-text"
            onClick={() => setOpen(false)}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Filter chips */}
      {options.length > 0 && (
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-faint px-2 py-1.5">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px]",
                isActiveFilter(chip.value)
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
              onClick={() => setFilter(chip.value)}
            >
              {chip.icon && <chip.icon size={10} />}
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Model list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {options.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted">
            {t("composer.model.empty")}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted">
            {t("composer.model.noResults")}
          </div>
        ) : (
          visible.map((o) => {
            const isCurrent = o.key === defaultModel;
            const isFavorite = prefs.favorites.includes(o.key);
            const hasReasoning = (variantsByKey.get(o.key) ?? []).length > 0;
            return (
              <div
                key={o.key}
                className={cn(
                  "group flex items-center gap-2 rounded-input px-2 py-1.5",
                  isCurrent ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => void selectModel(o.key)}
                >
                  <Check
                    size={13}
                    className={cn("shrink-0 text-accent", isCurrent ? "" : "opacity-0")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-xs text-text">{o.modelName}</span>
                      {hasReasoning && (
                        <Zap size={9} className="shrink-0 text-muted" aria-hidden />
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted">{o.providerName}</span>
                  </span>
                </button>
                <button
                  aria-label={t("composer.model.favorite")}
                  aria-pressed={isFavorite}
                  className={cn(
                    "shrink-0 rounded-full p-1 hover:bg-surface",
                    isFavorite
                      ? "text-accent"
                      : "text-muted opacity-0 group-hover:opacity-100 focus:opacity-100",
                  )}
                  onClick={() => persistPrefs(toggleFavorite(prefs, o.key))}
                >
                  <Star size={12} fill={isFavorite ? "currentColor" : "none"} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Advanced: reasoning effort — only for models that expose levels (#40) */}
      {currentVariants.length > 0 && (
        <div className="shrink-0 border-t border-faint px-2 py-1.5">
          <button
            className="flex w-full items-center gap-1.5 rounded-input px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Zap size={12} />
            <span className="font-medium text-text">{t("composer.model.reasoning")}</span>
            <span className="ml-auto text-muted">
              {activeVariant ? labelVariant(activeVariant) : t("composer.model.reasoningDefault")}
            </span>
          </button>
          {advancedOpen && (
            <div className="px-2 pb-2.5 pt-3">
              {/* Segmented slider over the model's own levels. Each level is a hit
                  target with a dot; the fill + knob mark the current effort. No
                  fill/knob means "model default" (nothing sent). */}
              <div className="relative h-5 select-none">
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-2" />
                {activeIdx >= 0 && (
                  <div
                    className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent"
                    style={{ width: `${((activeIdx + 0.5) / currentVariants.length) * 100}%` }}
                  />
                )}
                <div className="absolute inset-0 flex">
                  {currentVariants.map((v, i) => (
                    <button
                      key={v}
                      type="button"
                      aria-label={labelVariant(v)}
                      aria-pressed={i === activeIdx}
                      // Re-tapping the active level clears it → the model's default.
                      onClick={() => setReasoningVariant(v === activeVariant ? null : v)}
                      className="flex flex-1 items-center justify-center"
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          activeIdx >= 0 && i <= activeIdx ? "bg-accent-fg/80" : "bg-muted/40",
                        )}
                      />
                    </button>
                  ))}
                </div>
                {activeIdx >= 0 && (
                  <div
                    className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-white shadow-pop"
                    style={{ left: `${((activeIdx + 0.5) / currentVariants.length) * 100}%` }}
                  />
                )}
              </div>
              <p className="px-0.5 pt-2.5 text-[11px] text-muted">
                {t("composer.model.reasoningHint")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Manage providers */}
      <button
        className="shrink-0 border-t border-faint px-3 py-2 text-left text-xs text-accent hover:underline"
        onClick={() => {
          setOpen(false);
          navigate("/settings/models");
        }}
      >
        {t("composer.model.manage")}
      </button>
    </div>
  );

  return (
    <div className="relative shrink-0" ref={rootRef}>
      {/* Chip trigger */}
      <button
        aria-label={t("composer.model.aria")}
        title={t("composer.model.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-7 max-w-[190px] items-center gap-1.5 rounded-full px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
        onClick={() => setOpen((o) => !o)}
      >
        {switching ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : (
          <Cpu size={12} className="shrink-0" />
        )}
        <span className="truncate text-text">{chipLabel}</span>
        {activeVariant && (
          <span className="shrink-0 text-muted">· {labelVariant(activeVariant)}</span>
        )}
        <ChevronDown size={11} className="shrink-0" />
      </button>

      {/* Desktop / wide-web: anchored popover above the chip */}
      {open && !isMobile && (
        <div
          role="dialog"
          aria-label={t("composer.model.title")}
          className="absolute bottom-full right-0 z-30 mb-2 flex max-h-[min(70vh,26rem)] w-[340px] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          {body}
        </div>
      )}

      {/* Mobile: bottom sheet + scrim */}
      {open && isMobile && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label={t("composer.model.title")}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-t-card border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop"
          >
            {body}
          </div>
        </>
      )}
    </div>
  );
}
