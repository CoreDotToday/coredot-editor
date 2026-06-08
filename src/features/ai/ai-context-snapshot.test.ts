import { describe, expect, it } from "vitest";
import { buildAiContextSnapshot, formatAiContextSnapshotForCopy } from "./ai-context-snapshot";

describe("buildAiContextSnapshot", () => {
  it("captures document, template, variables, selection, and model metadata", () => {
    const snapshot = buildAiContextSnapshot({
      ai: { model: "gpt-5-nano", provider: "coredot" },
      command: "Translate to English",
      document: { id: "doc_1", text: "반갑습니다.", title: "계약서" },
      mode: "selection_rewrite",
      selection: { occurrenceIndex: 0, range: { from: 1, to: 6 }, text: "반갑습니다." },
      template: { category: "contract_review", id: "tpl_1", name: "Contract Review" },
      variables: { contractType: "MSA", riskTolerance: "balanced" },
    });

    expect(snapshot).toMatchObject({
      ai: { model: "gpt-5-nano", provider: "coredot" },
      command: "Translate to English",
      document: { charCount: 6, id: "doc_1", title: "계약서" },
      mode: "selection_rewrite",
      schemaVersion: 1,
      selection: { occurrenceIndex: 0, range: { from: 1, to: 6 }, text: "반갑습니다." },
      template: { category: "contract_review", id: "tpl_1", name: "Contract Review" },
      variables: {
        names: ["contractType", "riskTolerance"],
        values: { contractType: "MSA", riskTolerance: "balanced" },
      },
    });
  });

  it("truncates long document and selection text with explicit metadata", () => {
    const snapshot = buildAiContextSnapshot(
      {
        command: "Review document",
        document: { id: "doc_1", text: "abcdefghijklmnopqrstuvwxyz", title: "Long" },
        mode: "document_review",
        selection: { text: "0123456789abcdefghijklmnopqrstuvwxyz" },
        template: { id: "tpl_1", name: "Review" },
        variables: {},
      },
      { maxDocumentChars: 12, maxSelectionChars: 10 },
    );

    expect(snapshot.document.text).toBe("abcdef\n...\nuvwxyz");
    expect(snapshot.document.truncation).toEqual({ shownChars: 12, strategy: "head-tail", totalChars: 26 });
    expect(snapshot.selection?.text).toBe("01234\n...\nvwxyz");
    expect(snapshot.selection?.truncation).toEqual({ shownChars: 10, strategy: "head-tail", totalChars: 36 });
  });

  it("redacts sensitive variable values from copy output", () => {
    const snapshot = buildAiContextSnapshot({
      command: "Review document",
      document: { id: "doc_1", text: "Body", title: "Doc" },
      mode: "document_review",
      template: { id: "tpl_1", name: "Review" },
      variables: { apiKey: "cdt_secret", audience: "executive" },
    });

    expect(snapshot.variables.values).toEqual({ apiKey: "[redacted]", audience: "executive" });
    expect(formatAiContextSnapshotForCopy(snapshot)).not.toContain("cdt_secret");
  });
});
