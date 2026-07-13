"use client";

import Link from "next/link";
import {
  ChevronsLeft,
  Code2,
  Download,
  FileText,
  Library,
  MessageCircle,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PlusCircle,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type MutableRefObject,
} from "react";
import type { AiProposalApplyMode, AiReviewProposal, AiReviewSummary } from "@/components/ai/AiReviewPanel";
import { AiContextInspector } from "@/components/ai/AiContextInspector";
import { AiRunHistory, type AiRunHistoryItem } from "@/components/ai/AiRunHistory";
import {
  AiWorkspacePanel,
  type AiWorkspaceChangeItem,
  type AiWorkspaceChatMessage,
  type AiWorkspaceChatSession,
} from "@/components/ai/AiWorkspacePanel";
import { AiSettingsDialog } from "@/components/settings/AiSettingsDialog";
import { getTemplateVariableLabel, PromptTemplatePanel } from "@/components/templates/PromptTemplatePanel";
import type {
  AiProposalRecord,
  AiRunRecord,
  DocumentMetadata,
  DocumentReadiness,
  DocumentRecord,
  PromptTemplateRecord,
  TiptapJson,
} from "@/db/schema";
import {
  archiveAiWorkspaceSession,
  renameAiWorkspaceSession,
  readAiWorkspaceSessionsForDocument,
  writeAiWorkspaceSessionsForDocument,
} from "@/features/ai/ai-workspace-session-store";
import { buildAiContextSnapshot } from "@/features/ai/ai-context-snapshot";
import { resolveDocumentShortcut } from "@/features/commands/document-command-manifest";
import { buildDocumentOutline, type DocumentOutlineItem } from "@/features/documents/document-outline";
import {
  createDocumentSessionClient,
  DocumentSessionConflictError,
  DocumentSessionRequestError,
  type DocumentSessionChange,
  type DocumentSessionHistoryChange,
  type DocumentSessionProposal,
} from "@/features/documents/document-session-client";
import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import {
  EDITOR_LANGUAGE_STORAGE_KEY,
  DEFAULT_EDITOR_LANGUAGE,
  editorLanguageOptions,
  editorMessages,
  formatEditorMessage,
  getSelectionCommandLabel,
  isEditorLanguage,
  type EditorLanguage,
} from "@/features/i18n/editor-language";
import {
  applyProposalToTiptapDraft,
  createProposalContentSignature,
  getProposalApplicationOrder,
  getProposalSelectionRange,
  isProposalSnapshotStale,
  type ProposalTransactionContext,
} from "@/features/proposals/proposal-transaction";
import type { AiDocumentReferenceCandidate, ResolvedAiDocumentReference } from "@/features/ai/ai-reference-parser";
import { validateTemplateVariables } from "@/features/templates/template-validation";
import type { EditorSelectionCommandMetadata } from "@/plugins/types";
import { DocumentEditor, type RunningSelectionAiCommand, type SelectionAiCommandContext } from "./DocumentEditor";
import { DocumentCommandPalette } from "./DocumentCommandPalette";
import { DocumentMetadataPanel } from "./DocumentMetadataPanel";
import { DocumentOutlinePanel } from "./DocumentOutlinePanel";
import { DocumentSourceView } from "./DocumentSourceView";
import { buildDocumentCommandRegistry } from "./commands/document-command-registry";
import type { DocumentCommandAction } from "./commands/document-command-types";
import type { SelectionAiResultPreview } from "./SelectionAiResultPopover";

type ShellDocument = Pick<DocumentRecord, "id" | "title" | "contentJson" | "plainText" | "revision"> &
  Partial<Pick<DocumentRecord, "metadataJson" | "readiness">>;
type ShellTemplate = Pick<PromptTemplateRecord, "id" | "name" | "category" | "variableSchemaJson">;
type ShellTemplateField = ShellTemplate["variableSchemaJson"]["fields"][number];
type ShellAiRun = Pick<AiRunRecord, "id" | "commandType" | "status" | "createdAt">;
type ShellProposal = Pick<
  AiProposalRecord,
  | "id"
  | "targetText"
  | "replacementText"
  | "explanation"
  | "source"
  | "command"
  | "occurrenceIndex"
  | "targetFrom"
  | "targetTo"
  | "defaultApplyMode"
  | "appliedMode"
  | "status"
>;
export type SaveState = "saved" | "dirty" | "saving" | "failed";
export type EditorSurface = "editor" | "source";

type DocumentShellProps = {
  document: ShellDocument;
  referenceDocuments?: AiDocumentReferenceCandidate[];
  templates: ShellTemplate[];
  aiRuns: ShellAiRun[];
  proposals?: ShellProposal[];
};

type DraftState = {
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
};

type SelectionCommandPayload = {
  command: string;
  commandMetadata?: EditorSelectionCommandMetadata;
  context?: SelectionAiCommandContext;
  defaultApplyMode: AiProposalApplyMode;
  selectedText: string;
  contentJson: TiptapJson;
  references: ResolvedAiDocumentReference[];
  template: Pick<ShellTemplate, "category" | "id" | "name"> | null;
  title: string;
  variables: Record<string, string>;
};

type SelectionProposalContext = ProposalTransactionContext;

type DocumentSnapshot = {
  id: string;
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
  revision: number;
};

type AiSnapshot = {
  aiRuns: ShellAiRun[];
  proposals: ShellProposal[];
};

type ReviewResponse = {
  review?: {
    findings?: unknown[];
    summary?: string;
  };
  run?: ShellAiRun;
  proposals?: ShellProposal[];
  skippedProposalCount?: number;
};

type RewriteResponse = {
  run?: ShellAiRun;
  proposal?: ShellProposal | null;
};

const MAX_CONCURRENT_SELECTION_COMMANDS = 5;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const COMPACT_WORKSPACE_MEDIA_QUERY = "(max-width: 1279px)";

function resolveServerRevision(
  currentRevision: number,
  returnedRevision: number,
  mode: "advance" | "reset" = "advance",
) {
  if (!Number.isSafeInteger(returnedRevision) || returnedRevision < 0) {
    return currentRevision;
  }

  return mode === "reset"
    ? returnedRevision
    : Math.max(currentRevision, returnedRevision);
}

type ProposalStatusPatchPayload = {
  appliedMode?: AiProposalApplyMode;
  expectedStatus?: ShellProposal["status"];
  status: ShellProposal["status"];
};

class ProposalStatusConflictError extends Error {
  proposal: AiReviewProposal;

  constructor(proposal: AiReviewProposal) {
    super("Proposal status conflict");
    this.name = "ProposalStatusConflictError";
    this.proposal = proposal;
  }
}

function isProposalStatusConflictError(error: unknown): error is ProposalStatusConflictError {
  return error instanceof ProposalStatusConflictError;
}

function createDraftFromDocumentSnapshot(document: DocumentSnapshot): DraftState {
  return {
    contentJson: document.contentJson,
    metadataJson: document.metadataJson ?? {},
    readiness: document.readiness ?? "draft",
    title: document.title,
  };
}

function documentMatchesDraft(document: DocumentSnapshot, draft: DraftState) {
  return document.title === draft.title &&
    document.readiness === draft.readiness &&
    JSON.stringify(document.contentJson) === JSON.stringify(draft.contentJson) &&
    JSON.stringify(document.metadataJson) === JSON.stringify(draft.metadataJson);
}

async function patchProposalStatus(proposalId: string, payload: ProposalStatusPatchPayload) {
  const response = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as { proposal?: AiReviewProposal };

  if (response.ok) {
    return body.proposal ?? null;
  }

  if (response.status === 409 && body.proposal) {
    throw new ProposalStatusConflictError(body.proposal);
  }

  throw new Error("Failed to update proposal status");
}

const documentSessionClient = createDocumentSessionClient((input, init) => fetch(input, init));

function createHistoryChange(
  change: DocumentSessionChange,
  proposals: DocumentSessionProposal[],
): DocumentSessionHistoryChange {
  return {
    ...change,
    proposals: proposals.map((proposal, ordinal) => ({
      id: proposal.id,
      targetText: proposal.targetText,
      replacementText: proposal.replacementText,
      appliedMode: proposal.appliedMode ?? proposal.defaultApplyMode ?? "replace",
      ordinal,
    })),
  };
}

function mergeDocumentChanges(
  currentChanges: DocumentSessionHistoryChange[],
  incomingChanges: DocumentSessionHistoryChange[],
) {
  const mergedChanges = new Map(currentChanges.map((change) => [change.id, change]));
  for (const change of incomingChanges) {
    mergedChanges.set(change.id, change);
  }
  return [...mergedChanges.values()];
}

function getSessionConflictProposal(error: unknown): AiReviewProposal | null {
  if (!(error instanceof DocumentSessionRequestError)) return null;
  const proposal = error.body.proposal;
  return proposal && typeof proposal === "object" && "id" in proposal
    ? proposal as AiReviewProposal
    : null;
}

function subscribeCompactWorkspaceLayout(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const mediaQuery = window.matchMedia(COMPACT_WORKSPACE_MEDIA_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getCompactWorkspaceLayoutSnapshot() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_WORKSPACE_MEDIA_QUERY).matches;
}

function getCompactWorkspaceLayoutServerSnapshot() {
  return false;
}

export function DocumentShell({ aiRuns, document, proposals = [], referenceDocuments = [], templates }: DocumentShellProps) {
  return (
    <DocumentShellContent
      key={document.id}
      aiRuns={aiRuns}
      document={document}
      proposals={proposals}
      referenceDocuments={referenceDocuments}
      templates={templates}
    />
  );
}

