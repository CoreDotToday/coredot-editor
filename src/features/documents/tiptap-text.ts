type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
};

const blockTypes = new Set(["paragraph", "heading", "blockquote", "codeBlock", "listItem", "taskItem"]);

function collectText(node: TiptapNode, lines: string[], current: string[]): void {
  if (node.text) {
    current.push(node.text);
  }

  for (const child of node.content ?? []) {
    if (child && typeof child === "object") {
      collectText(child, lines, current);
    }
  }

  if (node.type && blockTypes.has(node.type) && current.length > 0) {
    lines.push(current.join(""));
    current.length = 0;
  }
}

export function extractPlainTextFromTiptap(doc: TiptapNode): string {
  const lines: string[] = [];
  const current: string[] = [];
  collectText(doc, lines, current);
  if (current.length > 0) {
    lines.push(current.join(""));
  }
  return lines.map((line) => line.trim()).filter(Boolean).join("\n");
}
