import { ANNOUNCEMENT_LANGUAGES } from "./basics";
import { GENRES, INTERACTION, LYRICS, REQUESTS, SLOW_SONGS } from "./contacts";
import { CHOICE_LABELS, LIST_CHOICE_LABEL, MUSIC_RULES, isMusicEditor } from "./music";
import { STAGE_LAYOUT, isStageEditor, type Block } from "./stages";

/**
 * What a client is asked in each built-in planning section, stage and moment, in plain words, for the
 * template editor ("What clients are asked"). One line per question: its wording, how it is answered,
 * and whether it is needed.
 *
 * Wording and options come from the same constants the client editors render (STAGE_LAYOUT, the
 * choice lists, the music rules), so they stay in step; richer editors (lists of people, songs) are
 * described briefly here. The full, working form is the template preview, which renders the editors
 * themselves. tests/unit/question-summaries.test.ts checks that every library editor has a summary.
 */

export type QuestionLine = {
  label: string;
  /** How it's answered: "Time", "Short answer", "One choice: …", "A list of songs", … */
  answer: string;
  need: "needed" | "optional" | "needed_to_complete";
  /** Shown only after a given answer (e.g. the grand entrance time once one is planned). */
  when?: string;
};
export type QuestionSummary = { intro?: string; questions: QuestionLine[] };

const DISCUSS = "Not sure yet — discuss with the DJ";
const oneOf = (options: readonly (readonly [string, string])[] | string[]) =>
  `One choice: ${options.map((o) => (typeof o === "string" ? o : o[1])).join(" · ")}`;

/** A label as the editor shows it, with its "(needed)" or "(optional)" turned into the need. */
function line(raw: string, answer: string, when?: string): QuestionLine {
  const m = /^(.*?)\s*\((needed to complete|needed|optional)\)\s*$/.exec(raw);
  const need = m?.[2] === "needed" ? "needed" : m?.[2] === "needed to complete" ? "needed_to_complete" : "optional";
  return { label: m ? m[1] : raw, answer, need, ...(when ? { when } : {}) };
}

function blockLines(b: Block): QuestionLine[] {
  switch (b.type) {
    case "location":
      return [
        line(`${b.label} (needed)`, oneOf(["Same as the event venue", "Somewhere else (place and address)"])),
        line("Room or outdoor area (optional)", "Short answer"),
      ];
    case "time":
      return [line(b.label, "Time")];
    case "text":
      return [line(b.label, (b.rows ?? 1) > 1 ? "Paragraph" : "Short answer")];
    case "choice":
      return [line(b.label, oneOf(b.options.map(([, label]) => label)))];
    case "int":
      return [line(b.label, "Number")];
    case "flag":
      return [line(b.label, "Checkbox")];
    case "guest_count":
      return [line("Guests at dinner (needed)", oneOf(["Same as the guest count in Event basics", "A different number"]))];
    case "finish":
      return [
        line("Planned finish (needed)", oneOf(["At a specific time", "Same as the event end time in Event basics", DISCUSS])),
        line("Finish time", "Time", "At a specific time"),
      ];
    case "grand_entrance":
      return [
        line("Are you planning a formal grand entrance? (needed)", oneOf(["Yes, we're planning a grand entrance", "No, we'll skip the formal entrance", "We're not sure yet"])),
        line("Planned grand entrance time (needed)", "Time", "a grand entrance is planned"),
      ];
    case "note":
      return [];
  }
}

const MUSIC_INTRO: Record<string, string> = {
  music_background: "Songs or playlist links for background music.",
  music_requests: "Songs or playlist links the client wants played.",
  music_exclusions: "Songs or playlist links the DJ should avoid.",
  moment_songs: "The song or songs for this moment, with instructions for the DJ.",
};

function musicSummary(editor: keyof typeof MUSIC_RULES): QuestionSummary {
  const rules = MUSIC_RULES[editor];
  const choices = [LIST_CHOICE_LABEL[editor], ...rules.choices.map((c) => CHOICE_LABELS[editor][c]).filter((c): c is string => Boolean(c))];
  const songs = `A list of songs (title, artist, optional version, link and notes${rules.cue ? ", with a cue label" : ""}), up to ${rules.maxSongs}`;
  return {
    intro: MUSIC_INTRO[editor],
    questions: [
      line("Your answer (needed)", oneOf(choices)),
      line("Songs", songs, LIST_CHOICE_LABEL[editor]),
      ...(rules.playlists ? [line("Playlist links (optional)", "Links from Spotify, Apple Music or another music app, up to 5", LIST_CHOICE_LABEL[editor])] : []),
    ],
  };
}

