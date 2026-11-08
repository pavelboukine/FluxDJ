import { ChevronLeft } from "lucide-react";
import Link from "@/components/app/pending-link";
import { SettingsNav } from "../settings-nav";
import { SettingsUnsavedGuard } from "../unsaved-guard";

/** The settings pages: a navigation column from lg; below it, a way back to the directory. Each page checks access itself. */
export default async function SettingsSectionsLayout({ children, params }: LayoutProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  return (
    <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
      <SettingsNav slug={slug} />
      <Link
        href={`/staff/${slug}/settings`}
        data-testid="settings-back"
        className="-my-2 inline-flex min-h-11 w-fit items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline lg:hidden"
      >
        <ChevronLeft aria-hidden className="size-4" />
        All settings
      </Link>
      <SettingsUnsavedGuard>{children}</SettingsUnsavedGuard>
    </div>
  );
}
