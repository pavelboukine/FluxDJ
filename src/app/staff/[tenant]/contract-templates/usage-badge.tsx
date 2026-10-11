import { Badge } from "@/components/ui/badge";
import { USAGE_LABELS, type TemplateUsage } from "@/lib/contracts/usage";

/** How a published version may be used: DEMO, client use, or (old versions) neither. */
export function UsageBadge({ usage }: { usage: string | null }) {
  if (usage === "client_use") return <Badge>Client use</Badge>;
  if (usage === "demo") return <Badge variant="outline">DEMO</Badge>;
  return <Badge variant="secondary">{USAGE_LABELS[(usage ?? "legacy") as TemplateUsage]}</Badge>;
}
