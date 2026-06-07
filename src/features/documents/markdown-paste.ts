import { Extension, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

type ParsedMarkdownContent = {
  content: JSONContent[];
  hasTable: boolean;
};

type ParsedTable = {
  nextIndex: number;
  node: JSONContent;
};

const markdownPastePluginKey = new PluginKey("coredotMarkdownPaste");

export const MarkdownPaste = Extension.create({
  name: "coredotMarkdownPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: markdownPastePluginKey,
        props: {
          handlePaste(_view, event) {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const parsedContent = parseMarkdownToTiptapContent(text);
            if (!parsedContent?.hasTable) {
              return false;
            }

            event.preventDefault();
            editor.commands.insertContent(parsedContent.content);
            return true;
          },
        },
      }),
    ];
  },
});

export function parseMarkdownToTiptapContent(markdown: string): ParsedMarkdownContent | null {
  const normalizedMarkdown = markdown.replace(/\r\n?/g, "\n").trim();
  if (!normalizedMarkdown) {
    return null;
  }

  const lines = normalizedMarkdown.split("\n");
  const content: JSONContent[] = [];
  let hasTable = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const parsedTable = parseMarkdownTableAt(lines, index);
    if (parsedTable) {
      content.push(parsedTable.node);
      hasTable = true;
      index = parsedTable.nextIndex;
      continue;
    }

    const heading = parseMarkdownHeading(line);
    if (heading) {
      content.push(heading);
      index += 1;
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() !== "" &&
      !parseMarkdownHeading(lines[index] ?? "") &&
      !parseMarkdownTableAt(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    content.push(createParagraph(paragraphLines.join(" ")));
  }

  return content.length > 0 ? { content, hasTable } : null;
}

function parseMarkdownHeading(line: string): JSONContent | null {
  const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
  if (!match) {
    return null;
  }

  return {
    attrs: { level: match[1].length },
    content: createTextContent(match[2].trim()),
    type: "heading",
  };
}

function parseMarkdownTableAt(lines: string[], startIndex: number): ParsedTable | null {
  const headerCells = parseMarkdownTableRow(lines[startIndex] ?? "");
  const separatorCells = parseMarkdownTableRow(lines[startIndex + 1] ?? "");
  if (!headerCells || !separatorCells || !isMarkdownTableSeparator(separatorCells)) {
    return null;
  }

  const bodyRows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const cells = parseMarkdownTableRow(lines[index] ?? "");
    if (!cells || isMarkdownTableSeparator(cells)) {
      break;
    }

    bodyRows.push(cells);
    index += 1;
  }

  if (bodyRows.length === 0) {
    return null;
  }

  const columnCount = Math.max(headerCells.length, ...bodyRows.map((row) => row.length));
  const rows = [headerCells, ...bodyRows].map((row, rowIndex) => ({
    content: Array.from({ length: columnCount }, (_, cellIndex) =>
      createTableCell(rowIndex === 0 ? "tableHeader" : "tableCell", row[cellIndex] ?? ""),
    ),
    type: "tableRow",
  }));

  return {
    nextIndex: index,
    node: {
      content: rows,
      type: "table",
    },
  };
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmedLine = line.trim();
  if (!trimmedLine.includes("|")) {
    return null;
  }

  const boundedLine = trimmedLine.replace(/^\|/, "").replace(/\|$/, "");
  const cells = splitMarkdownTableCells(boundedLine).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  return cells.length >= 2 ? cells : null;
}

function splitMarkdownTableCells(row: string) {
  const cells: string[] = [];
  let currentCell = "";
  let isEscaped = false;

  for (const character of row) {
    if (isEscaped) {
      currentCell += `\\${character}`;
      isEscaped = false;
      continue;
    }

    if (character === "\\") {
      isEscaped = true;
      continue;
    }

    if (character === "|") {
      cells.push(currentCell);
      currentCell = "";
      continue;
    }

    currentCell += character;
  }

  if (isEscaped) {
    currentCell += "\\";
  }
  cells.push(currentCell);
  return cells;
}

function isMarkdownTableSeparator(cells: string[]) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function createTableCell(type: "tableCell" | "tableHeader", text: string): JSONContent {
  return {
    content: [createParagraph(text)],
    type,
  };
}

function createParagraph(text: string): JSONContent {
  return {
    content: createTextContent(text),
    type: "paragraph",
  };
}

function createTextContent(text: string): JSONContent[] | undefined {
  return text ? [{ text, type: "text" }] : undefined;
}
