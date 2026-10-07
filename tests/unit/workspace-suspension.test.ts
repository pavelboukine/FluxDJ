import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth/redirects";
import { describeDbError } from "@/lib/db-errors";

describe("workspace suspension messages", () => {
  it("a blocked write says nothing was saved, without internal details", () => {
    const message = describeDbError({ code: "PT423", message: "workspace_suspended: this workspace is suspended" });
    expect(message).toBe("This workspace is unavailable right now, so nothing was saved.");
    expect(describeDbError({ code: "PT423", message: "" })).toBe(message);
  });

  it("administration errors are plain sentences; stale versions use the conflict message", () => {
    expect(describeDbError({ code: "22023", message: "workspace_reason_required: give an internal reason (3 to 500 characters)" }))
      .toBe("Give an internal reason (3 to 500 characters).");
    expect(describeDbError({ code: "22023", message: "workspace_own: you belong to this workspace, so it can't be suspended from your account" }))
      .toBe("You belong to this workspace, so it can't be suspended from your account.");
    expect(describeDbError({ code: "PT409", message: "workspace suspension was changed elsewhere" }))
      .toBe("Someone else saved changes first. Reload the page to see them, then try again.");
  });

  it("a confirmed sign-in may continue to the workspace administration screen", () => {
    expect(safeNext("/platform/workspaces")).toBe("/platform/workspaces");
    expect(safeNext("/platform/workspaces/x")).toBe("/staff");
  });
});
