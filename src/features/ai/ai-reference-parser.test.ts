import { describe, expect, it } from "vitest";
import { resolveAiDocumentReferences } from "./ai-reference-parser";

const candidates = [
  { id: "doc_1", plainText: "Revenue context", title: "Revenue Memo", updatedAt: new Date("2026-01-01") },
  { id: "doc_2", plainText: "Risk context", title: "Risk Register", updatedAt: new Date("2026-01-02") },
  { id: "doc_3", plainText: "Other", title: "Revenue Memo", updatedAt: new Date("2026-01-03") },
];

describe("resolveAiDocumentReferences", () => {
  it("resolves quoted and unquoted document mentions in command text", () => {
    const references = resolveAiDocumentReferences(
      'Compare @Revenue Memo with @"Risk Register", then summarize.',
      candidates,
    );

    expect(references).toEqual([
      { id: "doc_1", title: "Revenue Memo" },
      { id: "doc_2", title: "Risk Register" },
    ]);
  });

  it("dedupes repeated references and ignores unknown mentions", () => {
    const references = resolveAiDocumentReferences(
      "Use @Revenue Memo and @Unknown Plan and @Revenue Memo.",
      candidates,
    );

    expect(references).toEqual([{ id: "doc_1", title: "Revenue Memo" }]);
  });

  it("does not resolve a shorter prefix title when the mention continues", () => {
    const references = resolveAiDocumentReferences("Use @Revenue Memo Q1 for this rewrite.", [
      { id: "doc_1", plainText: "Revenue context", title: "Revenue Memo" },
      { id: "doc_q1", plainText: "Q1 context", title: "Revenue Memo Q1" },
    ]);

    expect(references).toEqual([{ id: "doc_q1", title: "Revenue Memo Q1" }]);
  });
});
