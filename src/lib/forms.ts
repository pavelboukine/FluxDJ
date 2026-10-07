/** Shared shape for Server Action results consumed by useActionState. */
export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; message: string; version?: number };

export const idleState: ActionState = { status: "idle" };

export function fail(message: string): ActionState {
  return { status: "error", message };
}
export function ok(message: string, version?: number): ActionState {
  return version === undefined ? { status: "success", message } : { status: "success", message, version };
}

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
export function optionalText(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === "" ? null : value;
}
export function checkbox(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}
/** Whole number within bounds, or null. */
export function int(form: FormData, name: string, min: number, max: number): number | null {
  const raw = text(form, name);
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Suggests a workspace web address from a business name: "DJ Maxwell Événements" -> "dj-maxwell-evenements". */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** Suggests a stable key from a name: "Uplights (pack of 4)" -> "uplights_pack_of_4". */
export function keyFromName(name: string): string {
  const key = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[a-z]/.test(key) ? key : `item_${key}`.slice(0, 64);
}
