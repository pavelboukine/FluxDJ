"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Film, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { GEAR_MEDIA_TYPES, isGearMediaType } from "@/lib/media/sniff";
import { finalizeGearMediaUpload, prepareGearMediaUpload } from "../actions";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm";
const STEPS = { checking: "Checking the file…", uploading: "Uploading…", verifying: "Verifying the file's contents…" } as const;

type Status =
  | { kind: "idle" }
  | { kind: "working"; step: keyof typeof STEPS }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/**
 * Upload one photo or video: the server picks the path and checks type and
 * size, the browser uploads to Storage (tenant-scoped by RLS), then the
 * server verifies the content before the media row exists. A failure never
 * touches existing media and keeps the chosen file and description for a retry.
 */
export function MediaUploader({ slug, gearId }: { slug: string; gearId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const working = status.kind === "working";

  // The chosen image's local preview URL is released when replaced or on leaving.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    if (!working) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [working]);

  function choose(next: File | null) {
    setFile(next);
    setPreview(next && next.type.startsWith("image/") ? URL.createObjectURL(next) : null);
    if (!next) return setStatus({ kind: "idle" });
    // Early, friendly feedback; the server repeats every check.
    if (!isGearMediaType(next.type)) return setStatus({ kind: "error", message: "Choose a JPEG, PNG, WebP or AVIF image, or an MP4 or WebM video." });
    const max = GEAR_MEDIA_TYPES[next.type].maxBytes;
    if (next.size > max) return setStatus({ kind: "error", message: `That file is ${mb(next.size)}. ${GEAR_MEDIA_TYPES[next.type].kind === "image" ? "Images" : "Videos"} can be up to ${mb(max)}.` });
    setStatus({ kind: "idle" });
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    if (!file) return setStatus({ kind: "error", message: "Choose a file first." });
    if (!alt.trim()) return setStatus({ kind: "error", message: "Describe the photo or video for people using screen readers." });

    setStatus({ kind: "working", step: "checking" });
    const prepared = await prepareGearMediaUpload(slug, gearId, { contentType: file.type, size: file.size });
    if (!prepared.ok) return setStatus({ kind: "error", message: prepared.message });

    setStatus({ kind: "working", step: "uploading" });
    const { error } = await createClient().storage.from("gear-media").upload(prepared.path, file, { contentType: file.type, upsert: false });
    if (error) return setStatus({ kind: "error", message: "The upload didn't finish. Check your connection, then try again." });

    setStatus({ kind: "working", step: "verifying" });
    const result = await finalizeGearMediaUpload(slug, gearId, { path: prepared.path, altText: alt });
    if (result.status === "error") return setStatus({ kind: "error", message: `Not added: ${result.message}` });

    setStatus({ kind: "success", message: `Added ${file.name}. It's verified and appears on new proposals.` });
    setAlt("");
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  return (
    <form onSubmit={upload} aria-label="Add a photo or video" className="grid gap-4 rounded-xl border border-dashed p-4" data-testid="media-uploader">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="grid content-start gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="media-file">Photo or video</Label>
            <Input id="media-file" ref={fileRef} type="file" accept={ACCEPT} disabled={working} onChange={(e) => choose(e.target.files?.[0] ?? null)} aria-describedby="media-rules" />
            <p id="media-rules" className="text-xs text-muted-foreground">
              JPEG, PNG, WebP or AVIF up to 15 MB; MP4 or WebM up to 100 MB. Files are checked by their contents, not their names.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="media-alt">Description (alt text)</Label>
            <Input id="media-alt" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} disabled={working} placeholder="Speaker on a stand beside the aisle" />
          </div>
        </div>
        {file ? (
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted" aria-hidden>
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen file
              <img src={preview} alt="" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="grid justify-items-center gap-1 p-2 text-center text-xs text-muted-foreground">
                <Film className="size-6" />
                {mb(file.size)}
              </span>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={working}>
          <Upload aria-hidden />
          {working ? "Uploading…" : "Upload"}
        </Button>
        {status.kind === "working" ? (
          <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <progress aria-label="Upload in progress" className="h-1.5 w-24 accent-primary" />
            {STEPS[status.step]}
          </span>
        ) : status.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">{status.message}</p>
        ) : status.kind === "success" ? (
          <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 aria-hidden className="size-4" />
            {status.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
