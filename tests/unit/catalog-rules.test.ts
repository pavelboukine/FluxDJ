import { describe, expect, it } from "vitest";
import { conditionText, conditionValues, readCondition, readOptions, ruleStatement } from "@/lib/catalog/rules";

const options = [
  { value: "same_room", label: "Same room" },
  { value: "separate_space", label: "A separate space" },
  { value: "outdoors", label: "Outdoors" },
];

describe("rule wording", () => {
  it("describes every supported condition", () => {
    expect(conditionText({ op: "equals", value: true }, [])).toBe("is Yes");
    expect(conditionText({ op: "equals", value: false }, [])).toBe("is No");
    expect(conditionText({ op: "equals", value: "separate_space" }, options)).toBe("is “A separate space”");
    expect(conditionText({ op: "in", values: ["separate_space", "outdoors"] }, options)).toBe("is “A separate space” or “Outdoors”");
    expect(conditionText({ op: "in", values: ["same_room", "separate_space", "outdoors"] }, options)).toBe("is “Same room”, “A separate space” or “Outdoors”");
    expect(conditionText({ op: "contains", value: "outdoors" }, options)).toBe("includes “Outdoors”");
    expect(ruleStatement("Where is the ceremony?", { op: "equals", value: "separate_space" }, options, 1, "Speaker")).toBe(
      "When “Where is the ceremony?” is “A separate space”, require 1 × Speaker.",
    );
    expect(conditionValues({ op: "in", values: ["a", "b"] })).toEqual(["a", "b"]);
    expect(conditionValues({ op: "equals", value: true })).toEqual([]);
  });

  it("builds conditions only from this question's choices", () => {
    expect(readCondition("boolean", [], { when: "false", values: [] })).toEqual({ ok: true, condition: { op: "equals", value: false } });
    expect(readCondition("single_choice", options, { values: ["outdoors"] })).toEqual({ ok: true, condition: { op: "equals", value: "outdoors" } });
    expect(readCondition("single_choice", options, { values: ["outdoors", "same_room"] })).toEqual({ ok: true, condition: { op: "in", values: ["outdoors", "same_room"] } });
    expect(readCondition("single_choice", options, { values: ["nope"] }).ok).toBe(false);
    expect(readCondition("multi_choice", options, { values: [], contains: "outdoors" })).toEqual({ ok: true, condition: { op: "contains", value: "outdoors" } });
    expect(readCondition("short_text", [], { values: [] }).ok).toBe(false);
  });
});

describe("choices", () => {
  it("keeps existing values when labels change and makes unique values for new ones", () => {
    expect(readOptions(["same_room", ""], ["Same room as the party", "Same room"])).toEqual({
      ok: true,
      options: [
        { value: "same_room", label: "Same room as the party" },
        { value: "same_room_2", label: "Same room" },
      ],
    });
    expect(readOptions(["", ""], ["Garden", "garden"])).toEqual({ ok: false, error: "Two choices have the same label." });
    expect(readOptions([""], [" "])).toEqual({ ok: false, error: "Add at least one choice." });
    expect(readOptions(["Bad value"], ["X"]).ok).toBe(false);
  });
});
