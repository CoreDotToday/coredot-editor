import { Extension, type Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type AiSuggestionHighlightInput = {
  active?: boolean;
  id: string;
  occurrenceIndex?: number | null;
  selectionRange?: { from: number; to: number };
  source?: "review" | "selection" | null;
  targetText: string;
};

export type AiSuggestionDecorationRange = {
  active?: boolean;
  from: number;
  id: string;
  source?: "review" | "selection" | null;
  to: number;
};

type HighlightPluginState = {
  decorations: DecorationSet;
  suggestions: AiSuggestionHighlightInput[];
};

type TextPiece = {
  end: number;
  pos: number;
  start: number;
  text: string;
};

const aiSuggestionHighlightKey = new PluginKey<HighlightPluginState>("coredotAiSuggestionHighlight");

export const AiSuggestionHighlight = Extension.create({
  name: "aiSuggestionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightPluginState>({
        key: aiSuggestionHighlightKey,
        props: {
          decorations(state) {
            return aiSuggestionHighlightKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
        state: {
          apply(transaction, previousState, _oldState, newState) {
            const nextSuggestions = transaction.getMeta(aiSuggestionHighlightKey) as
              | AiSuggestionHighlightInput[]
              | undefined;
            const suggestions = nextSuggestions ?? previousState.suggestions;

            if (nextSuggestions || transaction.docChanged) {
              return {
                suggestions,
                decorations: createSuggestionDecorationSet(newState.doc, suggestions),
              };
            }

            return {
              suggestions,
              decorations: previousState.decorations.map(transaction.mapping, transaction.doc),
            };
          },
          init(_config, state) {
            return {
              suggestions: [],
              decorations: createSuggestionDecorationSet(state.doc, []),
            };
          },
        },
      }),
    ];
  },
});

export function setAiSuggestionHighlights(editor: Editor, suggestions: AiSuggestionHighlightInput[]) {
  editor.view.dispatch(editor.state.tr.setMeta(aiSuggestionHighlightKey, suggestions));
}

function createSuggestionDecorationSet(doc: ProseMirrorNode, suggestions: AiSuggestionHighlightInput[]) {
  const decorations = findSuggestionDecorationRanges(doc, suggestions).map((range) =>
    Decoration.inline(range.from, range.to, {
      class: [
        "coredot-ai-suggestion",
        range.source === "selection" ? "coredot-ai-suggestion--selection" : "coredot-ai-suggestion--review",
        range.active ? "coredot-ai-suggestion--active" : "",
      ].join(" "),
      "data-ai-proposal-id": range.id,
    }),
  );

  return DecorationSet.create(doc, decorations);
}

export function findSuggestionDecorationRanges(
  doc: ProseMirrorNode,
  suggestions: AiSuggestionHighlightInput[],
): AiSuggestionDecorationRange[] {
  const textRuns = collectTextRuns(doc);

  return suggestions.flatMap((suggestion) => {
    const targetText = suggestion.targetText;
    if (!targetText) return [];

    const selectionMatch = findValidSelectionRange(doc, suggestion);
    if (selectionMatch) {
      return [
        {
          from: selectionMatch.from,
          active: suggestion.active,
          id: suggestion.id,
          source: suggestion.source,
          to: selectionMatch.to,
        },
      ];
    }

    const matches = uniqueRanges([
      ...textRuns.flatMap((pieces) => findMatchesInTextRun(pieces, targetText)),
      ...findMatchesInDocumentText(doc, targetText),
    ]);
    const selectedMatch =
      suggestion.occurrenceIndex === null || suggestion.occurrenceIndex === undefined
        ? matches.length === 1
          ? matches[0]
          : null
        : matches[suggestion.occurrenceIndex] ?? null;

    return selectedMatch
      ? [
          {
            from: selectedMatch.from,
            active: suggestion.active,
            id: suggestion.id,
            source: suggestion.source,
            to: selectedMatch.to,
          },
        ]
      : [];
  });
}

