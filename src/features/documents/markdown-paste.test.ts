import { describe, expect, it } from "vitest";
import { parseMarkdownToTiptapContent } from "./markdown-paste";

describe("parseMarkdownToTiptapContent", () => {
  it("converts markdown headings and pipe tables to Tiptap table content", () => {
    const result = parseMarkdownToTiptapContent(
      [
        "# 사용 기술",
        "",
        "## ○ AI 모델링 기술",
        "",
        "| 구분 | 기술 |",
        "| ------------- | ----------------------------------- |",
        "| LLM | OpenAI GPT API / Claude API |",
        "| NLP | RAG(Retrieval-Augmented Generation) |",
      ].join("\n"),
    );

    expect(result?.hasTable).toBe(true);
    expect(result?.content[0]).toMatchObject({ attrs: { level: 1 }, type: "heading" });
    expect(result?.content[1]).toMatchObject({ attrs: { level: 2 }, type: "heading" });
    expect(result?.content[2]?.type).toBe("table");
    expect(result?.content[2]?.content).toHaveLength(3);
    expect(readRowText(result?.content[2]?.content?.[0])).toEqual(["구분", "기술"]);
    expect(readRowText(result?.content[2]?.content?.[1])).toEqual(["LLM", "OpenAI GPT API / Claude API"]);
  });

  it("parses the user's AI modeling technology table", () => {
    const result = parseMarkdownToTiptapContent(
      [
        "| 구분            | 기술                                  |",
        "| ------------- | ----------------------------------- |",
        "| LLM           | OpenAI GPT API / Claude API         |",
        "| NLP           | RAG(Retrieval-Augmented Generation) |",
        "| 임베딩 모델        | Qwen3-Embedding-8B                  |",
        "| Vector Search | pgvector / ChromaDB                 |",
        "| 법률 검색         | Lawbot MCP                          |",
        "| Citation 검증   | Citation Firewall                   |",
        "| PDF 분석        | OCR 및 텍스트 추출(PyMuPDF)               |",
        "| 자연어처리         | Text Mining / Tokenization          |",
      ].join("\n"),
    );

    expect(result?.content[0]?.type).toBe("table");
    expect(result?.content[0]?.content).toHaveLength(9);
    expect(readRowText(result?.content[0]?.content?.[0])).toEqual(["구분", "기술"]);
    expect(readRowText(result?.content[0]?.content?.[1])).toEqual(["LLM", "OpenAI GPT API / Claude API"]);
    expect(readRowText(result?.content[0]?.content?.[8])).toEqual(["자연어처리", "Text Mining / Tokenization"]);
  });

  it("leaves plain markdown without tables for the default paste behavior", () => {
    expect(parseMarkdownToTiptapContent("Just a normal paragraph")?.hasTable).toBe(false);
  });
});

function readRowText(row: { content?: Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }> } | undefined) {
  return (row?.content ?? []).map((cell) => cell.content?.[0]?.content?.[0]?.text ?? "");
}