function DocumentShellContent({ aiRuns, document, proposals = [], referenceDocuments = [], templates }: DocumentShellProps) {
  const initialTemplateVariables = useMemo(
    () => mergeMissingTemplateVariableDefaults(templates[0] ?? null, {}),
    [templates],
  );
  const incomingDocument = useMemo(
    () => ({
      id: document.id,
      title: document.title,
      contentJson: document.contentJson,
      metadataJson: document.metadataJson ?? {},
      readiness: document.readiness ?? "draft",
      revision: document.revision,
    }),
    [document.contentJson, document.id, document.metadataJson, document.readiness, document.revision, document.title],
  );
  const initialDraft = useMemo(
    () => ({
      title: incomingDocument.title,
      contentJson: incomingDocument.contentJson,
      metadataJson: document.metadataJson ?? {},
      readiness: document.readiness ?? "draft",
    }),
    [document.metadataJson, document.readiness, incomingDocument],
  );
  const [draft, setDraft] = useState<DraftState>(initialDraft);
  const draftRef = useRef<DraftState>(initialDraft);
  const draftVersionRef = useRef(0);
  const persistedDraftVersionRef = useRef(0);
  const saveRequestGenerationRef = useRef(0);
  const intentionalNavigationRef = useRef(false);
  const conflictCopyRef = useRef<{ id: string; revision: number } | null>(null);
  const conflictCopyCreationKeyRef = useRef<string | null>(null);
  const serverContentSignatureRef = useRef(createProposalContentSignature(incomingDocument.contentJson));
  const serverRevisionRef = useRef(incomingDocument.revision);
  const [serverRevision, setServerRevision] = useState(incomingDocument.revision);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveConflict, setSaveConflict] = useState<{
    localDraft: DraftState;
    serverDocument: DocumentSnapshot;
  } | null>(null);
  const [saveConflictNotice, setSaveConflictNotice] = useState("");
  const [isSavingConflictCopy, setIsSavingConflictCopy] = useState(false);
  const [language, setLanguage] = useState<EditorLanguage>(() => readStoredEditorLanguage());
  const [selectionCommand, setSelectionCommand] = useState<SelectionCommandPayload | null>(null);
  const [selectionAiResult, setSelectionAiResult] = useState<SelectionAiResultPreview | null>(null);
  const [selectionApplicationNotice, setSelectionApplicationNotice] = useState("");
  const [selectionProposalContexts, setSelectionProposalContexts] = useState<Record<string, SelectionProposalContext>>({});
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const [aiChatMessages, setAiChatMessages] = useState<AiWorkspaceChatMessage[]>([]);
  const [aiChatSessions, setAiChatSessions] = useState<AiWorkspaceChatSession[]>(() =>
    restoreAiWorkspaceChatSessions(document.id),
  );
  const [documentChanges, setDocumentChanges] = useState<DocumentSessionHistoryChange[]>([]);
  const [documentChangesNextCursor, setDocumentChangesNextCursor] = useState<string | null>(null);
  const documentChangesLoadedRef = useRef(false);
  const documentChangesLoadingRef = useRef(false);
  const [isLoadingDocumentChanges, setIsLoadingDocumentChanges] = useState(false);
  const [documentChangesError, setDocumentChangesError] = useState("");
  const [undoChangeError, setUndoChangeError] = useState("");
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const aiWorkspaceIdRef = useRef(0);
  const runningSelectionCommandsRef = useRef<RunningSelectionAiCommand[]>([]);
  const [observedDocument, setObservedDocument] = useState<DocumentSnapshot>(incomingDocument);
  const [observedAiSnapshot, setObservedAiSnapshot] = useState<AiSnapshot>({ aiRuns, proposals });
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [reviewProposals, setReviewProposals] = useState<AiReviewProposal[]>(proposals);
  const [reviewRuns, setReviewRuns] = useState<AiRunHistoryItem[]>(aiRuns);
  const [reviewSummary, setReviewSummary] = useState<AiReviewSummary | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>(initialTemplateVariables);
  const [templateVariableErrors, setTemplateVariableErrors] = useState<Record<string, string>>({});
  const [runningSelectionCommands, setRunningSelectionCommands] = useState<RunningSelectionAiCommand[]>([]);
  const isCompactWorkspace = useSyncExternalStore(
    subscribeCompactWorkspaceLayout,
    getCompactWorkspaceLayoutSnapshot,
    getCompactWorkspaceLayoutServerSnapshot,
  );
  const [workspaceOpenOverride, setWorkspaceOpenOverride] = useState<boolean | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCreatingDocument, setIsCreatingDocument] = useState(false);
  const [editorSurface, setEditorSurface] = useState<EditorSurface>("editor");
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string | null>(null);
  const [outlineFocusRequest, setOutlineFocusRequest] = useState<{ requestId: string; topLevelIndex: number } | null>(
    null,
  );
  const activeTemplateId = templates.some((template) => template.id === selectedTemplateId)
    ? selectedTemplateId
    : templates[0]?.id ?? "";
  const selectedTemplate = templates.find((template) => template.id === activeTemplateId) ?? null;
  const messages = editorMessages[language];
  const selectionCommandLabel = selectionCommand ? getSelectionCommandLabel(selectionCommand.command, language) : "";
  const isRewritingSelection = runningSelectionCommands.length > 0;
  const isSelectionCommandLimitReached = runningSelectionCommands.length >= MAX_CONCURRENT_SELECTION_COMMANDS;
  const isInternalNavigationBlocked = saveState !== "saved";
  const adoptServerRevision = useCallback((returnedRevision: number, mode: "advance" | "reset" = "advance") => {
    const nextRevision = resolveServerRevision(serverRevisionRef.current, returnedRevision, mode);
    serverRevisionRef.current = nextRevision;
    setServerRevision(nextRevision);
  }, []);
  const enterRevisionConflictRecovery = useCallback((serverDocument: DocumentSnapshot) => {
    saveRequestGenerationRef.current += 1;
    intentionalNavigationRef.current = false;
    conflictCopyRef.current = null;
    conflictCopyCreationKeyRef.current = null;
    setSaveConflict({
      localDraft: draftRef.current,
      serverDocument,
    });
    setSaveConflictNotice("");
    setSaveState("failed");
  }, []);
  const recoverSessionRevisionConflict = useCallback((error: unknown) => {
    if (!(error instanceof DocumentSessionConflictError)) return false;
    enterRevisionConflictRecovery(error.serverDocument);
    return true;
  }, [enterRevisionConflictRecovery]);
  const updateRunningSelectionCommands = useCallback(
    (updater: (commands: RunningSelectionAiCommand[]) => RunningSelectionAiCommand[]) => {
      const nextCommands = updater(runningSelectionCommandsRef.current);
      runningSelectionCommandsRef.current = nextCommands;
      setRunningSelectionCommands(nextCommands);
    },
    [],
  );

  useEffect(() => {
    runningSelectionCommandsRef.current = runningSelectionCommands;
  }, [runningSelectionCommands]);

  useEffect(() => {
    writeAiWorkspaceSessionsForDocument(document.id, aiChatSessions);
  }, [aiChatSessions, document.id]);

  const isWorkspaceOpen = workspaceOpenOverride ?? !isCompactWorkspace;
  const setWorkspaceOpen = useCallback(
    (nextValue: boolean | ((currentValue: boolean) => boolean)) => {
      setWorkspaceOpenOverride((currentOverride) => {
        const currentValue = currentOverride ?? !isCompactWorkspace;
        return typeof nextValue === "function" ? nextValue(currentValue) : nextValue;
      });
    },
    [isCompactWorkspace],
  );
  const openFind = useCallback(() => {
    setEditorSurface("editor");
    setIsFindOpen(true);
  }, []);

  useEffect(() => {
    const handleDocumentShortcut = (event: KeyboardEvent) => {
      const commandId = resolveDocumentShortcut(event);
      if (!commandId) {
        return;
      }

      event.preventDefault();

      if (commandId === "open-command-palette") {
        setIsCommandPaletteOpen(true);
        return;
      }

      if (commandId === "find-document") {
        openFind();
      }
    };

    window.addEventListener("keydown", handleDocumentShortcut);
    return () => window.removeEventListener("keydown", handleDocumentShortcut);
  }, [openFind]);

  const isDocumentNavigation = observedDocument.id !== incomingDocument.id;
  const shouldIgnoreSameDocumentSnapshot =
    !isDocumentNavigation &&
    (incomingDocument.revision < serverRevision || saveState !== "saved");
  const hasIncomingDocumentChange =
    isDocumentNavigation ||
    observedDocument.title !== incomingDocument.title ||
    observedDocument.contentJson !== incomingDocument.contentJson ||
    observedDocument.metadataJson !== incomingDocument.metadataJson ||
    observedDocument.readiness !== incomingDocument.readiness ||
    observedDocument.revision !== incomingDocument.revision;

  if (hasIncomingDocumentChange && !shouldIgnoreSameDocumentSnapshot) {
    setObservedDocument(incomingDocument);
    setServerRevision((currentRevision) => resolveServerRevision(
      currentRevision,
      incomingDocument.revision,
      isDocumentNavigation ? "reset" : "advance",
    ));

    if (saveState === "saved") {
      setDraft(initialDraft);
      setSelectionCommand(null);
      setSelectionAiResult(null);
      setSelectionApplicationNotice("");
      setSelectionProposalContexts({});
      setActiveProposalId(null);
      setAiChatMessages([]);
      setAiChatSessions(restoreAiWorkspaceChatSessions(incomingDocument.id));
      setDocumentChanges([]);
      setDocumentChangesNextCursor(null);
      setIsLoadingDocumentChanges(false);
      setDocumentChangesError("");
      setUndoChangeError("");
      setSaveConflict(null);
      setSaveConflictNotice("");
      setEditorSurface("editor");
      setIsCommandPaletteOpen(false);
      setIsFindOpen(false);
      setActiveOutlineItemId(null);
      setOutlineFocusRequest(null);
      setSelectedTemplateId(templates[0]?.id ?? "");
      setReviewProposals(proposals);
      setReviewRuns(aiRuns);
      setReviewSummary(null);
      setIsReviewing(false);
      setReviewError("");
      setTemplateVariables(initialTemplateVariables);
      setTemplateVariableErrors({});
      setRunningSelectionCommands([]);
    }
  }

  if (observedAiSnapshot.aiRuns !== aiRuns || observedAiSnapshot.proposals !== proposals) {
    setObservedAiSnapshot({ aiRuns, proposals });
    setReviewRuns(aiRuns);
    if (!reviewSummary || reviewProposals.length > 0) {
      setReviewProposals(proposals);
    }
  }

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    documentChangesLoadedRef.current = false;
    documentChangesLoadingRef.current = false;
    conflictCopyRef.current = null;
    conflictCopyCreationKeyRef.current = null;
    persistedDraftVersionRef.current = draftVersionRef.current;
  }, [observedDocument]);

  useEffect(() => {
    serverRevisionRef.current = serverRevision;
  }, [serverRevision]);

  useEffect(() => {
    serverContentSignatureRef.current = createProposalContentSignature(observedDocument.contentJson);
  }, [observedDocument.contentJson]);

  const handleDraftChange = useCallback((nextDraft: Pick<DraftState, "contentJson" | "title">) => {
    draftVersionRef.current += 1;
    setDraft((currentDraft) => {
      const updatedDraft = { ...currentDraft, ...nextDraft };
      draftRef.current = updatedDraft;
      return updatedDraft;
    });
    setSaveConflict((currentConflict) => currentConflict
      ? { ...currentConflict, localDraft: { ...currentConflict.localDraft, ...nextDraft } }
      : null);
    setSaveConflictNotice("");
    setSaveState("dirty");
  }, []);
  const handleMetadataChange = useCallback((change: { metadataJson?: DocumentMetadata; readiness?: DocumentReadiness }) => {
    draftVersionRef.current += 1;
    setDraft((currentDraft) => {
      const updatedDraft = { ...currentDraft, ...change };
      draftRef.current = updatedDraft;
      return updatedDraft;
    });
    setSaveConflict((currentConflict) => currentConflict
      ? { ...currentConflict, localDraft: { ...currentConflict.localDraft, ...change } }
      : null);
    setSaveConflictNotice("");
    setSaveState("dirty");
  }, []);

  const handleLanguageChange = useCallback((nextLanguage: string) => {
    if (!isEditorLanguage(nextLanguage)) {
      return;
    }

    setLanguage(nextLanguage);
    window.localStorage.setItem(EDITOR_LANGUAGE_STORAGE_KEY, nextLanguage);
  }, []);

  const createNewDocument = useCallback(async () => {
    if (isInternalNavigationBlocked) {
      return;
    }

    setIsCreatingDocument(true);

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: messages.shell.untitledDocument }),
      });

      if (!response.ok) {
        throw new Error("Failed to create document");
      }

      const body = (await response.json()) as { document?: { id?: string } };
      if (body.document?.id) {
        window.location.assign(`/documents/${body.document.id}`);
      }
    } catch {
      setReviewError(messages.errors.createDocumentFailed);
    } finally {
      setIsCreatingDocument(false);
    }
  }, [isInternalNavigationBlocked, messages.errors.createDocumentFailed, messages.shell.untitledDocument]);

  const handleInternalNavigationClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (isInternalNavigationBlocked) {
      event.preventDefault();
    }
  }, [isInternalNavigationBlocked]);

  const handleSelectionCommand = useCallback(async (
    command: string,
    selectedText: string,
    context?: SelectionAiCommandContext,
    references: ResolvedAiDocumentReference[] = [],
    commandMetadata?: EditorSelectionCommandMetadata,
  ) => {
    setSelectionAiResult(null);
    setSelectionApplicationNotice("");
    const defaultApplyMode = commandMetadata?.defaultApplyMode ?? getDefaultApplyModeForCommand(command);

    if (!selectedTemplate) {
      setSelectionCommand({
        command,
        commandMetadata,
        context,
        defaultApplyMode,
        selectedText,
        contentJson: draft.contentJson,
        references,
        template: null,
        title: draft.title,
        variables: {},
      });
      setReviewError(messages.errors.selectTemplateForSelection);
      return;
    }

    const variablesWithDefaults = mergeMissingTemplateVariableDefaults(selectedTemplate, templateVariables);
    const variablesForCommand = collectTemplateVariables(selectedTemplate, variablesWithDefaults);
    setSelectionCommand({
      command,
      commandMetadata,
      context,
      defaultApplyMode,
      selectedText,
      contentJson: draft.contentJson,
      references,
      template: {
        category: selectedTemplate.category,
        id: selectedTemplate.id,
        name: selectedTemplate.name,
      },
      title: draft.title,
      variables: variablesForCommand,
    });
    setTemplateVariables(variablesWithDefaults);

    const variableValidation = validateTemplateVariables(selectedTemplate.variableSchemaJson, variablesForCommand);
    if (!variableValidation.ok) {
      setTemplateVariableErrors(localizeTemplateVariableErrors(selectedTemplate, variableValidation.errors, messages));
      setReviewError(messages.errors.fillSelectionVariables);
      return;
    }

    if (runningSelectionCommandsRef.current.length >= MAX_CONCURRENT_SELECTION_COMMANDS) {
      setReviewError(messages.errors.selectionConcurrencyLimit);
      return;
    }

    const runningCommandId = createWorkspaceClientId(aiWorkspaceIdRef, "selection_job");
    const chatSessionId = createWorkspaceClientId(aiWorkspaceIdRef, "chat_session");
    const chatSessionCreatedAt = new Date();
    const chatUserMessage: AiWorkspaceChatMessage = {
      command,
      content: selectedText,
      createdAt: chatSessionCreatedAt,
      id: createWorkspaceClientId(aiWorkspaceIdRef, "user"),
      role: "user",
      scopeLabel: getCommandScopeLabel(context?.scope, messages),
    };
    updateRunningSelectionCommands((currentCommands) => [
      {
        anchor: context?.anchor,
        command,
        id: runningCommandId,
      },
      ...currentCommands,
    ]);
    setReviewError("");
    setTemplateVariableErrors({});
    setUndoChangeError("");
    setAiChatMessages((currentMessages) => [...currentMessages, chatUserMessage]);
    setAiChatSessions((currentSessions) => [
      {
        command,
        createdAt: chatSessionCreatedAt,
        id: chatSessionId,
        messages: [chatUserMessage],
        status: "running",
        title: getSelectionCommandLabel(command, language),
        updatedAt: chatSessionCreatedAt,
      },
      ...currentSessions,
    ]);

    try {
      const response = await fetch("/api/ai/rewrite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          templateId: selectedTemplate.id,
          command,
          defaultApplyMode,
          references: {
            documents: references.map((reference) => ({
              documentId: reference.id,
              titleSnapshot: reference.title,
            })),
          },
          variables: variablesForCommand,
          selectedText,
          occurrenceIndex: context?.occurrenceIndex,
          selectionRange: context?.selectionRange,
          documentText: extractPlainTextFromTiptap(draft.contentJson),
          beforeContext: "",
          afterContext: "",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to rewrite selection");
      }

      const body = (await response.json()) as RewriteResponse;
      if (body.proposal) {
        const proposalSelectionRange = getProposalSelectionRange(body.proposal, context);
        setReviewProposals((currentProposals) => [body.proposal!, ...currentProposals]);
        setSelectionProposalContexts((currentContexts) => ({
          ...currentContexts,
          [body.proposal!.id]: {
            command,
            contentSignature: createProposalContentSignature(draft.contentJson),
            occurrenceIndex: body.proposal!.occurrenceIndex ?? context?.occurrenceIndex,
            scope: context?.scope,
            selectedText,
            selectionRange: proposalSelectionRange,
          },
        }));
        setSelectionAiResult({
          anchor: context?.anchor,
          command,
          defaultApplyMode:
            body.proposal.source === "selection"
              ? body.proposal.defaultApplyMode ?? defaultApplyMode
              : defaultApplyMode,
          explanation: body.proposal.explanation,
          proposalId: body.proposal.id,
          replacementText: body.proposal.replacementText,
          targetText: body.proposal.targetText,
        });
        const chatSessionUpdatedAt = new Date();
        const chatAssistantMessage: AiWorkspaceChatMessage = {
          command,
          content: body.proposal.replacementText,
          createdAt: chatSessionUpdatedAt,
          id: createWorkspaceClientId(aiWorkspaceIdRef, "assistant"),
          proposalId: body.proposal.id,
          role: "assistant",
          runId: body.run?.id,
        };
        setAiChatMessages((currentMessages) => [...currentMessages, chatAssistantMessage]);
        setAiChatSessions((currentSessions) =>
          currentSessions.map((session) =>
            session.id === chatSessionId
              ? {
                  ...session,
                  messages: [...session.messages, chatAssistantMessage],
                  status: "idle",
                  updatedAt: chatSessionUpdatedAt,
                }
              : session,
          ),
        );
      }
      if (body.run) {
        setReviewRuns((currentRuns) => [body.run!, ...currentRuns]);
      }
      setAiChatSessions((currentSessions) =>
        currentSessions.map((session) => (session.id === chatSessionId ? { ...session, status: "idle" } : session)),
      );
    } catch {
      const failedAt = new Date();
      setAiChatSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === chatSessionId ? { ...session, status: "failed", updatedAt: failedAt } : session,
        ),
      );
      setReviewError(messages.errors.selectionRewriteFailed);
    } finally {
      updateRunningSelectionCommands((currentCommands) =>
        currentCommands.filter((runningCommand) => runningCommand.id !== runningCommandId),
      );
    }
  }, [
    document.id,
    draft.contentJson,
    draft.title,
    language,
    messages,
    selectedTemplate,
    templateVariables,
    updateRunningSelectionCommands,
  ]);

  const saveDraft = useCallback(async () => {
    if (saveConflict) return;
    const requestGeneration = saveRequestGenerationRef.current + 1;
    saveRequestGenerationRef.current = requestGeneration;
    const savingVersion = draftVersionRef.current;
    const savingDraft = draft;
    const expectedRevision = serverRevisionRef.current;

    setSaveState("saving");

    const result = await documentSessionClient.save(document.id, savingDraft, expectedRevision);
    if (result.kind === "saved") {
      persistedDraftVersionRef.current = Math.max(persistedDraftVersionRef.current, savingVersion);
      adoptServerRevision(result.document.revision);
      if (draftVersionRef.current === savingVersion) {
        serverContentSignatureRef.current = createProposalContentSignature(result.document.contentJson);
      }
      if (requestGeneration !== saveRequestGenerationRef.current) return;
      setSaveState(draftVersionRef.current === savingVersion ? "saved" : "dirty");
      return;
    }
    if (result.kind === "conflict") {
      if (requestGeneration !== saveRequestGenerationRef.current) return;
      if (persistedDraftVersionRef.current >= savingVersion) {
        setSaveState(draftVersionRef.current <= persistedDraftVersionRef.current ? "saved" : "dirty");
        return;
      }
      enterRevisionConflictRecovery(result.serverDocument);
      return;
    }
    if (requestGeneration !== saveRequestGenerationRef.current) return;
    setSaveState(draftVersionRef.current === savingVersion ? "failed" : "dirty");
  }, [adoptServerRevision, document.id, draft, enterRevisionConflictRecovery, saveConflict]);

  useEffect(() => {
    if (saveState !== "dirty" || saveConflict) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [saveConflict, saveDraft, saveState]);

  const loadServerConflictVersion = useCallback(() => {
    if (!saveConflict) return;
    saveRequestGenerationRef.current += 1;
    const nextDraft = createDraftFromDocumentSnapshot(saveConflict.serverDocument);
    draftVersionRef.current += 1;
    persistedDraftVersionRef.current = draftVersionRef.current;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    adoptServerRevision(saveConflict.serverDocument.revision, "reset");
    serverContentSignatureRef.current = createProposalContentSignature(saveConflict.serverDocument.contentJson);
    setSaveConflict(null);
    setSaveConflictNotice("");
    conflictCopyRef.current = null;
    conflictCopyCreationKeyRef.current = null;
    intentionalNavigationRef.current = false;
    setSaveState("saved");
  }, [adoptServerRevision, saveConflict]);

  const copyLocalConflictDraft = useCallback(async () => {
    if (!saveConflict) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(saveConflict.localDraft, null, 2));
      setSaveConflictNotice(messages.saveConflict.copied);
    } catch {
      setSaveConflictNotice("");
    }
  }, [messages.saveConflict.copied, saveConflict]);

  const saveLocalConflictAsNew = useCallback(async () => {
    if (!saveConflict || isSavingConflictCopy) return;
    const startingDraftVersion = draftVersionRef.current;
    const submittedDraft = saveConflict.localDraft;
    setIsSavingConflictCopy(true);
    setSaveConflictNotice("");
    intentionalNavigationRef.current = false;
    try {
      const existingCopy = conflictCopyRef.current;
      const saveRecoveryCopy = async (copy: { id: string; revision: number }, copyDraft: DraftState) => {
        const saveResult = await documentSessionClient.save(copy.id, copyDraft, copy.revision);
        if (saveResult.kind === "saved") {
          return saveResult.document;
        }
        if (
          saveResult.kind === "conflict" &&
          documentMatchesDraft(saveResult.serverDocument, copyDraft)
        ) {
          return saveResult.serverDocument;
        }
        if (saveResult.kind === "conflict") {
          conflictCopyRef.current = null;
          conflictCopyCreationKeyRef.current = null;
          setSaveConflictNotice(messages.saveConflict.saveAsNewCopyConflict);
          return null;
        }
        if (saveResult.kind === "failed" && saveResult.status === 404) {
          conflictCopyRef.current = null;
          conflictCopyCreationKeyRef.current = null;
          setSaveConflictNotice(messages.saveConflict.saveAsNewCopyConflict);
          return null;
        }
        throw new Error("Failed to update recovery copy");
      };

      let createdDocument: DocumentSnapshot | null;
      if (existingCopy) {
        createdDocument = await saveRecoveryCopy(existingCopy, submittedDraft);
      } else {
        const creationKey = conflictCopyCreationKeyRef.current ?? nanoid();
        conflictCopyCreationKeyRef.current = creationKey;
        const creation = await documentSessionClient.createFromDraft(submittedDraft, creationKey);
        createdDocument = creation.document;
        conflictCopyRef.current = {
          id: createdDocument.id,
          revision: createdDocument.revision,
        };
        if (creation.replayed && !documentMatchesDraft(createdDocument, submittedDraft)) {
          createdDocument = await saveRecoveryCopy(conflictCopyRef.current, submittedDraft);
        }
      }
      if (!createdDocument) return;
      conflictCopyRef.current = {
        id: createdDocument.id,
        revision: createdDocument.revision,
      };
      if (draftVersionRef.current !== startingDraftVersion) {
        setSaveConflictNotice(messages.saveConflict.saveAsNewChanged);
        return;
      }
      intentionalNavigationRef.current = true;
      window.location.assign(`/documents/${createdDocument.id}`);
    } catch {
      intentionalNavigationRef.current = false;
      setSaveConflictNotice(messages.saveConflict.saveAsNewFailed);
    } finally {
      setIsSavingConflictCopy(false);
    }
  }, [
    isSavingConflictCopy,
    messages.saveConflict.saveAsNewChanged,
    messages.saveConflict.saveAsNewCopyConflict,
    messages.saveConflict.saveAsNewFailed,
    saveConflict,
  ]);

  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "failed" && saveState !== "saving") {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (intentionalNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveState]);

  const exportDocxDraft = useCallback(async () => {
    setIsExportingDocx(true);

    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: draft.title,
          contentJson: draft.contentJson,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to export DOCX");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${sanitizeDownloadFileName(draft.title)}.docx`;
      link.click();
      URL.revokeObjectURL(url);
      setReviewError("");
    } catch {
      setReviewError(messages.errors.exportDocxFailed);
    } finally {
      setIsExportingDocx(false);
    }
  }, [document.id, draft.contentJson, draft.title, messages.errors.exportDocxFailed]);

  const selectTemplate = useCallback((templateId: string) => {
    const nextTemplate = templates.find((template) => template.id === templateId) ?? null;
    setSelectedTemplateId(templateId);
    setTemplateVariables((currentVariables) => mergeMissingTemplateVariableDefaults(nextTemplate, currentVariables));
    setTemplateVariableErrors({});
    setReviewError("");
  }, [templates]);

  const updateTemplateVariable = useCallback((name: string, value: string) => {
    setTemplateVariables((currentVariables) => ({ ...currentVariables, [name]: value }));
    setTemplateVariableErrors((currentErrors) => {
      const remainingErrors = { ...currentErrors };
      delete remainingErrors[name];
      return remainingErrors;
    });
    setReviewError("");
  }, []);

  const runDocumentReview = useCallback(async () => {
    if (!selectedTemplate) {
      return;
    }

    const variablesWithDefaults = mergeMissingTemplateVariableDefaults(selectedTemplate, templateVariables);
    const variablesForReview = collectTemplateVariables(selectedTemplate, variablesWithDefaults);
    setTemplateVariables(variablesWithDefaults);

    const variableValidation = validateTemplateVariables(selectedTemplate.variableSchemaJson, variablesForReview);
    if (!variableValidation.ok) {
      setTemplateVariableErrors(localizeTemplateVariableErrors(selectedTemplate, variableValidation.errors, messages));
      setReviewError(messages.errors.fillReviewVariables);
      return;
    }

    setIsReviewing(true);
    setReviewError("");
    setActiveProposalId(null);
    setReviewProposals([]);
    setReviewSummary(null);
    setTemplateVariableErrors({});

    try {
      const response = await fetch("/api/ai/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          templateId: selectedTemplate.id,
          command: "Review document",
          variables: variablesForReview,
          documentText: extractPlainTextFromTiptap(draft.contentJson),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to run review");
      }

      const body = (await response.json()) as ReviewResponse;
      setReviewProposals(body.proposals ?? []);
      setReviewSummary({
        findingCount: body.review?.findings?.length ?? body.proposals?.length ?? 0,
        proposalCount: body.proposals?.length ?? 0,
        skippedProposalCount: body.skippedProposalCount ?? 0,
        summary: body.review?.summary ?? "",
      });
      if (body.run) {
        setReviewRuns((currentRuns) => [body.run!, ...currentRuns]);
      }
    } catch {
      setReviewError(messages.errors.reviewFailed);
    } finally {
      setIsReviewing(false);
    }
  }, [document.id, draft.contentJson, messages, selectedTemplate, templateVariables]);

  const updateProposalStatus = useCallback(async (
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode: AiProposalApplyMode = "replace",
  ) => {
    const previousProposal = reviewProposals.find((proposal) => proposal.id === proposalId);
    if (!previousProposal) {
      return;
    }

    const startingDraftVersion = draftVersionRef.current;
    const isSelectionProposal = proposalId in selectionProposalContexts;
    const proposalContext = selectionProposalContexts[proposalId];

    if (status === "accepted") {
      if (isProposalSnapshotStale(proposalContext, draft.contentJson)) {
        setReviewError(messages.errors.staleSelection);
        return;
      }

      const preflightDraft = applyProposalToTiptapDraft(draft.contentJson, previousProposal, proposalContext, applyMode);
      if (!preflightDraft.ok) {
        setReviewError(
          preflightDraft.reason === "stale_selection"
            ? messages.errors.staleSelection
            : messages.errors.updateProposalFailed,
        );
        return;
      }
    }

    setReviewError("");

    try {
      const appliedServerResponse = status === "accepted"
        ? await documentSessionClient.applyProposal(proposalId, {
            appliedMode: applyMode,
            document: { id: document.id, ...draft },
            expectedRevision: serverRevisionRef.current,
          })
        : null;
      const updatedProposal = status === "accepted"
        ? appliedServerResponse?.proposals[0] ?? null
        : await patchProposalStatus(proposalId, {
          status,
          expectedStatus: previousProposal.status,
        });
      const proposalForState: AiReviewProposal =
        updatedProposal ?? { ...previousProposal, appliedMode: status === "accepted" ? applyMode : null, status };

      if (status === "accepted") {
        if (!appliedServerResponse) throw new Error("Missing proposal apply response");
        const baseDraft = draftVersionRef.current === startingDraftVersion ? draft : draftRef.current;
        const appliedMode = proposalForState.appliedMode ?? applyMode;
        setDocumentChanges((currentChanges) => [
          createHistoryChange(appliedServerResponse.change, appliedServerResponse.proposals),
          ...currentChanges.filter((change) => change.id !== appliedServerResponse.change.id),
        ]);
        const serverDraft = createDraftFromDocumentSnapshot(appliedServerResponse.document);
        const hasNewerLocalDraft = draftVersionRef.current !== startingDraftVersion;
        let nextDraft = serverDraft;
        if (hasNewerLocalDraft) {
          const reconciled = applyProposalToTiptapDraft(
            baseDraft.contentJson,
            previousProposal,
            proposalContext,
            appliedMode,
          );
          if (!reconciled.ok) {
            setReviewProposals((currentProposals) =>
              currentProposals.map((proposal) => (proposal.id === proposalId ? proposalForState : proposal)),
            );
            setSelectionApplicationNotice("");
            setReviewError(messages.errors.updateProposalFailed);
            return;
          }
          nextDraft = { ...baseDraft, contentJson: reconciled.contentJson };
        }
        serverContentSignatureRef.current = createProposalContentSignature(appliedServerResponse.document.contentJson);
        saveRequestGenerationRef.current += 1;
        adoptServerRevision(appliedServerResponse.document.revision);
        draftVersionRef.current += 1;
        persistedDraftVersionRef.current = Math.max(
          persistedDraftVersionRef.current,
          hasNewerLocalDraft ? startingDraftVersion : draftVersionRef.current,
        );
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        setSaveState(hasNewerLocalDraft ? "dirty" : "saved");
      }

      setReviewProposals((currentProposals) =>
        currentProposals.map((proposal) => (proposal.id === proposalId ? proposalForState : proposal)),
      );
      if (status === "accepted" && isSelectionProposal) {
        setSelectionApplicationNotice(messages.selectionResult.appliedNotice);
      }
      setUndoChangeError("");
      if (selectionAiResult?.proposalId === proposalId) {
        setSelectionAiResult(null);
      }
      if (activeProposalId === proposalId) {
        setActiveProposalId(null);
      }
    } catch (error) {
      if (recoverSessionRevisionConflict(error)) {
        setSelectionApplicationNotice("");
        setReviewError("");
        return;
      }
      const conflictProposal = isProposalStatusConflictError(error)
        ? error.proposal
        : getSessionConflictProposal(error);
      setReviewProposals((currentProposals) =>
        currentProposals.map((proposal) =>
          proposal.id === proposalId
            ? conflictProposal ?? proposal
            : proposal,
        ),
      );
      setSelectionApplicationNotice("");
      setReviewError(messages.errors.updateProposalFailed);
    }
  }, [
    adoptServerRevision,
    document.id,
    draft,
    messages.errors,
    messages.selectionResult.appliedNotice,
    reviewProposals,
    recoverSessionRevisionConflict,
    selectionAiResult,
    selectionProposalContexts,
    activeProposalId,
  ]);

  const updateProposalStatusLocally = useCallback((
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode?: AiProposalApplyMode,
  ) => {
    void updateProposalStatus(proposalId, status, applyMode);
  }, [updateProposalStatus]);

  const updatePendingProposalStatuses = useCallback(async (status: "accepted" | "rejected") => {
    const pendingProposals = reviewProposals.filter((proposal) => proposal.status === "pending");
    if (pendingProposals.length === 0) {
      return;
    }

    const startingDraftVersion = draftVersionRef.current;

    const buildAcceptedDraftState = (baseDraft: DraftState, proposalsToAccept: AiReviewProposal[]) => {
      let nextContentJson = baseDraft.contentJson;
      const proposalsToApply = getProposalApplicationOrder(proposalsToAccept, selectionProposalContexts);

      for (const proposal of proposalsToApply) {
        const applyMode = proposal.appliedMode ?? proposal.defaultApplyMode ?? "replace";
        const appliedDraft = applyProposalToTiptapDraft(
          nextContentJson,
          proposal,
          selectionProposalContexts[proposal.id],
          applyMode,
        );

        if (!appliedDraft.ok) {
          return { ok: false as const, reason: appliedDraft.reason };
        }

        nextContentJson = appliedDraft.contentJson;
      }

      return {
        nextContentJson,
        ok: true as const,
      };
    };

    if (status === "accepted") {
      const staleSnapshotProposal = pendingProposals.find((proposal) =>
        isProposalSnapshotStale(selectionProposalContexts[proposal.id], draft.contentJson),
      );
      if (staleSnapshotProposal) {
        setReviewError(messages.errors.staleSelection);
        return;
      }

      const preflightDraftState = buildAcceptedDraftState(draft, pendingProposals);
      if (!preflightDraftState.ok) {
        setReviewError(
          preflightDraftState.reason === "stale_selection"
            ? messages.errors.staleSelection
            : messages.errors.updateProposalFailed,
        );
        return;
      }
    }

    setReviewError("");

    if (status === "accepted") {
      const proposalsToApply = getProposalApplicationOrder(pendingProposals, selectionProposalContexts);
      const submittedDraft = draftVersionRef.current === startingDraftVersion ? draft : draftRef.current;
      try {
        const applyResponse = await documentSessionClient.applyProposalBatch({
          document: { id: document.id, ...submittedDraft },
          expectedRevision: serverRevisionRef.current,
          proposals: proposalsToApply.map((proposal) => ({
            appliedMode: proposal.appliedMode ?? proposal.defaultApplyMode ?? "replace",
            id: proposal.id,
          })),
        });
        const hasNewerLocalDraft = draftVersionRef.current !== startingDraftVersion;
        const reconciliationBase = hasNewerLocalDraft ? draftRef.current : submittedDraft;
        const reconciled = buildAcceptedDraftState(reconciliationBase, pendingProposals);
        const updatedProposalById = new Map(applyResponse.proposals.map((proposal) => [proposal.id, proposal]));
        setReviewProposals((currentProposals) =>
          currentProposals.map((proposal) => updatedProposalById.get(proposal.id) ?? proposal),
        );
        setDocumentChanges((currentChanges) => [
          createHistoryChange(applyResponse.change, applyResponse.proposals),
          ...currentChanges.filter((change) => change.id !== applyResponse.change.id),
        ]);
        if (!reconciled.ok) {
          setReviewError(messages.errors.updateProposalFailed);
          return;
        }

        serverContentSignatureRef.current = createProposalContentSignature(applyResponse.document.contentJson);
        saveRequestGenerationRef.current += 1;
        adoptServerRevision(applyResponse.document.revision);
        const serverDraft = createDraftFromDocumentSnapshot(applyResponse.document);
        const nextDraft = hasNewerLocalDraft
          ? { ...reconciliationBase, contentJson: reconciled.nextContentJson }
          : serverDraft;
        draftVersionRef.current += 1;
        persistedDraftVersionRef.current = Math.max(
          persistedDraftVersionRef.current,
          hasNewerLocalDraft ? startingDraftVersion : draftVersionRef.current,
        );
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        setSaveState(hasNewerLocalDraft ? "dirty" : "saved");
        setUndoChangeError("");
        setActiveProposalId(null);
      } catch (error) {
        if (recoverSessionRevisionConflict(error)) {
          setReviewError("");
        } else {
          setReviewError(messages.errors.updateProposalFailed);
        }
      }
      return;
    }

    const updatedProposals: AiReviewProposal[] = [];
    let conflictProposal: AiReviewProposal | null = null;
    let updateFailed = false;

    for (const proposal of pendingProposals) {
      try {
        const updatedProposal = await patchProposalStatus(proposal.id, {
          status,
          expectedStatus: proposal.status,
        });
        if (updatedProposal) {
          updatedProposals.push(updatedProposal);
        }
      } catch (error) {
        updateFailed = true;
        if (isProposalStatusConflictError(error)) {
          conflictProposal = error.proposal;
        }
        break;
      }
    }

    const updatedProposalById = new Map(updatedProposals.map((proposal) => [proposal.id, proposal]));
    if (conflictProposal) {
      updatedProposalById.set(conflictProposal.id, conflictProposal);
    }

    setReviewProposals((currentProposals) =>
      currentProposals.map((proposal) => updatedProposalById.get(proposal.id) ?? proposal),
    );
    setUndoChangeError("");
    if (updateFailed) {
      setReviewError(messages.errors.updateProposalFailed);
    } else {
      setActiveProposalId(null);
    }
  }, [
    adoptServerRevision,
    document.id,
    draft,
    messages.errors.staleSelection,
    messages.errors.updateProposalFailed,
    recoverSessionRevisionConflict,
    reviewProposals,
    selectionProposalContexts,
  ]);

  const retrySelectionAiResult = useCallback(() => {
    if (!selectionCommand) {
      return;
    }

    void handleSelectionCommand(
      selectionCommand.command,
      selectionCommand.selectedText,
      selectionCommand.context,
      selectionCommand.references,
      selectionCommand.commandMetadata ?? { defaultApplyMode: selectionCommand.defaultApplyMode },
    );
  }, [handleSelectionCommand, selectionCommand]);

  const loadDocumentChanges = useCallback(async (cursor?: string) => {
    if (documentChangesLoadingRef.current || (cursor === undefined && documentChangesLoadedRef.current)) return;
    documentChangesLoadingRef.current = true;
    setIsLoadingDocumentChanges(true);
    setDocumentChangesError("");
    try {
      const history = await documentSessionClient.listChanges(document.id, { cursor, limit: 20 });
      setDocumentChanges((currentChanges) => mergeDocumentChanges(currentChanges, history.changes));
      setDocumentChangesNextCursor(history.nextCursor);
      if (cursor === undefined) {
        documentChangesLoadedRef.current = true;
      }
    } catch {
      setDocumentChangesError(messages.aiWorkspace.changeLoadFailed);
    } finally {
      documentChangesLoadingRef.current = false;
      setIsLoadingDocumentChanges(false);
    }
  }, [document.id, messages.aiWorkspace.changeLoadFailed]);

  const undoAppliedChange = useCallback(async (changeId: string) => {
    const change = documentChanges.find((item) => item.id === changeId);
    if (
      !change ||
      change.undoneAt !== null ||
      saveState !== "saved" ||
      change.afterRevision !== serverRevisionRef.current
    ) {
      setUndoChangeError(messages.aiWorkspace.undoConflict);
      return;
    }

    const startingDraftVersion = draftVersionRef.current;
    setUndoChangeError("");

    try {
      const result = await documentSessionClient.undoChange(changeId, serverRevisionRef.current);
      const updatedProposalById = new Map(result.proposals.map((proposal) => [proposal.id, proposal]));
      setReviewProposals((currentProposals) => {
        const currentProposalIds = new Set(currentProposals.map((proposal) => proposal.id));
        return [
          ...currentProposals.map((proposal) => updatedProposalById.get(proposal.id) ?? proposal),
          ...result.proposals.filter((proposal) => !currentProposalIds.has(proposal.id)),
        ];
      });
      setDocumentChanges((currentChanges) =>
        currentChanges.map((item) => item.id === changeId ? { ...item, ...result.change } : item),
      );

      if (draftVersionRef.current !== startingDraftVersion) {
        setSaveConflict({ localDraft: draftRef.current, serverDocument: result.document });
        setSaveConflictNotice("");
        setSaveState("failed");
        return;
      }

      const nextDraft = createDraftFromDocumentSnapshot(result.document);
      serverContentSignatureRef.current = createProposalContentSignature(result.document.contentJson);
      saveRequestGenerationRef.current += 1;
      adoptServerRevision(result.document.revision);
      draftVersionRef.current += 1;
      persistedDraftVersionRef.current = draftVersionRef.current;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setSaveConflict(null);
      setSaveState("saved");
    } catch (error) {
      if (recoverSessionRevisionConflict(error)) {
        setUndoChangeError("");
      } else {
        setUndoChangeError(messages.aiWorkspace.undoConflict);
      }
    }
  }, [
    adoptServerRevision,
    documentChanges,
    messages.aiWorkspace.undoConflict,
    recoverSessionRevisionConflict,
    saveState,
  ]);

  const archiveAiChatSession = useCallback((sessionId: string) => {
    setAiChatSessions((currentSessions) => archiveAiWorkspaceSession(currentSessions, sessionId));
  }, []);

  const renameAiChatSession = useCallback((sessionId: string, title: string) => {
    setAiChatSessions((currentSessions) => renameAiWorkspaceSession(currentSessions, sessionId, title));
  }, []);

  const selectedTemplateName = selectedTemplate?.name ?? "";
  const inlineSuggestions = useMemo(
    () =>
      reviewProposals
        .filter((proposal) => proposal.status === "pending")
        .map((proposal) => {
          const proposalContext = selectionProposalContexts[proposal.id];
          return {
            id: proposal.id,
            active: proposal.id === activeProposalId,
            occurrenceIndex: proposal.occurrenceIndex ?? proposalContext?.occurrenceIndex ?? null,
            selectionRange: getProposalSelectionRange(proposal, proposalContext),
            source: proposal.source ?? "review",
            targetText: proposal.targetText,
          };
        }),
    [activeProposalId, reviewProposals, selectionProposalContexts],
  );
  const changeItems = useMemo(
    () =>
      documentChanges.map((change): AiWorkspaceChangeItem => ({
        appliedAt: new Date(change.createdAt),
        appliedMode: change.proposals[0]?.appliedMode ?? "replace",
        canUndo:
          change.undoneAt === null &&
          saveState === "saved" &&
          change.afterRevision === serverRevision,
        id: change.id,
        replacementText: change.proposals.map((proposal) => proposal.replacementText).join(" · "),
        targetText: change.proposals.map((proposal) => proposal.targetText).join(" · "),
      })),
    [documentChanges, saveState, serverRevision],
  );
  const documentOutline = useMemo(
    () => buildDocumentOutline(draft.title || messages.shell.untitledDocument, draft.contentJson),
    [draft.contentJson, draft.title, messages.shell.untitledDocument],
  );
  const aiContextSnapshot = useMemo(() => {
    const selectedTemplateForSnapshot = selectedTemplate ?? templates[0] ?? null;
    const templateForSnapshot = selectionCommand?.template ?? selectedTemplateForSnapshot;
    if (!templateForSnapshot) return null;
    const contentJsonForSnapshot = selectionCommand?.contentJson ?? draft.contentJson;
    const titleForSnapshot = selectionCommand?.title ?? draft.title;
    const variablesForSnapshot = selectionCommand
      ? selectionCommand.variables
      : selectedTemplateForSnapshot
        ? collectTemplateVariables(
            selectedTemplateForSnapshot,
            mergeMissingTemplateVariableDefaults(selectedTemplateForSnapshot, templateVariables),
          )
        : {};

    return buildAiContextSnapshot({
      command: selectionCommand?.command ?? "Review document",
      document: {
        id: document.id,
        metadata: draft.metadataJson,
        readiness: draft.readiness,
        text: extractPlainTextFromTiptap(contentJsonForSnapshot),
        title: titleForSnapshot || messages.shell.untitledDocument,
      },
      mode: selectionCommand ? "selection_rewrite" : "document_review",
      references: {
        documents: getReferencedDocumentsForSnapshot(selectionCommand?.references ?? [], referenceDocuments),
      },
      selection: selectionCommand
        ? {
            occurrenceIndex: selectionCommand.context?.occurrenceIndex,
            range: selectionCommand.context?.selectionRange,
            text: selectionCommand.selectedText,
          }
        : undefined,
      template: {
        category: templateForSnapshot.category,
        id: templateForSnapshot.id,
        name: templateForSnapshot.name,
      },
      variables: variablesForSnapshot,
    });
  }, [
    document.id,
    draft.contentJson,
    draft.metadataJson,
    draft.readiness,
    draft.title,
    messages.shell.untitledDocument,
    referenceDocuments,
    selectedTemplate,
    selectionCommand,
    templateVariables,
    templates,
  ]);
  const selectOutlineItem = useCallback((item: DocumentOutlineItem) => {
    setActiveOutlineItemId(item.id);
    if (item.topLevelIndex === null) return;

    setEditorSurface("editor");
    setOutlineFocusRequest({
      requestId: createWorkspaceClientId(aiWorkspaceIdRef, "outline_focus"),
      topLevelIndex: item.topLevelIndex,
    });
    setIsSidebarOpen(false);
  }, []);
  const executeDocumentCommand = useCallback((commandId: DocumentCommandAction["id"]) => {
    switch (commandId) {
      case "open-workspace":
        setWorkspaceOpen(true);
        return;
      case "review-document":
        setWorkspaceOpen(true);
        void runDocumentReview();
        return;
      case "find-document":
        openFind();
        return;
      case "show-source":
        setEditorSurface("source");
        return;
      case "show-editor":
        setEditorSurface("editor");
        return;
      case "save-document":
        void saveDraft();
        return;
      case "export-docx":
        void exportDocxDraft();
    }
  }, [exportDocxDraft, openFind, runDocumentReview, saveDraft, setWorkspaceOpen]);
  const commandPaletteActions = useMemo(
    () => buildDocumentCommandRegistry({
      editorSurface,
      hasSaveConflict: saveConflict !== null,
      isExportingDocx,
      messages: messages.commandPalette,
      saveState,
    }).map((definition): DocumentCommandAction => ({
      ...definition,
      execute: () => executeDocumentCommand(definition.id),
    })),
    [
      editorSurface,
      executeDocumentCommand,
      isExportingDocx,
      messages.commandPalette,
      saveConflict,
      saveState,
    ],
  );
  const sidebarNavigationClassName = [
    "flex h-9 items-center gap-2 rounded-md px-2.5",
    isInternalNavigationBlocked
      ? "cursor-not-allowed text-zinc-400"
      : "text-zinc-700 hover:bg-zinc-100",
  ].join(" ");
  const renderSidebarContent = () => (
    <>
      <section className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-4">
        <div className="flex size-7 items-center justify-center rounded-full bg-zinc-950 text-xs font-semibold text-white">
          K
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-950">Kyunghoon K...</p>
        </div>
        <button
          aria-label={messages.shell.closeSidebar}
          className="inline-flex size-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950"
          onClick={() => setIsSidebarOpen(false)}
          type="button"
        >
          <ChevronsLeft aria-hidden="true" className="size-4" />
        </button>
      </section>

      <nav className="shrink-0 space-y-1 px-3 py-4 text-sm font-medium">
        <button
          className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-indigo-300"
          disabled={isCreatingDocument || isInternalNavigationBlocked}
          onClick={createNewDocument}
          type="button"
        >
          <PlusCircle aria-hidden="true" className="size-4" />
          {messages.shell.newDocument}
        </button>
        <Link
          aria-disabled={isInternalNavigationBlocked}
          className={sidebarNavigationClassName}
          href="/documents"
          onClick={handleInternalNavigationClick}
        >
          <FileText aria-hidden="true" className="size-4" />
          {messages.shell.documents}
        </Link>
        <Link
          aria-disabled={isInternalNavigationBlocked}
          className={sidebarNavigationClassName}
          href="/templates"
          onClick={handleInternalNavigationClick}
        >
          <Library aria-hidden="true" className="size-4" />
          {messages.shell.library}
        </Link>
        <button
          className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-zinc-700 hover:bg-zinc-100"
          onClick={() => {
            setWorkspaceOpen(true);
            setIsSidebarOpen(false);
          }}
          type="button"
        >
          <MessageCircle aria-hidden="true" className="size-4" />
          {messages.shell.aiChat}
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <DocumentOutlinePanel
          activeItemId={activeOutlineItemId}
          messages={messages.outline}
          onSelectItem={selectOutlineItem}
          outline={documentOutline}
        />

        <DocumentMetadataPanel
          metadata={draft.metadataJson}
          messages={messages.metadataPanel}
          onChange={handleMetadataChange}
          readiness={draft.readiness}
        />

        <PromptTemplatePanel
          messages={messages.templates}
          onSelectTemplate={selectTemplate}
          onVariableChange={updateTemplateVariable}
          selectedTemplateId={activeTemplateId}
          templates={templates}
          variableErrors={templateVariableErrors}
          variableValues={templateVariables}
        />

        <div className="border-t border-zinc-200">
          <AiRunHistory language={language} messages={messages.history} runs={reviewRuns} />
        </div>
      </div>
    </>
  );
  const renderWorkspacePanel = (layout: "drawer" | "side", onClose?: () => void) => (
    <AiWorkspacePanel
      activeProposalId={activeProposalId}
      changeItems={changeItems}
      changeLoadErrorMessage={documentChangesError}
      chatMessages={aiChatMessages}
      chatSessions={aiChatSessions}
      errorMessage={reviewError}
      hasMoreChanges={documentChangesNextCursor !== null}
      isLoadingChanges={isLoadingDocumentChanges}
      isReviewing={isReviewing}
      isRunningCommand={isRewritingSelection}
      language={language}
      layout={layout}
      messages={messages.aiWorkspace}
      onArchiveChatSession={archiveAiChatSession}
      onBulkUpdateProposalStatus={updatePendingProposalStatuses}
      onChangesOpen={loadDocumentChanges}
      onClose={onClose}
      onFocusProposal={setActiveProposalId}
      onLoadMoreChanges={documentChangesNextCursor !== null
        ? () => void loadDocumentChanges(documentChangesNextCursor)
        : undefined}
      onReviewDocument={runDocumentReview}
      onRenameChatSession={renameAiChatSession}
      onUndoChange={undoAppliedChange}
      onUpdateProposalStatus={updateProposalStatusLocally}
      proposals={reviewProposals}
      reviewMessages={messages.aiReview}
      reviewSummary={reviewSummary}
      selectedTemplateName={selectedTemplateName}
      undoErrorMessage={undoChangeError}
    >
      <AiContextInspector messages={messages.aiContext} snapshot={aiContextSnapshot} />
      <section className="px-5 py-5">
        <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">
          {messages.selectionCommand.title}
        </h3>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          {selectionCommand
            ? formatEditorMessage(
                isRewritingSelection ? messages.selectionCommand.running : messages.selectionCommand.last,
                { command: selectionCommandLabel },
              )
            : messages.selectionCommand.empty}
        </p>
        {runningSelectionCommands.length > 0 ? (
          <p
            className="mt-2 rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs leading-5 text-indigo-700"
            role="status"
          >
            {formatEditorMessage(messages.selectionCommand.runningCount, {
              count: String(runningSelectionCommands.length),
              limit: String(MAX_CONCURRENT_SELECTION_COMMANDS),
            })}
          </p>
        ) : null}
        {selectionCommand ? (
          <p className="mt-2 truncate text-xs leading-5 text-zinc-500">
            {formatEditorMessage(messages.selectionCommand.selected, { selectedText: selectionCommand.selectedText })}
          </p>
        ) : null}
        {selectionApplicationNotice ? (
          <p
            aria-label={messages.selectionResult.applicationStatus}
            className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700"
            role="status"
          >
            {selectionApplicationNotice}
          </p>
        ) : null}
      </section>
    </AiWorkspacePanel>
  );

  return (
    <main className="flex h-dvh min-h-0 w-full min-w-0 overflow-hidden bg-white text-zinc-950">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 lg:flex">
        {renderSidebarContent()}
      </aside>

      {isSidebarOpen ? (
        <div className="fixed inset-0 z-50 flex bg-zinc-950/20 lg:hidden">
          <aside className="relative z-10 flex h-full w-[min(18rem,100vw)] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 shadow-2xl shadow-zinc-950/20">
            {renderSidebarContent()}
          </aside>
          <button
            aria-label={messages.shell.closeSidebar}
            className="min-w-0 flex-1 cursor-default"
            onClick={() => setIsSidebarOpen(false)}
            type="button"
          />
        </div>
      ) : null}

      <section aria-label={messages.editor.workspaceLabel} className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex min-h-14 shrink-0 flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-2 sm:h-14 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-0">
          <div className="flex min-w-0 items-center gap-3">
            <button
              aria-label={messages.shell.openSidebar}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 lg:hidden"
              onClick={() => setIsSidebarOpen(true)}
              type="button"
            >
              <PanelLeftOpen aria-hidden="true" className="size-4" />
            </button>
            <p className="max-w-[34rem] truncate text-sm font-medium text-zinc-800">
              {draft.title || messages.shell.untitledDocument}
            </p>
            <div
              aria-label={messages.header.saveStatus}
              aria-live="polite"
              className="shrink-0 text-xs font-medium text-zinc-500"
              role="status"
            >
              {messages.saveState[saveState]}
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 overflow-x-auto pb-1 sm:w-auto sm:overflow-visible sm:pb-0">
            <button
              aria-label={editorSurface === "source" ? messages.header.editorView : messages.header.sourceView}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
              onClick={() => setEditorSurface((currentSurface) => (currentSurface === "source" ? "editor" : "source"))}
              type="button"
            >
              <Code2 aria-hidden="true" className="size-4" />
              <span className="hidden whitespace-nowrap 2xl:inline">
                {editorSurface === "source" ? messages.header.editorView : messages.header.sourceView}
              </span>
            </button>
            <button
              aria-label={isExportingDocx ? messages.header.exportingDocx : messages.header.exportDocx}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              disabled={isExportingDocx}
              onClick={exportDocxDraft}
              type="button"
            >
              <Download aria-hidden="true" className="size-4" />
              <span className="hidden whitespace-nowrap 2xl:inline">
                {isExportingDocx ? messages.header.exportingDocx : messages.header.exportDocx}
              </span>
            </button>
            <AiSettingsDialog />
            <label className="sr-only" htmlFor="editor-language">
              {messages.header.language}
            </label>
            <select
              aria-label={messages.header.language}
              className="h-8 shrink-0 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-700 outline-none transition-colors focus:border-zinc-500"
              id="editor-language"
              onChange={(event) => handleLanguageChange(event.currentTarget.value)}
              value={language}
            >
              {editorLanguageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              aria-label={messages.shell.review}
              aria-pressed={isWorkspaceOpen}
              className={[
                "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-sm font-medium transition-colors",
                isWorkspaceOpen
                  ? "border-zinc-950 bg-zinc-950 text-white hover:bg-zinc-800"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
              ].join(" ")}
              onClick={() => setWorkspaceOpen((currentValue) => !currentValue)}
              type="button"
            >
              {isWorkspaceOpen ? (
                <PanelRightClose aria-hidden="true" className="size-4" />
              ) : (
                <PanelRightOpen aria-hidden="true" className="size-4" />
              )}
              <span className="hidden 2xl:inline">{messages.shell.review}</span>
            </button>
            <button
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-md bg-zinc-950 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              disabled={saveConflict !== null || saveState === "saved" || saveState === "saving"}
              onClick={saveDraft}
              type="button"
            >
              {saveState === "saving" ? messages.header.saving : messages.header.save}
            </button>
            <button
              aria-label={messages.shell.more}
              className="inline-flex size-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
              onClick={() => setIsCommandPaletteOpen(true)}
              type="button"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
          </div>
        </header>

        {saveConflict ? (
          <section
            className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-950"
            role="alert"
          >
            <p className="text-sm font-semibold">{messages.saveConflict.title}</p>
            <p className="mt-1 text-sm leading-5 text-amber-800">{messages.saveConflict.description}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
                onClick={loadServerConflictVersion}
                type="button"
              >
                {messages.saveConflict.reloadServer}
              </button>
              <button
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
                onClick={() => void copyLocalConflictDraft()}
                type="button"
              >
                {messages.saveConflict.copyLocal}
              </button>
              <button
                className="rounded-md bg-amber-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSavingConflictCopy}
                onClick={() => void saveLocalConflictAsNew()}
                type="button"
              >
                {messages.saveConflict.saveAsNew}
              </button>
            </div>
            {saveConflictNotice ? <p className="mt-2 text-sm" role="status">{saveConflictNotice}</p> : null}
          </section>
        ) : null}

        <div className="flex shrink-0 justify-center border-b border-zinc-100 px-4 py-2">
          <div
            aria-label={messages.sourceView.viewTabs}
            className="inline-grid grid-cols-2 rounded-md bg-zinc-100 p-1"
            role="tablist"
          >
            <button
              aria-selected={editorSurface === "editor"}
              className={[
                "h-8 rounded px-3 text-sm font-medium transition-colors",
                editorSurface === "editor" ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950",
              ].join(" ")}
              onClick={() => setEditorSurface("editor")}
              role="tab"
              type="button"
            >
              {messages.sourceView.editorTab}
            </button>
            <button
              aria-selected={editorSurface === "source"}
              className={[
                "h-8 rounded px-3 text-sm font-medium transition-colors",
                editorSurface === "source" ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950",
              ].join(" ")}
              onClick={() => setEditorSurface("source")}
              role="tab"
              type="button"
            >
              {messages.sourceView.sourceTab}
            </button>
          </div>
        </div>

        {editorSurface === "editor" ? (
          <DocumentEditor
            key={document.id}
            contentJson={draft.contentJson}
            isFindOpen={isFindOpen}
            isSelectionCommandLimitReached={isSelectionCommandLimitReached}
            isSelectionCommandRunning={isRewritingSelection}
            inlineSuggestions={inlineSuggestions}
            language={language}
            messages={messages.editor}
            onChange={handleDraftChange}
            onFindOpenChange={setIsFindOpen}
            referenceCandidates={referenceDocuments}
            onApplySelectionAiResult={(proposalId, applyMode) =>
              updateProposalStatusLocally(proposalId, "accepted", applyMode)
            }
            onDismissSelectionAiResult={() => setSelectionAiResult(null)}
            onRetrySelectionAiResult={retrySelectionAiResult}
            onSelectionCommand={handleSelectionCommand}
            outlineFocusRequest={outlineFocusRequest}
            runningSelectionCommand={selectionCommand?.command}
            runningSelectionCommandLimit={MAX_CONCURRENT_SELECTION_COMMANDS}
            runningSelectionCommands={runningSelectionCommands}
            selectionAiResult={selectionAiResult}
            title={draft.title}
          />
        ) : (
          <DocumentSourceView contentJson={draft.contentJson} messages={messages.sourceView} title={draft.title} />
        )}
      </section>

      {isWorkspaceOpen ? (
        <>
          {renderWorkspacePanel("side")}
          {isCompactWorkspace ? (
            <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/20 xl:hidden">
              <button
                aria-label={messages.aiWorkspace.close}
                className="min-w-0 flex-1 cursor-default"
                onClick={() => setWorkspaceOpen(false)}
                type="button"
              />
              {renderWorkspacePanel("drawer", () => setWorkspaceOpen(false))}
            </div>
          ) : null}
        </>
      ) : null}
      {isCommandPaletteOpen ? (
        <DocumentCommandPalette
          actions={commandPaletteActions}
          messages={messages.commandPalette}
          onClose={() => setIsCommandPaletteOpen(false)}
        />
      ) : null}
    </main>
  );
}