function collectTextRuns(doc: ProseMirrorNode) {
  const runsByParent = new Map<ProseMirrorNode, TextPiece[]>();

  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text || !parent) {
      return true;
    }

    const pieces = runsByParent.get(parent) ?? [];
    const start = pieces.at(-1)?.end ?? 0;
    pieces.push({
      end: start + node.text.length,
      pos,
      start,
      text: node.text,
    });
    runsByParent.set(parent, pieces);

    return true;
  });

  return Array.from(runsByParent.values()).filter((pieces) => pieces.length > 0);
}

function findValidSelectionRange(doc: ProseMirrorNode, suggestion: AiSuggestionHighlightInput) {
  const range = suggestion.selectionRange;
  if (!range || range.from < 0 || range.to <= range.from || range.to > doc.content.size) {
    return null;
  }

  const selectedText = doc.textBetween(range.from, range.to, "\n").trim();
  return doesTextMatch(selectedText, suggestion.targetText) ? range : null;
}

function findMatchesInDocumentText(doc: ProseMirrorNode, targetText: string) {
  const pieces = collectDocumentTextPieces(doc);
  const documentText = buildDocumentText(pieces);
  const normalizedTargetText = normalizeNewlines(targetText);
  const matches: Array<{ from: number; to: number }> = [];
  let offset = documentText.indexOf(normalizedTargetText);

  while (offset !== -1) {
    const from = mapRunOffsetToDocPos(pieces, offset);
    const to = mapRunOffsetToDocPos(pieces, offset + normalizedTargetText.length);
    if (from !== null && to !== null) {
      matches.push({ from, to });
    }

    offset = documentText.indexOf(normalizedTargetText, offset + 1);
  }

  return matches;
}

function collectDocumentTextPieces(doc: ProseMirrorNode) {
  const pieces: TextPiece[] = [];
  let documentOffset = 0;
  let previousParent: ProseMirrorNode | null = null;

  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text || !parent) {
      return true;
    }

    if (pieces.length > 0 && parent !== previousParent) {
      documentOffset += 1;
    }

    pieces.push({
      end: documentOffset + node.text.length,
      pos,
      start: documentOffset,
      text: node.text,
    });
    documentOffset += node.text.length;
    previousParent = parent;

    return true;
  });

  return pieces;
}

function buildDocumentText(pieces: TextPiece[]) {
  let text = "";
  let offset = 0;

  for (const piece of pieces) {
    if (piece.start > offset) {
      text += "\n".repeat(piece.start - offset);
    }

    text += piece.text;
    offset = piece.end;
  }

  return text;
}

function findMatchesInTextRun(pieces: TextPiece[], targetText: string) {
  const runText = pieces.map((piece) => piece.text).join("");
  const matches: Array<{ from: number; to: number }> = [];
  const normalizedTargetText = normalizeNewlines(targetText);
  let offset = runText.indexOf(normalizedTargetText);

  while (offset !== -1) {
    const from = mapRunOffsetToDocPos(pieces, offset);
    const to = mapRunOffsetToDocPos(pieces, offset + normalizedTargetText.length);
    if (from !== null && to !== null) {
      matches.push({ from, to });
    }

    offset = runText.indexOf(normalizedTargetText, offset + 1);
  }

  return matches;
}

function mapRunOffsetToDocPos(pieces: TextPiece[], offset: number) {
  for (const piece of pieces) {
    if (offset >= piece.start && offset <= piece.end) {
      return piece.pos + offset - piece.start;
    }
  }

  return null;
}

function uniqueRanges(ranges: Array<{ from: number; to: number }>) {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.from}:${range.to}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function doesTextMatch(left: string, right: string) {
  return normalizeLineText(left) === normalizeLineText(right) || normalizeLooseText(left) === normalizeLooseText(right);
}

function normalizeLineText(text: string) {
  return normalizeNewlines(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeLooseText(text: string) {
  return normalizeNewlines(text).replace(/\s+/g, " ").trim();
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n/g, "\n");
}
