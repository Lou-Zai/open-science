import {
  Cloud,
  Cpu,
  Palette,
  Plug,
  Settings,
  Shapes,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/** Settings sections — the sidebar nav and `/settings/:section` routes.
 *  Labels come from the settings i18n namespace under `nav.<key>`. */
export const SETTINGS_SECTIONS = [
  { key: "general", icon: Settings },
  { key: "appearance", icon: Palette },
  { key: "models", icon: Shapes },
  { key: "runtime", icon: Cpu },
  { key: "connectors", icon: Plug },
  { key: "compute", icon: Cloud },
  { key: "privacy", icon: ShieldCheck },
] as const satisfies ReadonlyArray<{ key: string; icon: LucideIcon }>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

export function resolveSection(raw: string | undefined): SettingsSection {
  return (SETTINGS_SECTIONS.find((s) => s.key === raw)?.key ?? "general") as SettingsSection;
}
