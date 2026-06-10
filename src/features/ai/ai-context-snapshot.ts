export type AiContextSnapshotMode = "document_review" | "selection_rewrite";

export type AiContextTextTruncation = {
  shownChars: number;
  strategy: "head-tail";
  totalChars: number;
};

export type AiContextSnapshot = {
  ai?: {
    model?: string;
    provider?: string;
  };
  command: string;
  document: {
    charCount: number;
    id: string;
    metadata?: Record<string, unknown>;
    readiness?: string;
    text: string;
    title: string;
    truncation?: AiContextTextTruncation;
  };
  mode: AiContextSnapshotMode;
  references: {
    documents: Array<{
      charCount: number;
      id: string;
      text: string;
      title: string;
      truncation?: AiContextTextTruncation;
    }>;
  };
  schemaVersion: 2;
  selection?: {
    charCount: number;
    occurrenceIndex?: number;
    range?: {
      from: number;
      to: number;
    };
    text: string;
    truncation?: AiContextTextTruncation;
  };
  template: {
    category?: string;
    id: string;
    name: string;
  };
  variables: {
    names: string[];
    values: Record<string, string>;
  };
};

export type BuildAiContextSnapshotInput = {
  ai?: AiContextSnapshot["ai"];
  command: string;
  document: {
    id: string;
    metadata?: Record<string, unknown>;
    readiness?: string;
    text: string;
    title: string;
  };
  mode: AiContextSnapshotMode;
  references?: {
    documents: Array<{
      id: string;
      text: string;
      title: string;
    }>;
  };
  selection?: {
    occurrenceIndex?: number;
    range?: { from: number; to: number };
    text: string;
  };
  template: {
    category?: string;
    id: string;
    name: string;
  };
  variables: Record<string, unknown>;
};

export type BuildAiContextSnapshotOptions = {
  maxDocumentChars?: number;
  maxReferenceChars?: number;
  maxSelectionChars?: number;
  maxVariableChars?: number;
};

const DEFAULT_MAX_DOCUMENT_CHARS = 12_000;
const DEFAULT_MAX_REFERENCE_CHARS = 8_000;
const DEFAULT_MAX_SELECTION_CHARS = 4_000;
const DEFAULT_MAX_VARIABLE_CHARS = 1_000;

function compactText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { text: value };
  }

  const headLength = Math.ceil(maxChars / 2);
  const tailLength = Math.floor(maxChars / 2);
  return {
    text: `${value.slice(0, headLength)}\n...\n${value.slice(-tailLength)}`,
    truncation: {
      shownChars: headLength + tailLength,
      strategy: "head-tail" as const,
      totalChars: value.length,
    },
  };
}

function isSensitiveVariableName(name: string) {
  return /(api[-_]?key|secret|token|password|credential)/i.test(name);
}

function serializeVariableValue(name: string, value: unknown, maxChars: number) {
  if (isSensitiveVariableName(name)) {
    return "[redacted]";
  }

  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return compactText(serialized ?? "", maxChars).text;
}

export function buildAiContextSnapshot(
  input: BuildAiContextSnapshotInput,
  options: BuildAiContextSnapshotOptions = {},
): AiContextSnapshot {
  const maxDocumentChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;
  const maxReferenceChars = options.maxReferenceChars ?? DEFAULT_MAX_REFERENCE_CHARS;
  const maxSelectionChars = options.maxSelectionChars ?? DEFAULT_MAX_SELECTION_CHARS;
  const maxVariableChars = options.maxVariableChars ?? DEFAULT_MAX_VARIABLE_CHARS;
  const documentText = compactText(input.document.text, maxDocumentChars);
  const variableNames = Object.keys(input.variables).sort();
  const variableValues = variableNames.reduce<Record<string, string>>((values, name) => {
    values[name] = serializeVariableValue(name, input.variables[name], maxVariableChars);
    return values;
  }, {});
  const selectionText = input.selection ? compactText(input.selection.text, maxSelectionChars) : null;
  const referencedDocuments = buildReferencedDocuments(input.references?.documents ?? [], maxReferenceChars);

  return {
    ai: input.ai,
    command: input.command,
    document: {
      charCount: input.document.text.length,
      id: input.document.id,
      metadata: input.document.metadata,
      readiness: input.document.readiness,
      text: documentText.text,
      title: input.document.title,
      truncation: documentText.truncation,
    },
    mode: input.mode,
    references: {
      documents: referencedDocuments,
    },
    schemaVersion: 2,
    selection: input.selection
      ? {
          charCount: input.selection.text.length,
          occurrenceIndex: input.selection.occurrenceIndex,
          range: input.selection.range,
          text: selectionText!.text,
          truncation: selectionText!.truncation,
        }
      : undefined,
    template: input.template,
    variables: {
      names: variableNames,
      values: variableValues,
    },
  };
}

function buildReferencedDocuments(
  documents: NonNullable<BuildAiContextSnapshotInput["references"]>["documents"],
  maxReferenceChars: number,
) {
  const seen = new Set<string>();
  return documents.flatMap((document) => {
    if (seen.has(document.id)) {
      return [];
    }

    seen.add(document.id);
    const text = compactText(document.text, maxReferenceChars);
    return [
      {
        charCount: document.text.length,
        id: document.id,
        text: text.text,
        title: document.title,
        truncation: text.truncation,
      },
    ];
  });
}

export function formatAiContextSnapshotForCopy(snapshot: AiContextSnapshot) {
  return JSON.stringify(snapshot, null, 2);
}
