"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Link2, ListMusic } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isHttpsUrl, linkHost } from "@/lib/urls";
import { djRef } from "@/lib/planning/dj";
import { SongFields } from "./song-fields";
import {
  CHOICE_LABELS,
  LIST_CHOICE_LABEL,
  MAX_PLAYLISTS,
  MUSIC_HINTS,
  MUSIC_RULES,
  PLAYLIST_INTROS,
  PLAYLIST_INTRO_DEFAULT,
  checkPlaylist,
  conflictsFor,
  duplicateIds,
  emptyPlaylist,
  emptySong,
  isPlaylistUrl,
  musicAnswersFromForm,
  musicFormFromAnswers,
  playlistField,
  playlistKind,
  playlistProvider,
  playlistUrlKey,
  songField,
  type MusicAnswers,
  type MusicChoice,
  type MusicEditor as MusicEditorKind,
  type MusicForm,
  type PlaylistForm,
  type SavedList,
  type Song,
  type SongForm,
} from "@/lib/planning/music";
import type { SaveItemResult } from "@/lib/planning/view";
import { linksBySong } from "@/lib/planning/participants";
import { FieldBox, describedBy } from "./basics-editor";
import { ItemChecklist, useEditingClosed } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";
import { ChoiceFieldset, ChoiceOption, SECONDARY_CHOICES } from "./choice-list";
import { AddButton, AddDisclosure, EditToggle, ITEM_ROWS, ItemRow, RemoveButton, ReorderButtons, UndoBar } from "./item-list";

// ---------------------------------------------------------------------------
// Saved lists of the page, for play / do-not-play warnings across lists
// ---------------------------------------------------------------------------

type ListsState = {
  lists: SavedList[];
  setSongs: (itemId: string, songs: Song[]) => void;
  /** Saved introductions, for the songs they link to in Entrance music. */
  introductions: { names: string; song_id?: string }[];
  setIntroductions: (entries: { names: string; song_id?: string }[]) => void;
  /** Saved Processional people, for the Couple entrance songs they link to. */
  processionalPeople: { names: string; song_id?: string }[];
  setProcessionalPeople: (entries: { names: string; song_id?: string }[]) => void;
};
const ListsContext = createContext<ListsState | null>(null);

type Linked = { names: string; song_id?: string }[];

export function MusicListsProvider({ initial, introductions = [], processionalPeople = [], children }: {
  initial: SavedList[];
  introductions?: Linked;
  processionalPeople?: Linked;
  children: ReactNode;
}) {
  const [lists, setLists] = useState(initial);
  const [intros, setIntros] = useState(introductions);
  const [people, setPeople] = useState(processionalPeople);
  const value: ListsState = {
    lists,
    setSongs: (itemId, songs) => setLists((all) => all.map((l) => (l.itemId === itemId ? { ...l, songs } : l))),
    introductions: intros,
    setIntroductions: setIntros,
    processionalPeople: people,
    setProcessionalPeople: setPeople,
  };
  return <ListsContext.Provider value={value}>{children}</ListsContext.Provider>;
}

export function usePlanSongs() {
  return useContext(ListsContext);
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

type Props = {
  itemId: string;
  momentKey: string;
  label: string;
  editor: MusicEditorKind;
  initialAnswers: MusicAnswers;
  initialRevision: number;
  djName: string;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: MusicAnswers) => Promise<SaveItemResult>;
  disabledReason?: string;
};

const newId = () => crypto.randomUUID();


/**
 * Songs for one moment or list, typed in by hand, with autosave. Entries keep
 * a stable id (never their title or position); order is the list order. An
 * empty list stays unanswered until an explicit choice such as "No requests".
 */