const SUMMARIES: Record<string, QuestionSummary> = {
  basics: {
    questions: [
      line("Guest count (needed)", "Number"),
      line("Start time (needed)", "Time"),
      line("End time (needed)", "Time"),
      line("Where is the event? (needed)", "The venue staff entered, or a short answer"),
      line("Room or space within the venue (optional)", "Short answer"),
      line("Parking, loading and access for the DJ (needed)", "Paragraph, or “No special instructions”"),
    ],
  },
  contacts: {
    questions: [
      line("Day-of contact for the DJ (needed)", oneOf(["One of the event's contacts", "Someone else (name, phone and relationship)", "Not decided yet"])),
      line("Other vendors the DJ may coordinate with (needed)", "A list of vendors (role, name or business, coordination notes), or “No additional vendor contacts”"),
    ],
  },
  preferences: {
    questions: [
      line("Desired atmosphere and what matters most (optional)", "Paragraph"),
      line("How much would you like your DJ to interact with guests on the microphone? (needed)", oneOf(INTERACTION)),
      line("Announcement language (needed)", oneOf(ANNOUNCEMENT_LANGUAGES)),
      line("Explicit lyrics (needed)", oneOf(LYRICS)),
      line("Guest song requests (needed)", oneOf(REQUESTS)),
      line("Practical preferences or concerns (optional)", "Paragraph"),
    ],
  },
  music_style: {
    questions: [
      line("Music styles (needed)", `Choose any: ${GENRES.map(([, l]) => l).join(" · ")}, or DJ's choice`),
      line("Other style (optional)", "Short answer"),
      line("Favourite artists (optional)", "Short answer"),
      line("Dance-floor atmosphere (optional)", "Paragraph"),
      line("Slow songs during the party (needed)", oneOf(SLOW_SONGS)),
    ],
  },
  arrival: {
    questions: [
      line("Where do guests arrive? (needed)", oneOf(["Same as the event venue", "Same as the ceremony", "Somewhere else (place and address)"])),
      line("When do guests arrive? (needed)", oneOf(["Same as the ceremony's guest arrival", "At a specific time (arrival starts, optional end)"])),
      line("Welcome instructions (optional)", "Paragraph"),
      line("Announcement wording (optional)", "Paragraph"),
    ],
    intro: "Or “No separate arrival arrangements”.",
  },
  program: {
    questions: [
      line("Program starts (optional)", "Time"),
      line("Program ends (optional)", "Time"),
      line("Host (optional)", "Short answer, with a pronunciation guide"),
      line("Agenda (needed)", "A list of agenda items (presenter, timing, instructions), or “No formal program”"),
    ],
  },
  processional: {
    intro: "Everyone who walks down the aisle, in order, with their music.",
    questions: [
      line("Who walks in (needed)", "A list of people or groups, in order (name, role, pronunciation, song, instructions)"),
      line("Music (needed)", "A song for each person or group (shared songs allowed), DJ's choice, or not decided yet"),
    ],
  },
  introductions: {
    intro: "Who is introduced at the grand entrance, in order, with how to announce them and their songs.",
    questions: [
      line("Who is introduced (needed)", "A list of people or groups, in order (names as announced, role, pronunciation, wording, song, instructions), or “Nobody will be introduced”"),
    ],
  },
  mc: {
    questions: [
      line("Who will handle MC duties during the reception? (needed)", oneOf(["The DJ will be the MC", "Someone else will be the MC", "The DJ and another MC will share duties", DISCUSS])),
      line("MC's name (needed)", "Short answer", "someone else is the MC or shares the duties"),
      line("Phone or email (optional)", "Short answer", "someone else is the MC or shares the duties"),
    ],
  },
  speeches: {
    questions: [
      line("Your answer (needed)", oneOf(["I'll list the speeches", "No speeches or toasts"])),
      line("Speeches", "A list of speakers (name, role, pronunciation, when, length, microphone or AV notes, instructions)", "I'll list the speeches"),
    ],
  },
  activities: {
    questions: [
      line("Your answer (needed)", oneOf(["I'll list them", "No activities"])),
      line("Activities", "A list of activities (name, host, participants, when, length, music, instructions)", "I'll list them"),
    ],
  },
  dedications: {
    questions: [
      line("Your answer (needed)", oneOf(["I'll list them", "No dedications"])),
      line("Dedications", "A list (for whom, relationship, pronunciation, song, timing, announcement message)", "I'll list them"),
    ],
  },
};

/**
 * What the client is asked in an item with this library editor, or null when it has no form of its own
 * (a stage that only groups its moments, or a placeholder answered elsewhere). A DJ's own item has no
 * built-in summary: the template editor lists its questions in "Your questions".
 */
export function questionSummary(editor: string | null | undefined): QuestionSummary | null {
  if (!editor) return null;
  if (isStageEditor(editor)) return { questions: STAGE_LAYOUT[editor].flatMap(blockLines) };
  if (isMusicEditor(editor)) return musicSummary(editor);
  return SUMMARIES[editor] ?? null;
}

/** Editors whose questions are shown elsewhere: stage_details (in its stage), included (in another moment). */
export const SUMMARY_ELSEWHERE = ["stage_details", "included"] as const;