function collectTemplateVariables(template: ShellTemplate, values: Record<string, string>) {
  return template.variableSchemaJson.fields.reduce<Record<string, string>>((variables, field) => {
    variables[field.name] = values[field.name] ?? "";
    return variables;
  }, {});
}

function getReferencedDocumentsForSnapshot(
  references: readonly ResolvedAiDocumentReference[],
  candidates: readonly AiDocumentReferenceCandidate[],
) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();

  return references.flatMap((reference) => {
    if (seen.has(reference.id)) {
      return [];
    }

    seen.add(reference.id);
    const candidate = byId.get(reference.id);
    if (!candidate) {
      return [];
    }

    return [
      {
        id: candidate.id,
        text: candidate.plainText,
        title: candidate.title,
      },
    ];
  });
}

function localizeTemplateVariableErrors(
  template: ShellTemplate,
  errors: Record<string, string>,
  messages: (typeof editorMessages)[EditorLanguage],
) {
  return template.variableSchemaJson.fields.reduce<Record<string, string>>((localizedErrors, field) => {
    if (errors[field.name]) {
      localizedErrors[field.name] = formatEditorMessage(messages.errors.requiredTemplateVariable, {
        fieldName: getTemplateVariableLabel(field, messages.templates),
      });
    }

    return localizedErrors;
  }, {});
}

