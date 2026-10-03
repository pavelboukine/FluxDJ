"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { finalizeGearMediaUpload, prepareGearMediaUpload } from "../actions";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm";

type Status = { kind: "idle" | "working" | "error" | "success"; message?: string };

export function MediaUploader({ slug, gearId }: { slug: string; gearId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setStatus({ kind: "error", message: "Choose a file first." });
    if (!alt.trim()) return setStatus({ kind: "error", message: "Describe the photo or video for screen readers." });

    setStatus({ kind: "working", message: "Checking…" });
    const prepared = await prepareGearMediaUpload(slug, gearId, { contentType: file.type, size: file.size });
    if (!prepared.ok) return setStatus({ kind: "error", message: prepared.message });

    setStatus({ kind: "working", message: "Uploading…" });
    const { error } = await createClient().storage.from("gear-media").upload(prepared.path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error) return setStatus({ kind: "error", message: "Upload failed. Check the file type and size, then try again." });

    setStatus({ kind: "working", message: "Verifying file contents…" });
    const result = await finalizeGearMediaUpload(slug, gearId, { path: prepared.path, altText: alt });
    if (result.status === "error") return setStatus({ kind: "error", message: result.message });

    setStatus({ kind: "success", message: "Uploaded." });
    setAlt("");
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  const working = status.kind === "working";
  return (
    <form onSubmit={upload} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="media-file">Photo or video</Label>
        <Input id="media-file" ref={fileRef} type="file" accept={ACCEPT} disabled={working} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="media-alt">Description (alt text)</Label>
        <Input id="media-alt" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} disabled={working} placeholder="Speaker on a stand beside the aisle" />
      </div>
      <Button type="submit" disabled={working}>
        {working ? "Working…" : "Upload"}
      </Button>
      {status.message ? (
        <p role={status.kind === "error" ? "alert" : "status"} className={`text-sm sm:col-span-3 ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground sm:col-span-3">
        JPEG, PNG, WebP or AVIF up to 15 MB; MP4 or WebM up to 100 MB. Files are checked by content, not by name. Uploaded files are never
        overwritten; archive one to hide it from new proposals.
      </p>
    </form>
  );
}
