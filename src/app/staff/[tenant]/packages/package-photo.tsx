"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ImageOff, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/app/action-form";
import { createClient } from "@/lib/supabase/client";
import { GEAR_MEDIA_TYPES, isGearMediaType } from "@/lib/media/sniff";
import { PHOTO_SIZE_HINT, photoLowResolutionMessage, photoResolution, photoTooSmallMessage, readImageSize } from "@/lib/media/resolution";
import { idleState, type ActionState } from "@/lib/forms";
import { finalizePackagePhotoUpload, preparePackagePhotoUpload, removePackagePhoto } from "./actions";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";
const RULES = `JPEG, PNG, WebP or AVIF, up to 15 MB. ${PHOTO_SIZE_HINT} Files are checked by their contents, not their names.`;
const STEPS = { checking: "Checking the file…", uploading: "Uploading…", verifying: "Verifying the photo…" } as const;
export type PhotoStep = keyof typeof STEPS;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** Early, friendly feedback on a chosen file; the server repeats every check. */
export function photoFileProblem(file: File): string | null {
  if (!isGearMediaType(file.type) || GEAR_MEDIA_TYPES[file.type].kind !== "image") return "Choose a JPEG, PNG, WebP or AVIF photo.";
  const max = GEAR_MEDIA_TYPES[file.type].maxBytes;
  return file.size > max ? `That file is ${mb(file.size)}. Photos can be up to ${mb(max)}.` : null;
}

/** photoFileProblem plus the photo's resolution: too small is a problem, low resolution a warning. */
export async function photoFileCheck(file: File): Promise<{ problem: string | null; warning: string | null }> {
  const problem = photoFileProblem(file);
  if (problem) return { problem, warning: null };
  const size = await readImageSize(file);
  if (!size) return { problem: null, warning: null }; // The browser can't decode it; the server decides.
  const resolution = photoResolution(size.width, size.height);
  if (resolution === "too_small") return { problem: photoTooSmallMessage(size.width, size.height), warning: null };
  return { problem: null, warning: resolution === "low" ? photoLowResolutionMessage(size.width, size.height) : null };
}

/** Checks a newly chosen file, ignoring results for a file that has since been replaced. */
function useFileCheck() {
  const latest = useRef<File | null>(null);
  return async (file: File | null): Promise<{ problem: string | null; warning: string | null } | null> => {
    latest.current = file;
    if (!file) return { problem: null, warning: null };
    const result = await photoFileCheck(file);
    return latest.current === file ? result : null;
  };
}

/**
 * Uploads a package photo: the server picks the path and checks type and
 * size, the browser uploads to Storage (business-scoped by RLS), then the
 * server verifies the contents and makes it the package's photo.
 */
export async function uploadPackagePhoto(slug: string, packageId: string, file: File, alt: string, onStep?: (step: PhotoStep) => void): Promise<ActionState> {
  onStep?.("checking");
  const prepared = await preparePackagePhotoUpload(slug, packageId, { contentType: file.type, size: file.size });
  if (!prepared.ok) return { status: "error", message: prepared.message };
  onStep?.("uploading");
  const { error } = await createClient().storage.from("gear-media").upload(prepared.path, file, { contentType: file.type, upsert: false });
  if (error) return { status: "error", message: "The upload didn't finish. Check your connection, then try again." };
  onStep?.("verifying");
  return finalizePackagePhotoUpload(slug, packageId, { path: prepared.path, altText: alt });
}

/** The chosen file with a local preview URL, released when replaced or on leaving. */
function useChosenFile(): [{ file: File; preview: string } | null, (file: File | null) => void] {
  const [chosen, setChosen] = useState<{ file: File; preview: string } | null>(null);
  useEffect(() => () => {
    if (chosen) URL.revokeObjectURL(chosen.preview);
  }, [chosen]);
  return [chosen, (file) => setChosen(file ? { file, preview: URL.createObjectURL(file) } : null)];
}

