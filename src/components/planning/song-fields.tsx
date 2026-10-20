"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldBox, describedBy } from "./basics-editor";

/** The details of one song as a form: every field a string (empty when unset). */
export type SongDetails = { title: string; artist: string; version: string; link: string; notes?: string; cue?: string };
export type SongDetailField = keyof SongDetails;

export const SONG_LINK_HINT = "An https:// link (Spotify, Apple Music, YouTube or any other site) to help the DJ find the exact version. It's never opened automatically.";

/**
 * The fields of one song, wherever a client types one in: a music list or
 * moment (Title, Artist), with a person in the Processional or grand
 * entrance, or with an activity or dedication (`inline`: Song title, Song
 * link). Title and artist, then cue when the editor has one, version, link
 * and notes when it keeps them; the same labels, hints and order everywhere.
 */
export function SongFields({ idPrefix, song, inline = false, cue = false, notes, notesHint, errorFor, onChange }: {
  idPrefix: string;
  song: SongDetails;
  /** Fields typed in with something else (a person, an activity): "Song title", "Song link". */
  inline?: boolean;
  cue?: boolean;
  /** The notes' label ("Instructions", "Playback instructions"), or omitted when the song keeps none. */
  notes?: string;
  notesHint?: string;
  errorFor: (field: SongDetailField) => string | null;
  onChange: (changes: Partial<SongDetails>) => void;
}) {
  const field = (name: SongDetailField, label: string, opts: { hint?: string; rows?: number; wide?: boolean; url?: boolean } = {}) => {
    const fieldId = `${idPrefix}-${name}`;
    const describe = describedBy(fieldId, errorFor(name), opts.hint);
    const value = song[name] ?? "";
    return (
      <FieldBox id={fieldId} label={label} error={errorFor(name)} hint={opts.hint} className={opts.rows || opts.wide ? "col-span-full" : undefined}>
        {opts.rows ? (
          <Textarea id={fieldId} rows={opts.rows} value={value} onChange={(e) => onChange({ [name]: e.target.value })} aria-invalid={Boolean(errorFor(name))} aria-describedby={describe} />
        ) : (
          <Input id={fieldId} inputMode={opts.url ? "url" : undefined} autoComplete={opts.url ? "off" : undefined} spellCheck={opts.url ? false : undefined}
            value={value} onChange={(e) => onChange({ [name]: e.target.value })} aria-invalid={Boolean(errorFor(name))} aria-describedby={describe} />
        )}
      </FieldBox>
    );
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* Title and artist side by side, then what it's for: the cue never splits them. */}
      {field("title", inline ? "Song title" : "Title")}
      {field("artist", "Artist")}
      {cue ? field("cue", "Cue (optional)", { hint: 'For example "Partner entrance" or "Dance with grandmother".', wide: true }) : null}
      {field("version", "Version (optional)", { hint: "For example acoustic, clean, live, a remix or an instrumental." })}
      {field("link", inline ? "Song link (optional)" : "Link (optional)", { hint: SONG_LINK_HINT, url: true })}
      {notes ? field("notes", `${notes} (optional)`, { rows: 2, hint: notesHint ?? (cue ? "For example: start at 0:45, fade after the chorus, play fully." : undefined) }) : null}
    </div>
  );
}