export function MusicEditor(props: Props) {
  const readOnly = useEditingClosed(props.disabledReason);
  const lists = useContext(ListsContext);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<MusicForm, MusicAnswers>({
    initialForm: musicFormFromAnswers(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: (f) => musicAnswersFromForm(props.editor, f),
    save: props.save,
    readOnly,
    onSaved: (answers) => lists?.setSongs(props.itemId, (answers as MusicAnswers).songs ?? []),
  });
  // Songs linked from other moments can't be removed: Entrance music's from Introductions, Couple entrance's from Processional.
  const linked = !lists ? new Map<string, string[]>()
    : props.momentKey === "entrance_music" ? linksBySong(lists.introductions)
    : props.momentKey === "couple_entrance" ? linksBySong(lists.processionalPeople)
    : new Map<string, string[]>();
  const hint = MUSIC_HINTS[props.momentKey];

  return (
    <div className="grid gap-3" data-testid={`music-${props.momentKey}`}>
      <ItemChecklist itemId={props.itemId} title={props.label} djName={props.djName} audience={props.audience} editor={props.editor} />
      {hint ? <p data-plan-help className="text-xs text-muted-foreground">{hint}</p> : null}
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      <MusicSection
        itemId={props.itemId}
        momentKey={props.momentKey}
        label={props.label}
        editor={props.editor}
        form={form}
        update={update}
        fieldError={fieldError}
        readOnly={readOnly}
        djName={props.djName}
        audience={props.audience}
        linked={linked}
        linkedWhere={props.momentKey === "couple_entrance" ? "Processional (who walks in)" : "the grand entrance order"}
      />
      {!readOnly || saveState === "locked" ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
    </div>
  );
}

/**
 * The song list of one moment: choice, songs with move / edit / remove and
 * undo, add and paste. The caller owns the form and its autosave (a moment
 * may save songs together with other answers). Songs in `linked` can't be
 * removed until the entries pointing at them change.
 */
export function MusicSection(props: {
  itemId: string;
  momentKey: string;
  label: string;
  editor: MusicEditorKind;
  form: MusicForm;
  update: (changes: Partial<MusicForm>, clears?: string[]) => void;
  fieldError: { field: string; message: string } | null;
  readOnly: boolean;
  djName: string;
  audience: "client" | "staff";
  linked: Map<string, string[]>;
  /** Where linked entries live, for the explanation ("introductions", "who walks in"). */
  linkedWhere: string;
  /** False for a list without a choice of its own (the grand entrance's songs). */
  choices?: boolean;
}) {
  const { form, update, fieldError, readOnly } = props;
  const choices = props.choices ?? true;
  const rules = MUSIC_RULES[props.editor];
  const lists = useContext(ListsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ song: SongForm; index: number } | null>(null);
  const exclusive = choices && form.choice !== "" && form.choice !== "discuss";
  const playlists = form.playlists ?? [];
  const filled = form.songs.length > 0 || playlists.length > 0;
  const dupes = duplicateIds(form.songs);
  const conflicts = lists ? conflictsFor(props.itemId, props.editor, form.songs, lists.lists) : new Map<string, string[]>();
  const errorFor = (id: string, field: string) => (fieldError?.field === songField(id, field) ? fieldError.message : null);
  const base = `music-${props.momentKey}`;
  const notesLabel = props.editor === "moment_songs" ? "Instructions" : "Notes";
  const dj = djRef(props.audience);

  const setSongs = (songs: SongForm[], clears: string[] = []) => update({ songs }, clears);
  const songClears = (id: string) => ["songs", ...["title", "artist", "version", "link", "notes", "cue", "linked"].map((f) => songField(id, f))];

  function editSong(id: string, changes: Partial<SongForm>) {
    setSongs(form.songs.map((s) => (s.id === id ? { ...s, ...changes } : s)), songClears(id));
  }
  function move(index: number, by: -1 | 1) {
    const next = [...form.songs];
    const [song] = next.splice(index, 1);
    next.splice(index + by, 0, song);
    setSongs(next);
  }
  function remove(index: number) {
    const song = form.songs[index];
    if (props.linked.has(song.id)) return;
    setSongs(form.songs.filter((_, i) => i !== index), songClears(song.id));
    setRemoved({ song, index });
    if (editing === song.id) setEditing(null);
  }
  function undoRemove() {
    if (!removed || form.songs.some((s) => s.id === removed.song.id)) return setRemoved(null);
    const next = [...form.songs];
    next.splice(Math.min(removed.index, next.length), 0, removed.song);
    setSongs(next);
    setRemoved(null);
  }
  /** Appends complete entries; ids already present are skipped, so a doubled click adds nothing twice. */
  function append(songs: SongForm[]) {
    const present = new Set(form.songs.map((s) => s.id));
    setSongs([...form.songs, ...songs.filter((s) => !present.has(s.id))]);
  }

  return (
    <div className="grid gap-3">
      {choices ? (() => {
        const option = (choice: MusicChoice | "") => {
          const blocked = choice !== "" && choice !== "discuss" && filled;
          const text = choice === "" ? LIST_CHOICE_LABEL[props.editor] : CHOICE_LABELS[props.editor][choice]!.replace("the DJ", dj);
          return (
            <ChoiceOption
              key={choice || "list"}
              name={`${base}-choice`}
              checked={form.choice === choice}
              disabled={blocked}
              onChange={() => update({ choice }, ["choice"])}
              label={text}
              note={blocked ? (rules.playlists ? "Remove the songs and playlists to choose this." : "Remove the songs to choose this.") : undefined}
              secondary={SECONDARY_CHOICES.includes(choice)}
            />
          );
        };
        const all = ["", ...rules.choices] as (MusicChoice | "")[];
        return (
          <ChoiceFieldset
            legend={props.editor === "moment_songs" && props.momentKey === "processional" ? "Music for the processional (needed)" : "Your answer (needed)"}
            disabled={readOnly}
            secondary={all.some((c) => SECONDARY_CHOICES.includes(c)) ? all.filter((c) => SECONDARY_CHOICES.includes(c)).map(option) : undefined}
            after={
              <>
                {fieldError?.field === "choice" ? <p className="text-xs font-medium text-destructive">{fieldError.message}</p> : null}
                {form.choice === "not_applicable" ? <p className="text-xs text-plan-ink-2">The moment stays in your plan; only {dj} can remove it.</p> : null}
              </>
            }
          >
            {all.filter((c) => !SECONDARY_CHOICES.includes(c)).map(option)}
          </ChoiceFieldset>
        );
      })() : null}

      {rules.playlists ? (
        <PlaylistSection
          base={base}
          intro={PLAYLIST_INTROS[props.momentKey] ?? PLAYLIST_INTRO_DEFAULT}
          label={props.label}
          playlists={playlists}
          canAdd={!exclusive}
          readOnly={readOnly}
          dj={dj}
          fieldError={fieldError}
          onChange={(next, clears) => update({ playlists: next }, clears)}
        />
      ) : null}

      {form.songs.length > 0 ? (
        <ol className={ITEM_ROWS} aria-label={`Songs: ${props.label}`}>
          {form.songs.map((s, index) => {
            const name = s.title.trim() || "Untitled song";
            const conflict = conflicts.get(s.id);
            const linkedTo = props.linked.get(s.id);
            const open = editing === s.id || [...songClears(s.id)].some((f) => f !== songField(s.id, "linked") && fieldError?.field === f);
            const link = s.link.trim();
            return (
              <ItemRow
                key={s.id}
                testId="song-row"
                summary={
                  <>
                    {s.cue.trim() ? <p className="text-xs font-medium text-plan-ink-2 [overflow-wrap:anywhere]">{s.cue}</p> : null}
                    <p className="text-[0.9375rem] leading-snug font-medium [overflow-wrap:anywhere]">
                      <span className="font-normal text-plan-ink-2 tabular-nums">{index + 1}. </span>
                      {name}
                      {s.artist.trim() ? <span className="font-normal text-plan-ink-2"> by {s.artist}</span> : null}
                    </p>
                    {s.version.trim() || (link && isHttpsUrl(link)) ? (
                      <p className="flex flex-wrap items-center gap-x-3 text-xs text-plan-ink-2">
                        {s.version.trim() ? <span className="[overflow-wrap:anywhere]">Version: {s.version}</span> : null}
                        {link && isHttpsUrl(link) ? (
                          <a className="inline-flex items-center gap-1 rounded-sm underline underline-offset-2 max-sm:min-h-11" href={link} target="_blank" rel="noopener noreferrer nofollow">
                            <Link2 aria-hidden className="size-3.5 shrink-0" />
                            Open link ({linkHost(link)})
                          </a>
                        ) : null}
                      </p>
                    ) : null}
                    {s.notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">{notesLabel}: {s.notes}</p> : null}
                    {linkedTo ? <p className="text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Linked to: {linkedTo.join(", ")}</p> : null}
                    {dupes.has(s.id) ? <p className="text-xs text-status-attention">Possible duplicate: the same title and artist appear earlier in this list.</p> : null}
                    {conflict ? (
                      <p className="text-xs text-status-attention">
                        {props.editor === "music_exclusions" ? "Also listed to play in " : "Also listed under "}
                        {conflict.join(", ")}. Check which one is right; nothing was changed.
                      </p>
                    ) : null}
                    {errorFor(s.id, "linked") ? <p role="alert" className="text-xs font-medium text-destructive">{errorFor(s.id, "linked")}</p> : null}
                  </>
                }
                actions={!readOnly ? (
                  <>
                    <ReorderButtons name={name} index={index} count={form.songs.length} onMove={(by) => move(index, by)} />
                    <EditToggle editing={editing === s.id} name={name} onToggle={() => setEditing(editing === s.id ? null : s.id)} />
                  </>
                ) : null}
                panel={open && !readOnly ? (
                  <>
                    <SongFields
                      idPrefix={`${base}-${s.id}`}
                      song={s}
                      cue={rules.cue}
                      notes={notesLabel}
                      errorFor={(field) => errorFor(s.id, field)}
                      onChange={(changes) => editSong(s.id, changes)}
                    />
                    {linkedTo ? (
                      <p className="text-xs text-plan-ink-2">To remove this song, first choose another song (or none) for {linkedTo.length === 1 ? "that entry" : "those entries"} in {props.linkedWhere}.</p>
                    ) : null}
                    <RemoveButton name={name} disabled={Boolean(linkedTo)} onClick={() => remove(index)} />
                  </>
                ) : null}
              />
            );
          })}
        </ol>
      ) : null}
      {removed ? <UndoBar onUndo={undoRemove}>Removed &ldquo;{removed.song.title || "Untitled song"}&rdquo;.</UndoBar> : null}

      {readOnly ? null : exclusive ? (
        <p className="text-xs text-muted-foreground">To add {rules.playlists ? "songs or playlists" : "songs"}, choose &ldquo;{LIST_CHOICE_LABEL[props.editor]}&rdquo; above.</p>
      ) : form.songs.length >= rules.maxSongs ? (
        <p className="text-xs text-muted-foreground">This list has the maximum of {rules.maxSongs} songs.</p>
      ) : (
        <AddSong base={base} editor={props.editor} notesLabel={notesLabel} onAdd={(song) => { append([song]); setRemoved(null); }} />
      )}
      {fieldError?.field === "songs" ? <p role="alert" className="text-xs text-destructive">{fieldError.message}</p> : null}
      {/* A removal the server refused for a link (another tab linked it): the song is no longer listed here to show it on. */}
      {fieldError?.field.endsWith(":linked") && !form.songs.some((s) => fieldError.field === songField(s.id, "linked")) ? (
        <p role="alert" className="text-sm text-destructive">{fieldError.message} {removed ? "Use Undo to put the song back." : "Reload to see it again."}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlist links (list editors only)
// ---------------------------------------------------------------------------

/**
 * Playlists the client made in another app, shared by link: add, edit and
 * remove (with undo), in the order added. Links are never opened or checked
 * here; the service name comes from the link's host name, for display only.
 * Changes go through the same form and autosave as the songs.
 */
function PlaylistSection({ base, intro, label, playlists, canAdd, readOnly, dj, fieldError, onChange }: {
  base: string;
  intro: string;
  label: string;
  playlists: PlaylistForm[];
  canAdd: boolean;
  readOnly: boolean;
  dj: string;
  fieldError: { field: string; message: string } | null;
  onChange: (playlists: PlaylistForm[], clears: string[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ playlist: PlaylistForm; index: number } | null>(null);
  const errorFor = (id: string, field: string) => (fieldError?.field === playlistField(id, field) ? fieldError.message : null);
  const clears = (id: string) => ["playlists", ...["url", "label", "notes"].map((f) => playlistField(id, f))];
  const hasError = (id: string) => fieldError?.field.startsWith(`playlist:${id}:`) ?? false;

  function edit(id: string, changes: Partial<PlaylistForm>) {
    onChange(playlists.map((p) => (p.id === id ? { ...p, ...changes } : p)), clears(id));
  }
  function remove(index: number) {
    const playlist = playlists[index];
    onChange(playlists.filter((_, i) => i !== index), clears(playlist.id));
    setRemoved({ playlist, index });
    if (editing === playlist.id) setEditing(null);
  }
  function undoRemove() {
    if (!removed || playlists.some((p) => p.id === removed.playlist.id) || playlists.length >= MAX_PLAYLISTS) return setRemoved(null);
    const next = [...playlists];
    next.splice(Math.min(removed.index, next.length), 0, removed.playlist);
    onChange(next, []);
    setRemoved(null);
  }

  if (readOnly && playlists.length === 0) return null;
  return (
    <div className="grid gap-3" data-testid={`${base}-playlists`}>
      {playlists.length > 0 ? (
        <ul className={ITEM_ROWS} aria-label={`Playlists: ${label}`}>
          {playlists.map((p, index) => {
            const url = p.url.trim();
            const valid = isPlaylistUrl(url);
            const provider = valid ? playlistProvider(url) : null;
            const name = p.label.trim() || playlistKind(url);
            return (
              <ItemRow
                key={p.id}
                testId="playlist-row"
                summary={
                  <>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-plan-ink-2 [overflow-wrap:anywhere]">
                      <ListMusic aria-hidden className="size-3.5 shrink-0" />
                      {playlistKind(url)}
                      {valid && !provider ? <span className="font-normal"> · {new URL(url).hostname}</span> : null}
                    </p>
                    {p.label.trim() ? <p className="text-[0.9375rem] leading-snug font-medium [overflow-wrap:anywhere]">{p.label}</p> : null}
                    {p.notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Notes: {p.notes}</p> : null}
                    {valid ? (
                      <a
                        className="inline-flex w-fit items-center gap-1 rounded-sm text-xs font-medium text-brand-ink underline underline-offset-2 max-sm:min-h-11"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        aria-label={`Open playlist "${name}" (opens ${provider ?? new URL(url).hostname})`}
                      >
                        <ExternalLink aria-hidden className="size-3.5" />
                        Open playlist
                      </a>
                    ) : null}
                  </>
                }
                actions={!readOnly ? <EditToggle editing={editing === p.id} name={name} noun="playlist" onToggle={() => setEditing(editing === p.id ? null : p.id)} /> : null}
                panel={!readOnly && (editing === p.id || hasError(p.id)) ? (
                  <>
                    <PlaylistFields idPrefix={`${base}-${p.id}`} playlist={p} dj={dj} errorFor={(field) => errorFor(p.id, field)} onChange={(changes) => edit(p.id, changes)} />
                    <RemoveButton name={name} noun="playlist" onClick={() => remove(index)} />
                  </>
                ) : null}
              />
            );
          })}
        </ul>
      ) : null}
      {removed ? (
        <UndoBar onUndo={undoRemove}>Removed &ldquo;{removed.playlist.label.trim() || playlistKind(removed.playlist.url.trim())}&rdquo;.</UndoBar>
      ) : null}
      {fieldError?.field === "playlists" ? <p role="alert" className="text-xs font-medium text-destructive">{fieldError.message}</p> : null}
      {readOnly || !canAdd ? null : playlists.length >= MAX_PLAYLISTS ? (
        <p className="text-xs text-plan-ink-2">This list has the maximum of {MAX_PLAYLISTS} playlists.</p>
      ) : (
        <AddPlaylist base={base} dj={dj} intro={intro} playlists={playlists} onAdd={(playlist) => { onChange([...playlists, playlist], ["playlists"]); setRemoved(null); }} />
      )}
    </div>
  );
}

function PlaylistFields({ idPrefix, playlist, dj, errorFor, onChange }: {
  idPrefix: string;
  playlist: PlaylistForm;
  dj: string;
  errorFor: (field: string) => string | null;
  onChange: (changes: Partial<PlaylistForm>) => void;
}) {
  const id = (f: string) => `${idPrefix}-playlist-${f}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FieldBox id={id("url")} label="Playlist link" error={errorFor("url")} hint={`Make sure it's shared or public so ${dj} can open it.`} className="col-span-full">
        <Input id={id("url")} type="url" inputMode="url" autoComplete="off" value={playlist.url} onChange={(e) => onChange({ url: e.target.value })}
          aria-invalid={Boolean(errorFor("url"))} aria-describedby={describedBy(id("url"), errorFor("url"), "hint")} />
      </FieldBox>
      <FieldBox id={id("label")} label="Playlist name (optional)" error={errorFor("label")} className="col-span-full">
        <Input id={id("label")} value={playlist.label} onChange={(e) => onChange({ label: e.target.value })}
          aria-invalid={Boolean(errorFor("label"))} aria-describedby={describedBy(id("label"), errorFor("label"))} />
      </FieldBox>
      <FieldBox id={id("notes")} label="Playlist notes (optional)" error={errorFor("notes")} className="col-span-full" hint="For example the mood, or which songs matter most.">
        <Textarea id={id("notes")} rows={2} value={playlist.notes} onChange={(e) => onChange({ notes: e.target.value })}
          aria-invalid={Boolean(errorFor("notes"))} aria-describedby={describedBy(id("notes"), errorFor("notes"), "hint")} />
      </FieldBox>
    </div>
  );
}

/** A playlist joins the list only once its link is complete, so the list never holds half-typed links. */
function AddPlaylist({ base, dj, intro, playlists, onAdd }: { base: string; dj: string; intro: string; playlists: PlaylistForm[]; onAdd: (playlist: PlaylistForm) => void }) {
  const [draft, setDraft] = useState<PlaylistForm>(() => emptyPlaylist(newId()));
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const id = (f: string) => `${base}-new-playlist-${f}`;
  const errorFor = (field: string) => (error?.field === field ? error.message : null);
  function add() {
    const checked = checkPlaylist(draft);
    if (!checked.ok) {
      setError({ field: checked.field.split(":").pop() ?? "", message: checked.message });
      return;
    }
    const key = playlistUrlKey(checked.playlist.url);
    if (playlists.some((p) => playlistUrlKey(p.url) === key)) {
      setError({ field: "url", message: "This playlist is already added here." });
      return;
    }
    onAdd({ ...draft, url: checked.playlist.url, label: checked.playlist.label ?? "", notes: "" });
    setDraft(emptyPlaylist(newId()));
    setError(null);
    urlRef.current?.focus();
  }
  return (
    <AddDisclosure testId={`${base}-add-playlist`} label="Add a playlist link">
      <p className="text-sm text-plan-ink-2">{intro}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldBox id={id("url")} label="Playlist link" error={errorFor("url")} className="col-span-full"
          hint={`Paste a link from Spotify, Apple Music or your favourite music app. Make sure it's shared or public so ${dj} can open it.`}>
          <Input ref={urlRef} id={id("url")} type="url" inputMode="url" autoComplete="off" placeholder="https://" value={draft.url}
            onChange={(e) => { setDraft((d) => ({ ...d, url: e.target.value })); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            aria-invalid={Boolean(errorFor("url"))} aria-describedby={describedBy(id("url"), errorFor("url"), "hint")} />
        </FieldBox>
        <FieldBox id={id("label")} label="Playlist name (optional)" error={errorFor("label")} className="col-span-full" hint="Notes can be added after, with Edit.">
          <Input id={id("label")} value={draft.label}
            onChange={(e) => { setDraft((d) => ({ ...d, label: e.target.value })); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            aria-invalid={Boolean(errorFor("label"))} aria-describedby={describedBy(id("label"), errorFor("label"), "hint")} />
        </FieldBox>
      </div>
      <AddButton onClick={add}>Add playlist</AddButton>
    </AddDisclosure>
  );
}

/** A complete song is added in one step, so the list never holds half-typed entries. */
function AddSong({ base, editor, notesLabel, onAdd }: { base: string; editor: MusicEditorKind; notesLabel: string; onAdd: (song: SongForm) => void }) {
  const [song, setSong] = useState<SongForm>(() => emptySong(newId()));
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  function add() {
    const checked = musicAnswersFromForm(editor, { songs: [song], choice: "" });
    if (!checked.ok) {
      setError({ field: checked.field.split(":").pop() ?? "", message: checked.message });
      return;
    }
    onAdd(song);
    setSong(emptySong(newId()));
    setError(null);
    titleRef.current?.querySelector("input")?.focus();
  }
  return (
    <AddDisclosure testId={`${base}-add`} label="Add a song">
      <div ref={titleRef}>
        <SongFields
          idPrefix={`${base}-new`}
          song={song}
          cue={MUSIC_RULES[editor].cue}
          notes={notesLabel}
          errorFor={(field) => (error?.field === field ? error.message : null)}
          onChange={(changes) => {
            setSong((s) => ({ ...s, ...changes }));
            setError(null);
          }}
        />
      </div>
      <AddButton onClick={add}>Add song</AddButton>
    </AddDisclosure>
  );
}