/**
 * The 4:3 frame packages are shown in on proposal cards: the photo fills it
 * (cropped to the frame from the centre, never stretched). The full-screen
 * viewer shows the whole photo.
 */
export function PhotoFrame({ url, alt, className }: { url: string | null; alt: string; className?: string }) {
  return (
    <div className={`flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-muted ${className ?? ""}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- local preview or short-lived signed URL
        <img src={url} alt={alt} className="size-full object-cover" />
      ) : (
        <span className="grid justify-items-center gap-1 p-3 text-center text-xs text-muted-foreground">
          <ImageOff aria-hidden className="size-6" />
          No photo
        </span>
      )}
    </div>
  );
}

/**
 * The photo fields of the new-package form. The file itself is never sent
 * with the form: NewPackageForm uploads it once the package exists.
 */
export function PackagePhotoPicker() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [chosen, setFile] = useChosenFile();
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const check = useFileCheck();
  const file = chosen?.file ?? null;

  async function choose(next: File | null) {
    const result = await check(next);
    if (!result) return;
    setProblem(result.problem);
    setWarning(result.warning);
    setFile(next && !result.problem ? next : null);
    if (result.problem && fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="grid gap-4 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_12rem]" data-testid="package-photo-picker">
      <div className="grid content-start gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="package-photo-file">Photo (optional)</Label>
          <Input id="package-photo-file" ref={fileRef} name="photo" type="file" accept={ACCEPT} onChange={(e) => void choose(e.target.files?.[0] ?? null)} aria-describedby="package-photo-rules" />
          <p id="package-photo-rules" className="text-xs text-muted-foreground">{RULES}</p>
          {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          {warning && file ? <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{warning}</p> : null}
        </div>
        {file ? (
          <div className="grid gap-1.5">
            <Label htmlFor="package-photo-alt">Photo description (optional)</Label>
            <Input id="package-photo-alt" name="photo_alt" maxLength={300} placeholder="Full DJ setup with lighting at a reception" />
            <p className="text-xs text-muted-foreground">For people using screen readers. The package name is used if left empty.</p>
          </div>
        ) : null}
        {file ? (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void choose(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              Clear photo
            </Button>
          </div>
        ) : null}
      </div>
      <PhotoFrame url={chosen?.preview ?? null} alt="" />
    </div>
  );
}

type Status = { kind: "idle" } | { kind: "working"; step: PhotoStep } | { kind: "error"; message: string } | { kind: "warning"; message: string } | { kind: "success"; message: string };

/**
 * The package page's photo: a preview as proposals frame it, with Add or
 * Replace (upload, verified before it's used) and Remove (confirmed). Changes
 * apply to new proposals; replaced and removed photos stay stored, so
 * proposals already sent keep showing theirs.
 */
export function PackagePhotoEditor({ slug, packageId, packageName, current }: { slug: string; packageId: string; packageName: string; current: { url: string | null; alt: string } | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [chosen, setFile] = useChosenFile();
  const file = chosen?.file ?? null;
  const preview = chosen?.preview ?? null;
  const [alt, setAlt] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [removeState, setRemoveState] = useState<ActionState>(idleState);
  const [removing, startRemove] = useTransition();
  const working = status.kind === "working";
  const check = useFileCheck();

  useEffect(() => {
    if (!working) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [working]);

  async function choose(next: File | null) {
    const result = await check(next);
    if (!result) return;
    setFile(next && !result.problem ? next : null);
    setStatus(result.problem ? { kind: "error", message: result.problem } : result.warning ? { kind: "warning", message: result.warning } : { kind: "idle" });
    if (result.problem && fileRef.current) fileRef.current.value = "";
  }

  function close() {
    setChoosing(false);
    setFile(null);
    setAlt("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    if (!file) return setStatus({ kind: "error", message: "Choose a photo first." });
    setRemoveState(idleState);
    const result = await uploadPackagePhoto(slug, packageId, file, alt, (step) => setStatus({ kind: "working", step }));
    if (result.status !== "success") return setStatus({ kind: "error", message: `Not saved: ${result.status === "error" ? result.message : ""}` });
    setStatus({ kind: "success", message: result.message });
    close();
    router.refresh();
  }

  function remove() {
    setStatus({ kind: "idle" });
    startRemove(async () => {
      const result = await removePackagePhoto(slug, packageId);
      setRemoveState(result);
      setConfirmRemove(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-start" data-testid="package-photo-editor">
      <div data-testid={current ? "package-photo-current" : "package-photo-none"}>
        <PhotoFrame url={choosing && preview ? preview : (current?.url ?? null)} alt={choosing && preview ? "" : (current?.alt ?? "")} />
      </div>
      <div className="grid content-start gap-3 text-sm">
        {current ? (
          <p className="text-muted-foreground">
            Shown on new proposals as this package&apos;s photo{current.alt !== packageName ? <>: <span className="text-foreground">{current.alt}</span></> : null}.
          </p>
        ) : (
          <p className="text-muted-foreground">No package photo yet. New proposals show the first photo of its included gear, if any.</p>
        )}

        {choosing ? (
          <form onSubmit={upload} aria-label={current ? "Replace the package photo" : "Add a package photo"} className="grid gap-3 rounded-xl border border-dashed p-4">
            <div className="grid gap-1.5">
              <Label htmlFor="package-photo-file">Photo</Label>
              <Input id="package-photo-file" ref={fileRef} type="file" accept={ACCEPT} disabled={working} onChange={(e) => void choose(e.target.files?.[0] ?? null)} aria-describedby="package-photo-rules" />
              <p id="package-photo-rules" className="text-xs text-muted-foreground">{RULES}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="package-photo-alt">Photo description (optional)</Label>
              <Input id="package-photo-alt" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} disabled={working} placeholder="Full DJ setup with lighting at a reception" />
              <p className="text-xs text-muted-foreground">For people using screen readers. The package name is used if left empty.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={working}>
                <Upload aria-hidden />
                {working ? "Saving…" : "Save photo"}
              </Button>
              <Button type="button" variant="ghost" disabled={working} onClick={close}>Cancel</Button>
            </div>
          </form>
        ) : confirmRemove ? (
          <div role="dialog" aria-label="Confirm removing the package photo" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
            <p className="font-medium">Remove this photo?</p>
            <p className="text-muted-foreground">New proposals show the included gear&apos;s photo instead. Proposals already sent keep this photo.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={remove} disabled={removing}>{removing ? "Removing…" : "Remove photo"}</Button>
              <Button type="button" variant="outline" onClick={() => setConfirmRemove(false)} disabled={removing}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => { setStatus({ kind: "idle" }); setRemoveState(idleState); setChoosing(true); }}>
              <Upload aria-hidden />
              {current ? "Replace photo" : "Add photo"}
            </Button>
            {current ? (
              <Button type="button" variant="ghost" onClick={() => { setStatus({ kind: "idle" }); setRemoveState(idleState); setConfirmRemove(true); }}>Remove photo</Button>
            ) : null}
          </div>
        )}

        {status.kind === "working" ? (
          <span role="status" className="flex items-center gap-2 text-muted-foreground">
            <progress aria-label="Upload in progress" className="h-1.5 w-24 accent-primary" />
            {STEPS[status.step]}
          </span>
        ) : status.kind === "error" ? (
          <p role="alert" className="text-destructive">{status.message}</p>
        ) : status.kind === "warning" ? (
          <p role="status" className="text-amber-700 dark:text-amber-400">{status.message}</p>
        ) : status.kind === "success" ? (
          <p role="status" className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 aria-hidden className="size-4" />
            {status.message}
          </p>
        ) : null}
        <FormMessage state={removeState} />
      </div>
    </div>
  );
}
