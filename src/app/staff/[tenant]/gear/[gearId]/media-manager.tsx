"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Film } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ActionForm, FormMessage } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import { idleState, type ActionState } from "@/lib/forms";
import { moveMedia, setMediaActive, updateMedia } from "../actions";

export type ManagedMedia = { id: string; url: string | null; kind: string; contentType: string; alt: string; active: boolean };

/**
 * Every photo and video of the item, in proposal order, with Move
 * earlier/later, Archive/Restore and the description. Archiving only hides
 * one from new proposals: the stored file stays, so sent offers still show it.
 */
export function MediaManager({ slug, gearId, media }: { slug: string; gearId: string; media: ManagedMedia[] }) {
  const firstActive = media.find((m) => m.active)?.id;
  return (
    <ol aria-label="Photos and videos, in proposal order" className="grid gap-3" data-testid="media-list">
      {media.map((m, i) => (
        <MediaRow key={m.id} slug={slug} gearId={gearId} media={m} position={i} count={media.length} first={m.id === firstActive} />
      ))}
    </ol>
  );
}

function MediaRow({ slug, gearId, media: m, position, count, first }: { slug: string; gearId: string; media: ManagedMedia; position: number; count: number; first: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const label = m.kind === "video" ? "video" : "photo";

  function run(task: () => Promise<ActionState>) {
    start(async () => {
      const result = await task();
      setState(result);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <li data-testid="media-item" className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-muted">
        {m.url && m.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
          <img src={m.url} alt={m.alt} loading="lazy" className={`max-h-full max-w-full object-contain ${m.active ? "" : "opacity-50"}`} />
        ) : m.url ? (
          <video src={m.url} controls playsInline preload="metadata" aria-label={m.alt} className={`max-h-full max-w-full ${m.active ? "" : "opacity-50"}`} />
        ) : (
          <Film aria-hidden className="size-6 text-muted-foreground" />
        )}
      </div>
      <div className="grid min-w-0 content-start gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{position + 1} of {count}</span>
          <Badge variant="outline">{m.kind === "video" ? "Video" : "Photo"} · {m.contentType.split("/")[1]?.toUpperCase()}</Badge>
          {first ? <Badge variant="secondary">Shown first</Badge> : null}
          {m.active ? null : <Badge variant="secondary">Archived · hidden from new proposals</Badge>}
        </div>
        <ActionForm action={updateMedia.bind(null, slug, gearId, m.id)} submitLabel="Save description" variant="outline" inline>
          <TextField
            label={`Description of ${label} ${position + 1} (alt text)`}
            name="alt_text"
            id={`alt-${m.id}`}
            defaultValue={m.alt}
            maxLength={300}
            required
            className="min-w-0 flex-1 basis-60"
          />
        </ActionForm>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${label} ${position + 1} earlier`} disabled={pending || position === 0} onClick={() => run(() => moveMedia(slug, gearId, m.id, "earlier"))}>
            <ArrowUp aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label={`Move ${label} ${position + 1} later`} disabled={pending || position === count - 1} onClick={() => run(() => moveMedia(slug, gearId, m.id, "later"))}>
            <ArrowDown aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setMediaActive(slug, gearId, m.id, !m.active))}>
            {m.active ? `Archive ${label}` : `Restore ${label}`}
          </Button>
          <FormMessage state={state} />
        </div>
      </div>
    </li>
  );
}