function createWorkspaceClientId(ref: MutableRefObject<number>, prefix: string) {
  ref.current += 1;
  return `${prefix}_${ref.current}_${nanoid(8)}`;
}

function restoreAiWorkspaceChatSessions(documentId: string): AiWorkspaceChatSession[] {
  return readAiWorkspaceSessionsForDocument(documentId).map((session) => ({
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  }));
}

function sanitizeDownloadFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "document";
}

function getCommandScopeLabel(
  scope: SelectionAiCommandContext["scope"] | undefined,
  messages: (typeof editorMessages)[EditorLanguage],
) {
  const normalizedScope = scope ?? "selection";
  return messages.aiCommandBar.scopeLabels[normalizedScope];
}

function readStoredEditorLanguage(): EditorLanguage {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_LANGUAGE;
  }

  const storedLanguage = window.localStorage.getItem(EDITOR_LANGUAGE_STORAGE_KEY);
  return isEditorLanguage(storedLanguage) ? storedLanguage : DEFAULT_EDITOR_LANGUAGE;
}

function mergeMissingTemplateVariableDefaults(template: ShellTemplate | null, values: Record<string, string>) {
  if (!template) {
    return values;
  }

  return template.variableSchemaJson.fields.reduce<Record<string, string>>(
    (variables, field) => {
      if (!(field.name in variables)) {
        variables[field.name] = getTemplateVariableDefaultValue(field);
      }

      return variables;
    },
    { ...values },
  );
}

function getTemplateVariableDefaultValue(field: ShellTemplateField) {
  if (field.type === "select") {
    return field.options?.find((option) => option.toLowerCase() === "executive") ?? field.options?.[0] ?? "";
  }

  const normalizedName = field.name.toLowerCase();
  const normalizedLabel = field.label.toLowerCase();

  if (normalizedName.includes("audience") || normalizedLabel.includes("audience")) {
    return "Executive stakeholders";
  }

  if (
    normalizedName.includes("objective") ||
    normalizedName.includes("goal") ||
    normalizedName.includes("purpose") ||
    normalizedLabel.includes("objective") ||
    normalizedLabel.includes("goal") ||
    normalizedLabel.includes("purpose")
  ) {
    return "Improve the selected text while preserving the document's intent.";
  }

  return field.type === "textarea" ? "Use the current document context and preserve the author's intent." : "General";
}

function getDefaultApplyModeForCommand(command: string): AiProposalApplyMode {
  const normalizedCommand = command.toLowerCase();
  return normalizedCommand.includes("translate") || normalizedCommand.includes("continue writing")
    ? "insert_below"
    : "replace";
}
