import type { TiptapJson } from "@/db/schema";

export type DocumentOutlineLevel = 1 | 2 | 3;

export type DocumentOutlineItem = {
  children: DocumentOutlineItem[];
  id: string;
  level: DocumentOutlineLevel;
  title: string;
  topLevelIndex: number | null;
};

type TiptapNode = {
  attrs?: Record<string, unknown>;
  content?: unknown[];
  text?: string;
  type?: string;
};

function isOutlineLevel(value: unknown): value is DocumentOutlineLevel {
  return value === 1 || value === 2 || value === 3;
}

function normalizeHeadingTitle(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function sameHeadingTitle(first: string, second: string) {
  return normalizeHeadingTitle(first).toLocaleLowerCase() === normalizeHeadingTitle(second).toLocaleLowerCase();
}

function nodeText(node: TiptapNode): string {
  const parts: string[] = [];

  if (node.text) {
    parts.push(node.text);
  }

  for (const child of node.content ?? []) {
    if (child && typeof child === "object") {
      parts.push(nodeText(child as TiptapNode));
    }
  }

  return parts.join("");
}

function nearestParent(stack: DocumentOutlineItem[], level: DocumentOutlineLevel) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const item = stack[index];
    if (item && item.level < level) {
      return item;
    }
  }

  return stack[0]!;
}

export function buildDocumentOutline(title: string, contentJson: TiptapJson): DocumentOutlineItem {
  const root: DocumentOutlineItem = {
    children: [],
    id: "document-title",
    level: 1,
    title: title.trim() || "Untitled document",
    topLevelIndex: null,
  };
  const stack: DocumentOutlineItem[] = [root];
  let headingCount = 0;

  (contentJson.content ?? []).forEach((block, topLevelIndex) => {
    if (!block || typeof block !== "object") return;

    const node = block as TiptapNode;
    if (node.type !== "heading" || !isOutlineLevel(node.attrs?.level)) return;

    const headingTitle = normalizeHeadingTitle(nodeText(node));
    if (!headingTitle) return;

    const level = node.attrs.level;
    if (headingCount === 0 && level === 1 && sameHeadingTitle(title, headingTitle)) {
      headingCount += 1;
      return;
    }

    const item: DocumentOutlineItem = {
      children: [],
      id: `heading-${topLevelIndex}`,
      level,
      title: headingTitle,
      topLevelIndex,
    };
    const parent = nearestParent(stack, level);
    parent.children.push(item);
    stack[level] = item;
    stack.length = level + 1;
    headingCount += 1;
  });

  return root;
}
