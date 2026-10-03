import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { updateGear, updateMedia } from "../actions";
import { GearFields } from "../gear-fields";
import { MediaUploader } from "./media-uploader";

export default async function EditGear({ params }: PageProps<"/staff/[tenant]/gear/[gearId]">) {
  const { tenant: slug, gearId } = await params;
  if (!UUID_RE.test(gearId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: gear } = await supabase
    .from("gear_items")
    .select("id, key, name, description, unit_label, default_price_cents, tax_category, active")
    .eq("id", gearId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!gear) notFound();
  const { data: media } = await supabase
    .from("gear_media")
    .select("id, storage_path, kind, content_type, alt_text, sort_order, active")
    .eq("gear_item_id", gear.id)
    .order("sort_order")
    .order("created_at");

  // Short-lived signed URLs, issued to this staff user only.
  const paths = (media ?? []).map((m) => m.storage_path);
  const { data: signed } = paths.length
    ? await supabase.storage.from("gear-media").createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const categories = Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>);

  return (
    <>
      <PageHeader
        title={gear.name}
        description={<Link className="underline" href={`/staff/${slug}/gear`}>Back to gear</Link>}
        actions={gear.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={updateGear.bind(null, slug, gear.id)} submitLabel="Save gear item">
            <GearFields gear={gear} taxCategories={categories} />
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Photos and videos</CardTitle>
          <CardDescription>Shown to clients on proposals. Only active media is copied into new offers.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <MediaUploader slug={slug} gearId={gear.id} />
          {media && media.length > 0 ? (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {media.map((m) => {
                const url = urlFor.get(m.storage_path);
                return (
                  <li key={m.id} className="grid gap-3 rounded-xl border p-3">
                    <div className="aspect-video overflow-hidden rounded-lg bg-muted">
                      {url && m.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                        <img src={url} alt={m.alt_text} className="size-full object-cover" />
                      ) : url ? (
                        <video src={url} controls preload="metadata" className="size-full object-cover" aria-label={m.alt_text} />
                      ) : null}
                    </div>
                    <div className="flex gap-2 text-xs">
                      <Badge variant="outline">{m.content_type}</Badge>
                      {m.active ? null : <Badge variant="outline">Archived</Badge>}
                    </div>
                    <ActionForm action={updateMedia.bind(null, slug, gear.id, m.id)} submitLabel="Save">
                      <TextField label="Alt text" name="alt_text" id={`alt-${m.id}`} defaultValue={m.alt_text} maxLength={300} required />
                      <TextField label="Order" name="sort_order" id={`sort-${m.id}`} type="number" min={0} max={10000} defaultValue={m.sort_order} />
                      <CheckboxField label="Active" name="active" defaultChecked={m.active} />
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No photos or videos yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
