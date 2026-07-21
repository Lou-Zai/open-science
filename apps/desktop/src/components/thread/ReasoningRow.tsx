import { memo, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReasoningBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";

/**
 * The model's reasoning ("thinking") for a step — dimmed and collapsible, kept
 * visually distinct from the final answer. Open by default so live thinking is
 * visible as it streams; the user can fold it away when it gets noisy.
 */
export const ReasoningRow = memo(function ReasoningRow({ block }: { block: ReasoningBlock }) {
  const { t } = useTranslation(["session", "common"]);
  const [open, setOpen] = useState(true);
  const text = block.text.trim();
  if (!text) return null;
  return (
    <div className="rounded-input border border-border/70 bg-surface-2/40">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Brain size={14} className="shrink-0 text-muted/80" />
        <span className="font-medium">{t("reasoning.label")}</span>
        <ChevronRight
          size={14}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto px-3 pb-3">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted">
            {text}
          </p>
        </div>
      )}
    </div>
  );
});
