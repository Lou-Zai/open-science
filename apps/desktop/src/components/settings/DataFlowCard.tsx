import { HardDrive, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "./Section";

/**
 * Plain-language disclosure of what stays local vs. what is sent to the model
 * provider (P0-2 / P2-3). Every statement here must stay true to the actual
 * architecture — when behavior changes, change this copy in the same commit.
 */
export function DataFlowCard({ model, workspace }: { model: string | null; workspace: string | null }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Section title={t("dataFlow.title")} hint={t("dataFlow.subtitle")}>
      <div className="grid gap-5 py-1 sm:grid-cols-2">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-text">
            <HardDrive size={14} className="text-ok" /> {t("dataFlow.local.heading")}
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-muted">
            <li>
              {t("dataFlow.local.workspaceFiles")}
              {workspace && <span className="font-mono text-xs"> ({workspace})</span>}.
            </li>
            <li>{t("dataFlow.local.codeExecution")}</li>
            <li>{t("dataFlow.local.sessionHistory")}</li>
            <li>{t("dataFlow.local.providerKeys")}</li>
          </ul>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-text">
            <Send size={14} className="text-warn" /> {t("dataFlow.remote.heading")}
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
              {model ?? t("dataFlow.remote.noModel")}
            </span>
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-muted">
            <li>{t("dataFlow.remote.messages")}</li>
            <li>{t("dataFlow.remote.notBackground")}</li>
            <li>{t("dataFlow.remote.providerPolicy")}</li>
          </ul>
          <p className="mt-2 text-xs text-muted">{t("dataFlow.skillsHint")}</p>
        </div>
      </div>
    </Section>
  );
}
