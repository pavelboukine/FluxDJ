import { describe, expect, it } from "vitest";
import { describeDbError } from "@/lib/db-errors";

describe("version conflicts", () => {
  const conflict = "Someone else saved changes first. Reload the page to see them, then try again.";
  it("show the same conflict message for PT409 (current) and 40001 (a database before 20261017000100)", () => {
    expect(describeDbError({ code: "PT409", message: "booking policy was changed elsewhere" })).toBe(conflict);
    expect(describeDbError({ code: "PT409", message: "draft_version_conflict: expected 3, current 4" })).toBe(conflict);
    expect(describeDbError({ code: "40001", message: "planning structure was changed elsewhere" })).toBe(conflict);
  });
});
