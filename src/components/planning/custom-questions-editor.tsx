"use client";

import { LabelText } from "./label-text";
import {
  customAnswersFromForm,
  customAnswerText,
  customForm,
  questionField,
  type CustomAnswers,
  type CustomFieldForm,
  type CustomForm,
  type CustomQuestion,
} from "@/lib/planning/custom-questions";
import { ChoiceFieldset, ChoiceOption, Choices } from "./choice-list";
import { MusicSection } from "./music-editor";
import { Frame, text, type Common } from "./participants-editor";
import { useEditingClosed } from "./progress";
import { TimeField } from "./time-field";
import { SaveStatus, useAutosave } from "./use-autosave";

const NO_LINKS = new Map<string, string[]>();

/** "Question (needed)" or "Question (optional)", as every planning label reads. */
const labelFor = (q: CustomQuestion) => `${q.label} (${q.required ? "needed" : "optional"})`;

/**
 * A DJ's own section or moment: its questions, in order, with the planning
 * inputs every built-in section uses (text fields, the choice list, the time
 * field, a moment's song list) and the same autosave. Shared by the client's
 * page, staff planning and the previews; the database checks every answer.
 * Staff also see questions no longer asked that still hold an answer, read only.
 */
export function CustomQuestionsEditor(props: Common<CustomAnswers> & {
  /** This plan's own definitions: for clients the questions still asked; for staff removed ones too (archived). */
  questions: CustomQuestion[];
  event: { date: string };
}) {
  const readOnly = useEditingClosed(props.disabledReason);
  const asked = props.questions.filter((q) => !q.archived);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<CustomForm, CustomAnswers>({
    initialForm: customForm(props.questions, props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: (f) => customAnswersFromForm(props.questions, f, props.initialAnswers),
    save: props.save,
    readOnly,
  });
  const errorFor = (q: CustomQuestion) => (fieldError?.field === questionField(q.id) ? fieldError.message : null);
  const set = (q: CustomQuestion, next: CustomFieldForm, clears: string[] = []) => update({ [q.id]: next }, [questionField(q.id), ...clears]);
  const id = (q: CustomQuestion) => `${props.momentKey}-${q.id}`;
  const removed = props.audience === "staff" ? props.questions.filter((q) => q.archived && props.initialAnswers[q.id] !== undefined) : [];
  const labels = Object.fromEntries(asked.map((q) => [q.id, q.label]));

  return (
    <Frame props={props as Common<unknown>} labels={labels} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      {asked.length === 0 ? <p className="text-sm text-plan-ink-2">Nothing to answer here yet.</p> : null}
      <div className="grid gap-5 sm:grid-cols-2">
        {asked.map((q) => {
          const f = form[q.id];
          if (!f) return null;
          switch (f.type) {
            case "short_text":
            case "long_text":
              return text(id(q), labelFor(q), f.text, (v) => set(q, { ...f, text: v }), errorFor(q),
                { hint: q.help, rows: f.type === "long_text" ? 3 : undefined, wide: true });
            case "yes_no":
              return (
                <div key={q.id} className="col-span-full" data-testid={`question-${q.id}`}>
                  <Choices<"yes" | "no">
                    name={id(q)}
                    legend={labelFor(q)}
                    value={f.answer}
                    disabled={readOnly}
                    onChange={(v) => set(q, { ...f, answer: v })}
                    error={errorFor(q)}
                    options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
                    after={q.help ? <p data-plan-help className="text-xs text-plan-ink-2">{q.help}</p> : null}
                  />
                </div>
              );
            case "single_choice": {
              // A choice staff have since removed stays shown while it is the saved answer.
              const options = (q.options ?? []).filter((o) => !o.archived || o.id === f.choice);
              return (
                <div key={q.id} className="col-span-full" data-testid={`question-${q.id}`}>
                  <Choices<string>
                    name={id(q)}
                    legend={labelFor(q)}
                    value={f.choice}
                    disabled={readOnly}
                    onChange={(v) => set(q, { ...f, choice: v })}
                    error={errorFor(q)}
                    options={options.map((o) => ({ value: o.id, label: o.label, hint: o.archived ? "No longer offered: kept because it was chosen" : undefined }))}
                    after={q.help ? <p data-plan-help className="text-xs text-plan-ink-2">{q.help}</p> : null}
                  />
                </div>
              );
            }
            case "multi_choice": {
              const options = (q.options ?? []).filter((o) => !o.archived || f.choices.includes(o.id));
              return (
                <ChoiceFieldset
                  key={q.id}
                  className="col-span-full"
                  testId={`question-${q.id}`}
                  legend={labelFor(q)}
                  disabled={readOnly}
                  after={
                    <>
                      {q.help ? <p data-plan-help className="text-xs text-plan-ink-2">{q.help}</p> : null}
                      {errorFor(q) ? <p className="text-xs font-medium text-destructive">{errorFor(q)}</p> : null}
                    </>
                  }
                >
                  {options.map((o) => (
                    <ChoiceOption
                      key={o.id}
                      type="checkbox"
                      checked={f.choices.includes(o.id)}
                      onChange={(on) => set(q, { ...f, choices: on ? [...f.choices, o.id] : f.choices.filter((c) => c !== o.id) })}
                      label={o.label}
                      hint={o.archived ? "No longer offered: kept because it was chosen" : undefined}
                    />
                  ))}
                </ChoiceFieldset>
              );
            }
            case "time":
              return (
                <TimeField
                  key={q.id}
                  id={id(q)}
                  className="col-span-full"
                  label={labelFor(q)}
                  time={f.time}
                  nextDay={f.nextDay}
                  onTime={(v) => set(q, { ...f, time: v, nextDay: v ? f.nextDay : false })}
                  onNextDay={(v) => set(q, { ...f, nextDay: v })}
                  eventDate={props.event.date}
                  error={errorFor(q)}
                  hint={q.help}
                />
              );
            case "songs":
              return (
                <section key={q.id} className="col-span-full grid gap-2" aria-label={q.label} data-testid={`question-${q.id}`}>
                  <p className="flex flex-wrap items-baseline gap-2 text-sm leading-snug font-medium"><LabelText text={labelFor(q)} /></p>
                  {q.help ? <p data-plan-help className="text-xs text-plan-ink-2">{q.help}</p> : null}
                  <MusicSection
                    itemId={props.itemId}
                    momentKey={id(q)}
                    label={q.label}
                    editor="moment_songs"
                    choices={false}
                    form={f.music}
                    update={(changes, clears) => set(q, { ...f, music: { ...f.music, ...changes } }, clears)}
                    fieldError={fieldError}
                    readOnly={readOnly}
                    djName={props.djName}
                    audience={props.audience}
                    linked={NO_LINKS}
                    linkedWhere=""
                  />
                  {errorFor(q) ? <p role="alert" className="text-xs font-medium text-destructive">{errorFor(q)}</p> : null}
                </section>
              );
          }
        })}
      </div>
      {removed.length > 0 ? (
        <div className="grid gap-1 rounded-xl bg-plan-track/50 px-3.5 py-3 text-sm" data-testid="questions-no-longer-asked">
          <p className="font-medium">No longer asked (answers kept)</p>
          {removed.map((q) => (
            <p key={q.id} className="[overflow-wrap:anywhere]">
              <span className="text-plan-ink-2">{q.label}:</span> {customAnswerText(q, props.initialAnswers[q.id], "staff") ?? "Not answered"}
            </p>
          ))}
        </div>
      ) : null}
    </Frame>
  );
}
