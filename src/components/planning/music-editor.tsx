"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isHttpsUrl, linkHost } from "@/lib/payments";
import {
  CHOICE_LABELS,
  LIST_CHOICE_LABEL,
  MUSIC_HINTS,
  MUSIC_RULES,
  PASTE_MAX_LINES,
  conflictsFor,
  duplicateIds,
  emptySong,
  musicAnswersFromForm,
  musicFormFromAnswers,
  parsePastedList,
  pastedRowProblem,
  songField,
  type MusicAnswers,
  type MusicChoice,
  type MusicEditor as MusicEditorKind,
  type MusicForm,
  type PastedRow,
  type SavedList,
  type Song,
  type SongForm,
} from "@/lib/planning/music";
import type { SaveItemResult } from "@/lib/planning/view";
import { linksBySong } from "@/lib/planning/participants";
import { FieldBox } from "./basics-editor";
import { ItemChecklist } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

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
  const readOnly = Boolean(props.disabledReason);
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
      <ItemChecklist itemId={props.itemId} title={props.label} djName={props.djName} audience={props.audience} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
        linkedWhere={props.momentKey === "couple_entrance" ? "Processional (who walks in)" : "Introductions"}
      />
      {!readOnly ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
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
}) {
  const { form, update, fieldError, readOnly } = props;
  const rules = MUSIC_RULES[props.editor];
  const lists = useContext(ListsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ song: SongForm; index: number } | null>(null);
  const exclusive = form.choice !== "" && form.choice !== "discuss";
  const dupes = duplicateIds(form.songs);
  const conflicts = lists ? conflictsFor(props.itemId, props.editor, form.songs, lists.lists) : new Map<string, string[]>();
  const errorFor = (id: string, field: string) => (fieldError?.field === songField(id, field) ? fieldError.message : null);
  const base = `music-${props.momentKey}`;
  const notesLabel = props.editor === "moment_songs" ? "Instructions" : "Notes";
  const dj = props.audience === "client" ? props.djName : "the DJ";

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
      <fieldset disabled={readOnly} className="grid gap-1">
        <legend className="mb-1 text-sm font-medium">{props.editor === "moment_songs" && props.momentKey === "processional" ? "Songs (needed)" : "Your answer (needed)"}</legend>
        {(["", ...rules.choices] as (MusicChoice | "")[]).map((choice) => {
          const blocked = choice !== "" && choice !== "discuss" && form.songs.length > 0;
          const text = choice === "" ? LIST_CHOICE_LABEL[props.editor] : CHOICE_LABELS[props.editor][choice]!.replace("the DJ", dj);
          return (
            <label key={choice || "list"} className="flex min-h-9 items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${base}-choice`}
                className="mt-0.5 size-4 accent-primary"
                checked={form.choice === choice}
                disabled={blocked}
                onChange={() => update({ choice }, ["choice"])}
              />
              <span>
                {text}
                {blocked ? <span className="block text-xs text-muted-foreground">Remove the songs to choose this.</span> : null}
              </span>
            </label>
          );
        })}
        {fieldError?.field === "choice" ? <p className="text-xs text-destructive">{fieldError.message}</p> : null}
        {form.choice === "not_applicable" ? (
          <p className="text-xs text-muted-foreground">The moment stays in your plan; only {props.djName} can remove it.</p>
        ) : null}
      </fieldset>

      {form.songs.length > 0 ? (
        <ol className="grid gap-2" aria-label={`Songs: ${props.label}`}>
          {form.songs.map((s, index) => {
            const name = s.title.trim() || "Untitled song";
            const conflict = conflicts.get(s.id);
            const linkedTo = props.linked.get(s.id);
            return (
              <li key={s.id} className="grid gap-2 rounded-lg border p-3" data-testid="song-row">
                <div className="grid min-w-0 gap-0.5">
                  {s.cue.trim() ? <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground [overflow-wrap:anywhere]">{s.cue}</p> : null}
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {index + 1}. {name}
                    {s.artist.trim() ? <span className="font-normal"> by {s.artist}</span> : null}
                  </p>
                  {s.version.trim() ? <p className="text-xs [overflow-wrap:anywhere]">Version: {s.version}</p> : null}
                  {s.notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">{notesLabel}: {s.notes}</p> : null}
                  {s.link.trim() && isHttpsUrl(s.link.trim()) ? (
                    <a className="w-fit text-xs underline" href={s.link.trim()} target="_blank" rel="noopener noreferrer nofollow">
                      Open link ({linkHost(s.link.trim())})
                    </a>
                  ) : null}
                  {linkedTo ? <p className="text-xs [overflow-wrap:anywhere]">Linked to: {linkedTo.join(", ")}</p> : null}
                  {dupes.has(s.id) ? <p className="text-xs text-amber-700 dark:text-amber-400">Possible duplicate: the same title and artist appear earlier in this list.</p> : null}
                  {conflict ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {props.editor === "music_exclusions" ? "Also listed to play in " : "Also listed under "}
                      {conflict.join(", ")}. Check which one is right; nothing was changed.
                    </p>
                  ) : null}
                  {errorFor(s.id, "linked") ? <p role="alert" className="text-xs text-destructive">{errorFor(s.id, "linked")}</p> : null}
                </div>
                {!readOnly ? (
                  <div className="flex flex-wrap gap-1">
                    <Button type="button" size="sm" variant="outline" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move "${name}" up`}>Move up</Button>
                    <Button type="button" size="sm" variant="outline" disabled={index === form.songs.length - 1} onClick={() => move(index, 1)} aria-label={`Move "${name}" down`}>Move down</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditing(editing === s.id ? null : s.id)} aria-expanded={editing === s.id} aria-label={`${editing === s.id ? "Done editing" : "Edit"} "${name}"`}>
                      {editing === s.id ? "Done" : "Edit"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={Boolean(linkedTo)} onClick={() => remove(index)} aria-label={`Remove "${name}"`}>Remove</Button>
                  </div>
                ) : null}
                {linkedTo && !readOnly ? (
                  <p className="text-xs text-muted-foreground">To remove this song, first choose another song (or none) for {linkedTo.length === 1 ? "that entry" : "those entries"} in {props.linkedWhere}.</p>
                ) : null}
                {editing === s.id || [...songClears(s.id)].some((f) => f !== songField(s.id, "linked") && fieldError?.field === f) ? (
                  <SongFields
                    idPrefix={`${base}-${s.id}`}
                    song={s}
                    cue={rules.cue}
                    notesLabel={notesLabel}
                    errorFor={(field) => errorFor(s.id, field)}
                    onChange={(changes) => editSong(s.id, changes)}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {removed ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm">
          Removed &ldquo;{removed.song.title || "Untitled song"}&rdquo;.
          <Button type="button" size="sm" variant="outline" onClick={undoRemove}>Undo</Button>
        </p>
      ) : null}

      {readOnly ? null : exclusive ? (
        <p className="text-xs text-muted-foreground">To add songs, choose &ldquo;{LIST_CHOICE_LABEL[props.editor]}&rdquo; above.</p>
      ) : form.songs.length >= rules.maxSongs ? (
        <p className="text-xs text-muted-foreground">This list has the maximum of {rules.maxSongs} songs.</p>
      ) : (
        <>
          <AddSong base={base} editor={props.editor} notesLabel={notesLabel} onAdd={(song) => { append([song]); setRemoved(null); }} />
          {rules.paste ? <PasteList base={base} room={rules.maxSongs - form.songs.length} onImport={(songs) => { append(songs); setRemoved(null); }} /> : null}
        </>
      )}
      {fieldError?.field === "songs" ? <p role="alert" className="text-xs text-destructive">{fieldError.message}</p> : null}
      {/* A removal the server refused for a link (another tab linked it): the song is no longer listed here to show it on. */}
      {fieldError?.field.endsWith(":linked") && !form.songs.some((s) => fieldError.field === songField(s.id, "linked")) ? (
        <p role="alert" className="text-sm text-destructive">{fieldError.message} {removed ? "Use Undo to put the song back." : "Reload to see it again."}</p>
      ) : null}
    </div>
  );
}

function SongFields({ idPrefix, song, cue, notesLabel, errorFor, onChange }: {
  idPrefix: string;
  song: SongForm;
  cue: boolean;
  notesLabel: string;
  errorFor: (field: string) => string | null;
  onChange: (changes: Partial<SongForm>) => void;
}) {
  const field = (name: keyof SongForm, label: string, opts: { hint?: string; rows?: number; inputMode?: "url" } = {}) => (
    <FieldBox id={`${idPrefix}-${name}`} label={label} error={errorFor(name)} hint={opts.hint} className={opts.rows ? "sm:col-span-2" : undefined}>
      {opts.rows ? (
        <Textarea id={`${idPrefix}-${name}`} rows={opts.rows} value={song[name]} onChange={(e) => onChange({ [name]: e.target.value })} aria-invalid={Boolean(errorFor(name))} />
      ) : (
        <Input id={`${idPrefix}-${name}`} inputMode={opts.inputMode} value={song[name]} onChange={(e) => onChange({ [name]: e.target.value })} aria-invalid={Boolean(errorFor(name))} />
      )}
    </FieldBox>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cue ? field("cue", "Cue (optional)", { hint: 'For example "Partner entrance" or "Dance with grandmother".' }) : null}
      {field("title", "Title")}
      {field("artist", "Artist")}
      {field("version", "Version (optional)", { hint: "For example acoustic, clean, live or a particular recording." })}
      {field("link", "Link (optional)", { hint: "An https:// link to help the DJ find it. It's never opened automatically.", inputMode: "url" })}
      {field("notes", `${notesLabel} (optional)`, { rows: 2, hint: cue ? "For example: start at 0:45, fade after the chorus, play fully." : undefined })}
    </div>
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
    <details className="rounded-lg border p-3" data-testid={`${base}-add`}>
      <summary className="cursor-pointer text-sm font-medium">Add a song</summary>
      <div ref={titleRef} className="mt-3 grid gap-3">
        <SongFields
          idPrefix={`${base}-new`}
          song={song}
          cue={MUSIC_RULES[editor].cue}
          notesLabel={notesLabel}
          errorFor={(field) => (error?.field === field ? error.message : null)}
          onChange={(changes) => {
            setSong((s) => ({ ...s, ...changes }));
            setError(null);
          }}
        />
        <Button type="button" size="sm" className="w-fit" onClick={add}>Add song</Button>
      </div>
    </details>
  );
}

/** "Paste a list": preview, correct, then import through the same validation and save as typed entries. */
function PasteList({ base, room, onImport }: { base: string; room: number; onImport: (songs: SongForm[]) => void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<PastedRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const included = rows?.filter((r) => r.include) ?? [];
  const problems = included.filter((r) => pastedRowProblem(r) !== null).length;
  const tooMany = included.length > room;

  function preview() {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    if (lines > PASTE_MAX_LINES) {
      setNotice(`Paste ${PASTE_MAX_LINES} lines or fewer at a time.`);
      return;
    }
    const parsed = parsePastedList(text, newId);
    setRows(parsed.length ? parsed : null);
    setNotice(parsed.length ? null : "Nothing to import: paste one song per line.");
  }
  function setRow(id: string, changes: Partial<PastedRow>) {
    setRows((all) => all?.map((r) => (r.id === id ? { ...r, ...changes } : r)) ?? null);
  }
  function importRows() {
    if (!rows || problems > 0 || tooMany || included.length === 0) return;
    // The preview's ids go into the list, then the preview closes: a second click has nothing left to add.
    onImport(included.map((r) => ({ ...emptySong(r.id), title: r.title.trim(), artist: r.artist.trim() })));
    setRows(null);
    setText("");
    setNotice(`Imported ${included.length} ${included.length === 1 ? "song" : "songs"}. They save automatically.`);
  }

  return (
    <details className="rounded-lg border p-3" data-testid={`${base}-paste`}>
      <summary className="cursor-pointer text-sm font-medium">Paste a list</summary>
      <div className="mt-3 grid gap-3">
        <FieldBox id={`${base}-paste-text`} label="One song per line, as Artist - Title" error={null} hint='For example "Daft Punk - One More Time". Lines without " - " are flagged for you to complete.'>
          <Textarea id={`${base}-paste-text`} rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </FieldBox>
        <Button type="button" size="sm" variant="outline" className="w-fit" onClick={preview} disabled={!text.trim()}>Preview</Button>
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        {rows ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Check before importing: {included.length} of {rows.length} lines selected.</p>
            <ol className="grid gap-2" aria-label="Pasted songs to check">
              {rows.map((r) => {
                const problem = r.include ? pastedRowProblem(r) : null;
                return (
                  <li key={r.id} className="grid gap-2 rounded-md border p-2" data-testid="paste-row">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input type="checkbox" className="size-4 accent-primary" checked={r.include} onChange={(e) => setRow(r.id, { include: e.target.checked })} />
                      Line {r.line}: <span className="[overflow-wrap:anywhere]">{r.text}</span>
                    </label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <FieldBox id={`${base}-paste-${r.id}-artist`} label="Artist" error={null}>
                        <Input id={`${base}-paste-${r.id}-artist`} value={r.artist} onChange={(e) => setRow(r.id, { artist: e.target.value, checked: true })} />
                      </FieldBox>
                      <FieldBox id={`${base}-paste-${r.id}-title`} label="Title" error={null}>
                        <Input id={`${base}-paste-${r.id}-title`} value={r.title} onChange={(e) => setRow(r.id, { title: e.target.value, checked: true })} />
                      </FieldBox>
                    </div>
                    {problem ? <p className="text-xs text-amber-700 dark:text-amber-400">{problem}</p> : null}
                    {r.flag && r.include && r.artist.trim() && r.title.trim() ? (
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" className="size-4 accent-primary" checked={r.checked} onChange={(e) => setRow(r.id, { checked: e.target.checked })} />
                        Looks right
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {problems > 0 ? <p role="alert" className="text-sm text-destructive">Complete or untick {problems === 1 ? "1 line" : `${problems} lines`} before importing.</p> : null}
            {tooMany ? <p role="alert" className="text-sm text-destructive">Only {room} more {room === 1 ? "song fits" : "songs fit"} in this list.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={importRows} disabled={problems > 0 || tooMany || included.length === 0}>
                Import {included.length} {included.length === 1 ? "song" : "songs"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setRows(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
