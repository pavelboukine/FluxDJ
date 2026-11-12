/**
 * What "unsaved changes" compares: a form's user-editable values, serialized. Text, selects,
 * checked boxes and radios count by value (an emptied field is "" and still differs). A chosen
 * file counts by its name and size, so choosing, replacing or clearing a chosen file is a change.
 * A file field with nothing chosen counts as nothing, so a file field that appears or goes away
 * with other choices (a second logo once there is a logo) is never an edit by itself. The
 * optimistic version is bookkeeping, not an edit.
 */
export function formSnapshot(entries: Iterable<[string, FormDataEntryValue]>): string {
  return JSON.stringify(
    [...entries]
      .filter(([name, value]) => name !== "draft_version" && (typeof value === "string" || value.name !== "" || value.size > 0))
      .map(([name, value]) => [name, typeof value === "string" ? value : `file:${value.name}:${value.size}`]),
  );
}
