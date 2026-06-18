import { describe, expect, it } from "vitest";
import { buildAiMessages } from "./payload-builder";

describe("buildAiMessages", () => {
  it("combines system prompt, variables, selection, and context", () => {
    const messages = buildAiMessages({
      systemPrompt: "You are a strategy editor.",
      command: "Improve clarity",
      variables: { audience: "CEO", tone: "executive" },
      selectedText: "We might enter Japan.",
      beforeContext: "International expansion options:",
      afterContext: "Risks include distribution gaps.",
      documentText: "International expansion options:\nWe might enter Japan.\nRisks include distribution gaps.",
    });

    expect(messages[0]).toEqual({ role: "system", content: "You are a strategy editor." });
    expect(messages[1]?.content).toContain("audience: CEO");
    expect(messages[1]?.content).toContain("Selected text:\nWe might enter Japan.");
  });

  it("formats object and array template variables as JSON", () => {
    const messages = buildAiMessages({
      systemPrompt: "You are a strategy editor.",
      command: "Improve clarity",
      variables: {
        audiences: ["CEO", "CFO"],
        constraints: { region: "Japan", budget: 100 },
      },
      selectedText: "",
      beforeContext: "",
      afterContext: "",
      documentText: "",
    });

    expect(messages[1]?.content).toContain('audiences: ["CEO","CFO"]');
    expect(messages[1]?.content).toContain('constraints: {"region":"Japan","budget":100}');
  });

  it("renders referenced documents before the main document text", () => {
    const messages = buildAiMessages({
      systemPrompt: "You are a strategy editor.",
      command: "Compare the referenced memo",
      variables: {},
      selectedText: "",
      beforeContext: "",
      afterContext: "",
      documentText: "Main document",
      referencedDocuments: [
        {
          id: "doc_ref",
          text: "Reference document body",
          title: "Reference Memo",
        },
      ],
    });

    const userContent = messages[1]?.content ?? "";

    expect(userContent).toContain("Referenced documents:\n");
    expect(userContent).toContain('"title": "Reference Memo"');
    expect(userContent.indexOf("Referenced documents:")).toBeLessThan(userContent.indexOf("Document text:"));
  });

  it("truncates large document and reference bodies before building provider messages", () => {
    const longDocumentText = `${"Main body ".repeat(30_000)}END_OF_MAIN_DOCUMENT`;
    const longReferenceText = `${"Reference body ".repeat(12_000)}END_OF_REFERENCE_DOCUMENT`;

    const messages = buildAiMessages({
      systemPrompt: "You are a strategy editor.",
      command: "Compare the referenced memo",
      variables: {},
      selectedText: "",
      beforeContext: "",
      afterContext: "",
      documentText: longDocumentText,
      referencedDocuments: [
        {
          id: "doc_ref",
          text: longReferenceText,
          title: "Reference Memo",
        },
      ],
    });

    const userContent = messages[1]?.content ?? "";

    expect(userContent).toContain("[truncated");
    expect(userContent).not.toContain("END_OF_MAIN_DOCUMENT");
    expect(userContent).not.toContain("END_OF_REFERENCE_DOCUMENT");
    expect(userContent.length).toBeLessThan(longDocumentText.length + longReferenceText.length);
  });
});
