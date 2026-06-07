import { describe, expect, it } from "vitest";
import { createRedlineSegments } from "./redline-diff";

describe("createRedlineSegments", () => {
  it("marks deleted and inserted text while preserving shared text", () => {
    expect(
      createRedlineSegments(
        "Company may use Customer Data to improve services.",
        "Company may use Customer Data only to provide the Services.",
      ),
    ).toEqual([
      { type: "equal", text: "Company may use Customer Data " },
      { type: "inserted", text: "only to provide the Services" },
      { type: "deleted", text: "to improve services" },
      { type: "equal", text: "." },
    ]);
  });

  it("returns one equal segment when the texts are identical", () => {
    expect(createRedlineSegments("No change.", "No change.")).toEqual([{ type: "equal", text: "No change." }]);
  });
});
