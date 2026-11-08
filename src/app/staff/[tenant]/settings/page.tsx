import type { Metadata } from "next";
import Link from "@/components/app/pending-link";
import { PageHeader } from "@/components/app/fields";
import { LinkRow } from "@/components/app/link-row";
import { outlineLink } from "@/components/app/list";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { settingsNavigation } from "@/lib/navigation";
import { LegacySettingsHash } from "./legacy-hash";

export const metadata: Metadata = { title: "Business settings · Flux DJ" };

/** The directory of Business Settings: a plain list of its pages, and where old /settings#anchor links are forwarded from. */
export default async function BusinessSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  await requireStaff(slug);

  return (
    <>
      <LegacySettingsHash slug={slug} />
      <SetupReturn slug={slug} from={from} />
      <PageHeader
        title="Business settings"
        description="How your business appears to clients, how bookings work, and your planning defaults. Changes never alter proposals already sent or contracts already generated."
        actions={<Link className={outlineLink} href={`/staff/${slug}/setup`}>Setup guide</Link>}
      />
      <nav aria-label="Settings" data-testid="settings-directory" className="grid gap-6">
        {settingsNavigation(slug).map((group) => (
          <section key={group.label} aria-labelledby={`settings-${group.label}`} className="grid max-w-2xl gap-2">
            <h2 id={`settings-${group.label}`} className="text-base font-semibold">{group.label}</h2>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {group.pages.map((page) => (
                <li key={page.href}>
                  <LinkRow href={page.href} title={page.label} detail={page.description} className="rounded-none px-4 py-3" />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </>
  );
}
