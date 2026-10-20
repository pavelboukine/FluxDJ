"use client";

import { Button } from "@/components/ui/button";
import { selectClass } from "@/components/app/fields";
import { emptyNewSong, songLabel, type NewSongForm } from "@/lib/planning/participants";
import { FieldBox, describedBy } from "./basics-editor";
import { SongFields } from "./song-fields";

/** The picker's fields, as an entry's errors name them. */
export type SongPickerField = "song_id" | "song_title" | "song_artist" | "song_version" | "song_link" | "song_notes";

export type SongOption = { id: string; title: string; artist: string; cue?: string };
export type SongGroup = { label: string; songs: SongOption[] };

const NEW = "new";

/**
 * Choosing an entry's song where the entry is edited: one of the songs
 * already listed (so several entries can share one), a new song typed in
 * right here (title, artist, version, link and playback instructions, as
 * in the songs list), or none yet. A new song is only a draft (`draft`) until the
 * caller adds it to its song list together with the link, in one change:
 * when the entry is added, or with "Use this song" (`onUseDraft`) for an
 * entry already listed. Nothing is saved half-linked.
 */
export function SongPicker({ id, label, value, groups, draft, onSelect, onDraft, onUseDraft, sharedWith, sharedText = "Also walking to this song", errorFor, missingText, hint }: {
  id: string;
  label: string;
  /** The linked song id, or "". */
  value: string;
  groups: SongGroup[];
  draft: NewSongForm | null;
  onSelect: (songId: string) => void;
  onDraft: (draft: NewSongForm | null) => void;
  /** For an entry already listed: adds the draft to the list and links it. */
  onUseDraft?: () => void;
  /** Other entries linked to the chosen song. */
  sharedWith: string[];
  /** How sharing reads: "Also walking to this song", "Also entering to this song". */
  sharedText?: string;
  errorFor: (field: SongPickerField) => string | null;
  missingText: string;
  hint?: string;
}) {
  const all = groups.flatMap((g) => g.songs);
  const missing = value !== "" && !draft && !all.some((s) => s.id === value);
  const selectHint = missing ? missingText : hint;
  return (
    <div className="col-span-full grid gap-3" data-testid="song-picker">
      <FieldBox id={id} label={label} error={errorFor("song_id")} hint={selectHint}>
        <select
          id={id}
          className={selectClass}
          value={draft ? NEW : value}
          aria-describedby={describedBy(id, errorFor("song_id"), selectHint)}
          onChange={(e) => {
            if (e.target.value === NEW) return onDraft(emptyNewSong(crypto.randomUUID()));
            onDraft(null);
            onSelect(e.target.value);
          }}
        >
          <option value="">No song yet</option>
          {missing ? <option value={value}>Linked song not in the active plan</option> : null}
          {groups.filter((g) => g.songs.length > 0).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.songs.map((s) => <option key={s.id} value={s.id}>{songLabel(s)}</option>)}
            </optgroup>
          ))}
          <option value={NEW}>Enter a new song…</option>
        </select>
      </FieldBox>
      {!draft && value && sharedWith.length > 0 ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{sharedText}: {sharedWith.join(", ")}.</p>
      ) : null}
      {draft ? (
        <fieldset className="grid gap-3 rounded-lg border bg-muted/20 p-3">
          <legend className="sr-only">New song</legend>
          <SongFields
            idPrefix={id}
            song={{ ...draft, version: draft.version ?? "", link: draft.link ?? "" }}
            inline
            notes="Playback instructions"
            notesHint='For example "start at 0:45" or "fade out once everyone is in place".'
            errorFor={(f) => (f === "cue" ? null : errorFor(`song_${f}`))}
            onChange={(changes) => onDraft({ ...draft, ...changes, use: false })}
          />
          {onUseDraft ? (
            <div className="col-span-full flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={onUseDraft}>Use this song</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => onDraft(null)}>Cancel</Button>
            </div>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
