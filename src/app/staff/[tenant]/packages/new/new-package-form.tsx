"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/app/action-form";
import { GuardedCancel } from "@/components/app/unsaved-guard";
import { fail, ok, type ActionState } from "@/lib/forms";
import { createPackage } from "../actions";
import { photoFileCheck, uploadPackagePhoto } from "../package-photo";

/**
 * The new-package form. Without a photo it saves as before (create_package,
 * then the package page). With one, the package is created first (the photo
 * needs it to exist), then the photo is uploaded and verified, then the
 * package page opens; if only the photo fails, the package is kept and its
 * page says so. The file itself never goes through the Server Action.
 */
export function NewPackageForm({ slug, children }: { slug: string; children: ReactNode }) {
  const router = useRouter();

  async function save(state: ActionState, data: FormData): Promise<ActionState> {
    const file = data.get("photo");
    const alt = String(data.get("photo_alt") ?? "");
    data.delete("photo");
    data.delete("photo_alt");
    const photo = file instanceof File && file.size > 0 ? file : null;
    if (!photo) return createPackage(slug, state, data);

    const { problem } = await photoFileCheck(photo);
    if (problem) return fail(`Nothing was saved. ${problem}`);
    data.set("photo_pending", "1");
    const created = await createPackage(slug, state, data);
    if (created.status !== "success") return created;
    // create_package takes the form's request id as the package id.
    const packageId = String(data.get("request_id"));
    const uploaded = await uploadPackagePhoto(slug, packageId, photo, alt);
    router.push(`/staff/${slug}/packages/${packageId}?created=1${uploaded.status === "success" ? "" : "&photo=failed"}`);
    return uploaded.status === "success" ? ok("Package created with its photo.") : ok("Package created, but its photo wasn't added.");
  }

  return (
    <ActionForm
      action={save}
      submitLabel="Save package"
      pendingLabel="Saving…"
      trackUnsaved
      secondary={<GuardedCancel cancelHref={`/staff/${slug}/packages`} message="Discard this new package?" />}
    >
      {children}
    </ActionForm>
  );
}
