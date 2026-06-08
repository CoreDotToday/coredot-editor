import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

export type DocumentFindOptions = {
  caseSensitive: boolean;
  regex: boolean;
};

export type DocumentFindError = "empty_regex_match" | "invalid_regex" | "regex_too_long" | "unsafe_regex";

export type DocumentFindMatch = {
  from: number;
  text: string;
  to: number;
};

export type DocumentFindResult = {
  error: DocumentFindError | null;
  matches: DocumentFindMatch[];
};

type TextSegment = {
  endOffset: number;
  from: number;
  startOffset: number;
  text: string;
  to: number;
};

type TextScope = {
  segments: TextSegment[];
  text: string;
};

const MAX_REGEX_LENGTH = 256;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasObviouslyUnsafeRegex(source: string) {
  return /\([^)]*[*+][^)]*\)[*+{]/.test(source) || /\([^)]*\{[0-9,]+\}[^)]*\)[*+{]/.test(source);
}

function compileFindPattern(query: string, options: DocumentFindOptions) {
  if (!query) return { error: null, pattern: null } as const;
  if (options.regex && query.length > MAX_REGEX_LENGTH) return { error: "regex_too_long" as const, pattern: null };
  if (options.regex && hasObviouslyUnsafeRegex(query)) return { error: "unsafe_regex" as const, pattern: null };

  try {
    return {
      error: null,
      pattern: new RegExp(options.regex ? query : escapeRegExp(query), `g${options.caseSensitive ? "" : "i"}`),
    } as const;
  } catch {
    return { error: "invalid_regex" as const, pattern: null };
  }
}

function collectTextScopes(doc: ProseMirrorNode) {
  const scopes: TextScope[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    const segments: TextSegment[] = [];
    let text = "";

    node.descendants((childNode, childPos) => {
      if (!childNode.isText || !childNode.text) return true;

      const from = pos + 1 + childPos;
      const startOffset = text.length;
      text += childNode.text;
      segments.push({
        endOffset: text.length,
        from,
        startOffset,
        text: childNode.text,
        to: from + childNode.text.length,
      });

      return true;
    });

    if (segments.length > 0) {
      scopes.push({ segments, text });
    }

    return false;
  });

  return scopes;
}

function positionAtOffset(segments: TextSegment[], offset: number, side: "end" | "start") {
  for (const segment of segments) {
    if (offset < segment.startOffset || offset > segment.endOffset) continue;
    if (offset === segment.endOffset && side === "start") continue;

    return segment.from + Math.max(0, Math.min(segment.text.length, offset - segment.startOffset));
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment && offset === lastSegment.endOffset) return lastSegment.to;
  return null;
}

export function findDocumentMatches(
  doc: ProseMirrorNode,
  query: string,
  options: DocumentFindOptions,
): DocumentFindResult {
  const compiled = compileFindPattern(query, options);
  if (compiled.error) return { error: compiled.error, matches: [] };
  if (!compiled.pattern) return { error: null, matches: [] };

  const scopes = collectTextScopes(doc);
  const matches: DocumentFindMatch[] = [];

  for (const { segments, text } of scopes) {
    compiled.pattern.lastIndex = 0;
    let match = compiled.pattern.exec(text);

    while (match !== null) {
      if (match[0].length === 0) {
        return { error: "empty_regex_match", matches: [] };
      }

      const from = positionAtOffset(segments, match.index, "start");
      const to = positionAtOffset(segments, match.index + match[0].length, "end");
      if (from !== null && to !== null && from < to) {
        matches.push({ from, text: match[0], to });
      }

      match = compiled.pattern.exec(text);
    }
  }

  return { error: null, matches };
}

export function nextDocumentFindIndex(index: number, matchCount: number, direction: 1 | -1) {
  if (matchCount <= 0) return 0;
  return (Math.min(Math.max(index, 0), matchCount - 1) + direction + matchCount) % matchCount;
}

export function replaceDocumentMatch(editor: Editor, match: DocumentFindMatch, replacementText: string) {
  editor.chain().focus().insertContentAt({ from: match.from, to: match.to }, replacementText).run();
}

export function replaceAllDocumentMatches(editor: Editor, matches: readonly DocumentFindMatch[], replacementText: string) {
  const transaction = editor.state.tr;

  [...matches]
    .sort((first, second) => second.from - first.from)
    .forEach((match) => {
      transaction.insertText(replacementText, match.from, match.to);
    });

  if (transaction.docChanged) {
    editor.view.dispatch(transaction);
  }
}
