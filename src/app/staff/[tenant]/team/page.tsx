import { redirect } from "next/navigation";

/** Team moved into Business Settings; this keeps bookmarks working. Access is checked by the page it leads to. */
export default async function TeamRedirect({ params }: PageProps<"/staff/[tenant]/team">) {
  const { tenant: slug } = await params;
  redirect(`/staff/${slug}/settings/team`);
}
