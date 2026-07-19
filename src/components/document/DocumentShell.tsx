"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { z } from "zod";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { isModalSurfaceActive, ModalSurface } from "@/components/ui/ModalSurface";
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
import type { FidelityReport } from "@/features/documents/document-interchange";
import { fetchDocumentInterchange } from "@/features/documents/document-interchange-fetch";
import { buildAiContextSnapshot } from "@/features/ai/ai-context-snapshot";
import type {
  ConversationStorageMode,
  StoredConversationSummary,
  StoredConversationView,
} from "@/features/ai/conversation-store";
import { useDocumentConversations } from "@/features/ai/use-document-conversations";
import {
  postAiOperation,
  type AiIdempotencyKeyCache,
} from "@/features/ai/ai-idempotency-client";
import { resolveDocumentShortcut } from "@/features/commands/document-command-manifest";
import { buildDocumentOutline, type DocumentOutlineItem } from "@/features/documents/document-outline";
import {
  createDocumentSessionClient,
  DocumentSessionConflictError,
  DocumentSessionInvalidProfileError,
  DocumentSessionRequestError,
  DocumentWorkflowRequestError,
  type DocumentSessionChange,
  type DocumentSessionHistoryChange,
  type DocumentSessionProposal,
  type DocumentWorkflowErrorReason,
  type DocumentWorkflowState,
} from "@/features/documents/document-session-client";
import { extractPlainTextFromTiptap } from "@/features/documents/tiptap-text";
import {
  createDocumentWorkflowNotificationBus,
  type DocumentWorkflowNotificationBus,
} from "@/features/documents/workflow-notification";
import {
  EDITOR_LANGUAGE_STORAGE_KEY,
  editorLanguageOptions,
  editorMessages,
  formatEditorMessage,
  getFidelityFeatureLabel,
  getFidelityOutcomeLabel,
  getSelectionCommandLabel,
  isEditorLanguage,
  readStoredEditorLanguage,
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
import { defaultEditorPlugins } from "@/plugins/app-plugins";
import { mergeEditorPluginContributions } from "@/plugins/registry";
import type { EditorPlugin, EditorPluginContributions, EditorSelectionCommandMetadata } from "@/plugins/types";
import { useEditorPlugins } from "@/plugins/use-editor-plugins";
import { DocumentEditor, type RunningSelectionAiCommand, type SelectionAiCommandContext } from "./DocumentEditor";
import { DocumentCommandPalette } from "./DocumentCommandPalette";
import { DocumentMetadataPanel } from "./DocumentMetadataPanel";
import { DocumentOutlinePanel } from "./DocumentOutlinePanel";
import { DocumentSourceView } from "./DocumentSourceView";
import { DocumentInterchangeDialog } from "./DocumentInterchangeDialog";
import { CollaborationParticipants } from "./CollaborationParticipants";
import { CollaborationStatus } from "./CollaborationStatus";
import { buildDocumentCommandRegistry } from "./commands/document-command-registry";
import type { DocumentCommandAction } from "./commands/document-command-types";
import type { SelectionAiResultPreview } from "./SelectionAiResultPopover";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import type { CollaborationClientConfiguration } from "@/features/collaboration/client-configuration";
import type { CollaborationSession } from "@/features/collaboration/client/hocuspocus-provider-adapter";
import type { CollaborationSessionSnapshot } from "@/features/collaboration/client/session-store";
import { useCollaborationSession } from "@/features/collaboration/client/use-collaboration-session";
import {
  createBrowserCollaborationNavigationEnvironment,
  createCollaborationNavigationController,
  type CollaborationNavigationController,
} from "@/features/collaboration/client/navigation-controller";
import { hasPendingCollaborationUpdates } from "@/features/collaboration/client/durability-state";
import {
  createYjsFieldStore,
  type YjsFieldStore,
} from "@/features/collaboration/client/yjs-field-store";
import {
  PROJECT_METADATA_LIMITS,
  type ProjectProfile,
  type ProjectProfileViolation,
} from "@/features/projects/project-profile";

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
> & { isTruncated?: boolean };
const EMPTY_SHELL_PROPOSALS: ShellProposal[] = [];
const EMPTY_REFERENCE_DOCUMENTS: AiDocumentReferenceCandidate[] = [];
export type SaveState = "saved" | "dirty" | "saving" | "failed";
export type EditorSurface = "editor" | "source";

type DocumentShellProps = {
  collaboration?: CollaborationClientConfiguration;
  conversationStorageMode?: ConversationStorageMode;
  conversationWorkspaceId?: string;
  defaultTemplateId?: string;
  document: ShellDocument;
  initialConversationLoadFailed?: boolean;
  initialConversationNextCursor?: string | null;
  initialConversations?: Array<StoredConversationSummary | StoredConversationView>;
  referenceDocuments?: AiDocumentReferenceCandidate[];
  templates: ShellTemplate[];
  aiRuns: ShellAiRun[];
  aiRunsNextCursor?: string | null;
  proposals?: ShellProposal[];
  proposalsNextCursor?: string | null;
  projectProfile?: ProjectProfile;
  pluginContributions?: Partial<EditorPluginContributions>;
  /** Additional plugins appended to the app defaults. */
  plugins?: EditorPlugin[];
};

type CollaborationRuntime = {
  currentPrincipalId: string;
  fields: YjsFieldStore | null;
  session: CollaborationSession | null;
  snapshot: CollaborationSessionSnapshot;
};

export { hasPendingCollaborationUpdates };

type DocumentShellContentProps = DocumentShellProps & {
  collaborationRuntime: CollaborationRuntime | null;
};

type DraftState = {
  title: string;
  contentJson: TiptapJson;
  metadataJson: DocumentMetadata;
  readiness: DocumentReadiness;
};

type PendingDocxExport = {
  contentJson: TiptapJson;
  fidelity: FidelityReport;
  title: string;
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
  documentId: string;
  proposals: ShellProposal[];
};

type DocumentAsyncScope = { documentId: string; generation: number };

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
export const DOCUMENT_WORKFLOW_RECOVERY_INTERVAL_MS = 30_000;
const COMPACT_WORKSPACE_MEDIA_QUERY = "(max-width: 1279px)";
const COMPACT_SIDEBAR_MEDIA_QUERY = "(max-width: 1023px)";
const subscribeToNothing = () => () => undefined;

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

type WorkflowFeedback =
  | "approval_durability_pending"
  | "legacy_approval_unsupported"
  | "saved"
  | DocumentWorkflowErrorReason;

type WorkflowReadRequest = {
  controller: AbortController;
  documentId: string;
  promise: Promise<DocumentWorkflowState | null>;
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

function subscribeCompactSidebarLayout(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mediaQuery = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getCompactSidebarLayoutSnapshot() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches;
}

export function DocumentShell(props: DocumentShellProps) {
  if (props.collaboration?.kind === "collaboration") {
    return (
      <CollaborativeDocumentShellContent
        key={props.document.id}
        {...props}
        collaboration={props.collaboration}
      />
    );
  }
  return <DocumentShellContent key={props.document.id} {...props} collaborationRuntime={null} />;
}

function CollaborativeDocumentShellContent(
  props: DocumentShellProps & {
    collaboration: Extract<CollaborationClientConfiguration, { kind: "collaboration" }>;
  },
) {
  const projectProfile = props.projectProfile ?? getProjectProfile("default");
  const { session, snapshot } = useCollaborationSession({
    ...props.collaboration,
    projectProfile,
  });
  const [fieldResource, setFieldResource] = useState<{
    fields: YjsFieldStore;
    session: CollaborationSession;
  } | null>(null);
  const fieldsReady = Boolean(
    session
    && snapshot.hasCompletedInitialSync
    && snapshot.status !== "fatal",
  );

  useEffect(() => {
    if (!session || !fieldsReady) return;
    let active = true;
    let nextFields: YjsFieldStore | null = null;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        nextFields = createYjsFieldStore({
          document: session.document,
          onInvalid: () => failCollaborationSession(session),
          projectProfile,
          writable: () => session.store.getSnapshot().writable,
        });
      } catch {
        failCollaborationSession(session);
        return;
      }
      if (!active) {
        nextFields.destroy();
        nextFields = null;
        return;
      }
      setFieldResource({ fields: nextFields, session });
    });
    return () => {
      active = false;
      nextFields?.destroy();
      nextFields = null;
    };
  }, [fieldsReady, projectProfile, session]);

  return (
    <DocumentShellContent
      {...props}
      collaborationRuntime={{
        currentPrincipalId: props.collaboration.currentPrincipalId,
        fields: fieldsReady && fieldResource?.session === session ? fieldResource.fields : null,
        session,
        snapshot,
      }}
    />
  );
}

function failCollaborationSession(session: CollaborationSession) {
  try {
    session.store.markFatal();
  } catch {
    // A broken store must not prevent transport teardown.
  }
  try {
    session.destroy();
  } catch {
    // Teardown is best effort; the UI still fails closed via the store.
  }
}

function DocumentShellContent({
  aiRuns,
  aiRunsNextCursor = null,
  conversationStorageMode = "local",
  conversationWorkspaceId = "local-workspace",
  defaultTemplateId,
  document,
  initialConversationLoadFailed = false,
  initialConversationNextCursor = null,
  initialConversations,
  pluginContributions,
  plugins,
  proposals = EMPTY_SHELL_PROPOSALS,
  proposalsNextCursor = null,
  projectProfile = getProjectProfile("default"),
  referenceDocuments = EMPTY_REFERENCE_DOCUMENTS,
  templates,
  collaborationRuntime,
}: DocumentShellContentProps) {
  const router = useRouter();
  const replaceRoute = router.replace;
  const isCollaborationMode = collaborationRuntime !== null;
  const initialTemplate = getInitialTemplate(templates, defaultTemplateId);
  const initialTemplateVariables = useMemo(
    () => mergeMissingTemplateVariableDefaults(initialTemplate, {}),
    [initialTemplate],
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
  const activeCollaborationFields = collaborationRuntime?.session
    && collaborationRuntime.fields
    && collaborationRuntime.snapshot.hasCompletedInitialSync
    && collaborationRuntime.snapshot.status !== "fatal"
    ? collaborationRuntime.fields
    : null;
  const collaborationTitle = useSyncExternalStore(
    activeCollaborationFields?.subscribeTitle ?? subscribeToNothing,
    activeCollaborationFields?.getTitleSnapshot ?? (() => initialDraft.title),
    activeCollaborationFields?.getTitleSnapshot ?? (() => initialDraft.title),
  );
  const collaborationMetadata = useSyncExternalStore(
    activeCollaborationFields?.subscribeMetadata ?? subscribeToNothing,
    activeCollaborationFields?.getMetadataSnapshot ?? (() => initialDraft.metadataJson),
    activeCollaborationFields?.getMetadataSnapshot ?? (() => initialDraft.metadataJson),
  );
  const draftRef = useRef<DraftState>(initialDraft);
  const draftVersionRef = useRef(0);
  const persistedDraftVersionRef = useRef(0);
  const saveRequestGenerationRef = useRef(0);
  const documentAsyncScopeRef = useRef<DocumentAsyncScope>({ documentId: document.id, generation: 0 });
  const intentionalNavigationRef = useRef(false);
  const conflictCopyRef = useRef<{ id: string; revision: number } | null>(null);
  const conflictCopyCreationKeyRef = useRef<string | null>(null);
  const aiIdempotencyKeyCacheRef = useRef<AiIdempotencyKeyCache>(new Map());
  const serverContentSignatureRef = useRef(createProposalContentSignature(incomingDocument.contentJson));
  const serverRevisionRef = useRef(incomingDocument.revision);
  const [serverRevision, setServerRevision] = useState(incomingDocument.revision);
  const initialWorkflowState = useMemo<DocumentWorkflowState | null>(() => isCollaborationMode
    ? null
    : Object.freeze({
        collaboration: null,
        documentId: document.id,
        readiness: document.readiness ?? "draft",
        revision: document.revision,
      }), [document.id, document.readiness, document.revision, isCollaborationMode]);
  const [workflowState, setWorkflowState] = useState<DocumentWorkflowState | null>(initialWorkflowState);
  const workflowStateRef = useRef<DocumentWorkflowState | null>(initialWorkflowState);
  const workflowReadRequestRef = useRef<WorkflowReadRequest | null>(null);
  const workflowMutationControllerRef = useRef<AbortController | null>(null);
  const workflowNotificationBusRef = useRef<DocumentWorkflowNotificationBus | null>(null);
  const [workflowFeedback, setWorkflowFeedback] = useState<WorkflowFeedback | null>(null);
  const [isWorkflowMutating, setIsWorkflowMutating] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [projectProfileViolation, setProjectProfileViolation] = useState<ProjectProfileViolation | null>(null);
  const [saveConflict, setSaveConflict] = useState<{
    localDraft: DraftState;
    serverDocument: DocumentSnapshot;
  } | null>(null);
  const [saveConflictNotice, setSaveConflictNotice] = useState("");
  const [isSavingConflictCopy, setIsSavingConflictCopy] = useState(false);
  const [language, setLanguage] = useState<EditorLanguage>(() => readStoredEditorLanguage());
  const collaborationNavigationRef = useRef<CollaborationNavigationController | null>(null);
  const collaborationSnapshotRef = useRef(collaborationRuntime?.snapshot ?? null);
  const collaborationNavigationMessageRef = useRef("");
  const [selectionCommand, setSelectionCommand] = useState<SelectionCommandPayload | null>(null);
  const [selectionAiResult, setSelectionAiResult] = useState<SelectionAiResultPreview | null>(null);
  const [selectionApplicationNotice, setSelectionApplicationNotice] = useState("");
  const [selectionProposalContexts, setSelectionProposalContexts] = useState<Record<string, SelectionProposalContext>>({});
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const [aiChatMessages, setAiChatMessages] = useState<AiWorkspaceChatMessage[]>([]);
  const conversations = useDocumentConversations({
    documentId: document.id,
    initialConversations,
    initialLoadFailed: initialConversationLoadFailed,
    initialNextCursor: initialConversationNextCursor,
    storageMode: conversationStorageMode,
    workspaceId: conversationWorkspaceId,
  });
  const aiChatSessions: AiWorkspaceChatSession[] = conversations.sessions;
  const [documentChanges, setDocumentChanges] = useState<DocumentSessionHistoryChange[]>([]);
  const [documentChangesNextCursor, setDocumentChangesNextCursor] = useState<string | null>(null);
  const documentChangesLoadedRef = useRef(false);
  const documentChangesLoadingRef = useRef(false);
  const [isLoadingDocumentChanges, setIsLoadingDocumentChanges] = useState(false);
  const [documentChangesError, setDocumentChangesError] = useState("");
  const [undoChangeError, setUndoChangeError] = useState("");
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [pendingDocxExport, setPendingDocxExport] = useState<PendingDocxExport | null>(null);
  const [docxExportError, setDocxExportError] = useState("");
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const docxExportRequestRef = useRef<AbortController | null>(null);
  const aiWorkspaceIdRef = useRef(0);
  const runningSelectionCommandsRef = useRef<RunningSelectionAiCommand[]>([]);
  const [observedDocument, setObservedDocument] = useState<DocumentSnapshot>(incomingDocument);
  const [observedAiSnapshot, setObservedAiSnapshot] = useState<AiSnapshot>({ aiRuns, documentId: document.id, proposals });
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplate?.id ?? "");
  const [reviewProposals, setReviewProposals] = useState<AiReviewProposal[]>(proposals);
  const [reviewRuns, setReviewRuns] = useState<AiRunHistoryItem[]>(aiRuns);
  const [runsCursor, setRunsCursor] = useState(aiRunsNextCursor);
  const [proposalCursor, setProposalCursor] = useState(proposalsNextCursor);
  const [isLoadingRuns, setIsLoadingRuns] = useState(false);
  const [isLoadingProposals, setIsLoadingProposals] = useState(false);
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
  const isCompactSidebar = useSyncExternalStore(
    subscribeCompactSidebarLayout,
    getCompactSidebarLayoutSnapshot,
    getCompactWorkspaceLayoutServerSnapshot,
  );
  const [workspaceOpenOverride, setWorkspaceOpenOverride] = useState<boolean | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const isActiveDocumentAsyncScope = useCallback((scope: DocumentAsyncScope) =>
    scope.documentId === documentAsyncScopeRef.current.documentId &&
    scope.generation === documentAsyncScopeRef.current.generation, []);

  useLayoutEffect(() => {
    if (documentAsyncScopeRef.current.documentId !== document.id) {
      documentAsyncScopeRef.current = {
        documentId: document.id,
        generation: documentAsyncScopeRef.current.generation + 1,
      };
      saveRequestGenerationRef.current += 1;
    }
    return () => {
      documentAsyncScopeRef.current = {
        ...documentAsyncScopeRef.current,
        generation: documentAsyncScopeRef.current.generation + 1,
      };
      saveRequestGenerationRef.current += 1;
    };
  }, [document.id]);

  useEffect(() => subscribeCompactSidebarLayout(() => {
    if (!getCompactSidebarLayoutSnapshot()) setIsSidebarOpen(false);
  }), []);
  const [isCreatingDocument, setIsCreatingDocument] = useState(false);
  const [editorSurface, setEditorSurface] = useState<EditorSurface>("editor");
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string | null>(null);
  const [outlineFocusRequest, setOutlineFocusRequest] = useState<{ requestId: string; topLevelIndex: number } | null>(
    null,
  );
  useEffect(() => () => {
    docxExportRequestRef.current?.abort();
    docxExportRequestRef.current = null;
  }, [document.id]);
  const activeTemplateId = templates.some((template) => template.id === selectedTemplateId)
    ? selectedTemplateId
    : initialTemplate?.id ?? "";
  const selectedTemplate = templates.find((template) => template.id === activeTemplateId) ?? null;
  const messages = editorMessages[language];
  const projectProfileErrorTitle = language === "ko"
    ? "프로젝트 프로필 확인 필요"
    : "Project Profile action required";
  const projectProfileErrorMessage = projectProfileViolation
    ? formatProjectProfileViolation(projectProfile, projectProfileViolation, language)
    : "";
  const shellPlugins = useMemo(
    () => plugins ? [...defaultEditorPlugins, ...plugins] : defaultEditorPlugins,
    [plugins],
  );
  const defaultPluginContributions = useEditorPlugins(language, { plugins: shellPlugins });
  const resolvedPluginContributions = useMemo(
    () => mergeEditorPluginContributions(defaultPluginContributions, pluginContributions),
    [defaultPluginContributions, pluginContributions],
  );
  const pluginWorkspaceContext = useMemo(
    () => ({
      document: {
        contentJson: draft.contentJson,
        id: document.id,
        get plainText() {
          return extractPlainTextFromTiptap(draft.contentJson);
        },
        title: draft.title,
      },
      language,
      messages,
    }),
    [document.id, draft.contentJson, draft.title, language, messages],
  );
  const selectionCommandLabel = selectionCommand ? getSelectionCommandLabel(selectionCommand.command, language) : "";
  const isRewritingSelection = runningSelectionCommands.length > 0;
  const isSelectionCommandLimitReached = runningSelectionCommands.length >= MAX_CONCURRENT_SELECTION_COMMANDS;
  const isInternalNavigationBlocked = !isCollaborationMode && saveState !== "saved";

  useLayoutEffect(() => {
    collaborationSnapshotRef.current = collaborationRuntime?.snapshot ?? null;
  }, [collaborationRuntime?.snapshot]);

  useEffect(() => {
    collaborationNavigationMessageRef.current = language === "ko"
      ? "내구성 확인을 기다리는 공동 편집 변경 사항이 있습니다. 이동을 계속하시겠습니까?"
      : "Collaboration changes are still awaiting durable storage. Continue navigating?";
  }, [language]);

  useEffect(() => {
    const initialSnapshot = collaborationSnapshotRef.current;
    if (!isCollaborationMode || !initialSnapshot) {
      collaborationNavigationRef.current = null;
      return;
    }
    const controller = collaborationNavigationRef.current
      ?? createCollaborationNavigationController({
        environment: createBrowserCollaborationNavigationEnvironment(),
        getMessage: () => collaborationNavigationMessageRef.current,
        getSnapshot: () => collaborationSnapshotRef.current ?? initialSnapshot,
        onHandoff: () => {
          intentionalNavigationRef.current = true;
        },
        onRestoreProtectedRoute: (href) => {
          const protectedUrl = new URL(href, window.location.href);
          if (protectedUrl.origin !== window.location.origin) return;
          replaceRoute(`${protectedUrl.pathname}${protectedUrl.search}${protectedUrl.hash}`);
        },
      });
    if (!collaborationNavigationRef.current) {
      collaborationNavigationRef.current = controller;
    }
    const uninstall = controller.install();
    return uninstall;
  }, [document.id, isCollaborationMode, replaceRoute]);
  const adoptServerRevision = useCallback((returnedRevision: number, mode: "advance" | "reset" = "advance") => {
    const nextRevision = resolveServerRevision(serverRevisionRef.current, returnedRevision, mode);
    serverRevisionRef.current = nextRevision;
    setServerRevision(nextRevision);
  }, []);
  const adoptWorkflowState = useCallback((nextWorkflow: DocumentWorkflowState) => {
    if (nextWorkflow.documentId !== documentAsyncScopeRef.current.documentId) return;
    workflowStateRef.current = nextWorkflow;
    setWorkflowState(nextWorkflow);
    setDraft((currentDraft) => {
      if (currentDraft.readiness === nextWorkflow.readiness) return currentDraft;
      const nextDraft = { ...currentDraft, readiness: nextWorkflow.readiness };
      draftRef.current = nextDraft;
      return nextDraft;
    });
  }, []);
  const refreshWorkflow = useCallback((): Promise<DocumentWorkflowState | null> => {
    const currentRequest = workflowReadRequestRef.current;
    if (currentRequest?.documentId === document.id) return currentRequest.promise;
    if (workflowMutationControllerRef.current) return Promise.resolve(null);

    const requestScope = documentAsyncScopeRef.current;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await documentSessionClient.readWorkflow(document.id, { signal: controller.signal });
        if (!isActiveDocumentAsyncScope(requestScope)) return null;
        adoptWorkflowState(result.workflow);
        setWorkflowFeedback(null);
        return result.workflow;
      } catch (error) {
        if (!isActiveDocumentAsyncScope(requestScope) || controller.signal.aborted) return null;
        setWorkflowFeedback(error instanceof DocumentWorkflowRequestError ? error.reason : "network_error");
        return null;
      } finally {
        const activeRequest = workflowReadRequestRef.current;
        if (activeRequest?.controller === controller) workflowReadRequestRef.current = null;
      }
    })();
    workflowReadRequestRef.current = { controller, documentId: document.id, promise };
    return promise;
  }, [adoptWorkflowState, document.id, isActiveDocumentAsyncScope]);

  useEffect(() => {
    const recoverWorkflow = () => {
      void refreshWorkflow();
    };
    if (isCollaborationMode) recoverWorkflow();
    const notificationBus = createDocumentWorkflowNotificationBus({
      onDocumentChanged: (changedDocumentId) => {
        if (changedDocumentId === document.id) recoverWorkflow();
      },
    });
    workflowNotificationBusRef.current = notificationBus;
    window.addEventListener("focus", recoverWorkflow);
    window.addEventListener("online", recoverWorkflow);
    const intervalId = window.setInterval(recoverWorkflow, DOCUMENT_WORKFLOW_RECOVERY_INTERVAL_MS);

    return () => {
      window.removeEventListener("focus", recoverWorkflow);
      window.removeEventListener("online", recoverWorkflow);
      window.clearInterval(intervalId);
      notificationBus.destroy();
      if (workflowNotificationBusRef.current === notificationBus) {
        workflowNotificationBusRef.current = null;
      }
      workflowReadRequestRef.current?.controller.abort();
      workflowReadRequestRef.current = null;
      workflowMutationControllerRef.current?.abort();
      workflowMutationControllerRef.current = null;
    };
  }, [document.id, isCollaborationMode, refreshWorkflow]);

  useEffect(() => {
    const session = collaborationRuntime?.session;
    if (!session) return;
    return session.subscribeWorkflowChanged(() => {
      void refreshWorkflow();
    });
  }, [collaborationRuntime?.session, refreshWorkflow]);

  useEffect(() => {
    if (
      !collaborationRuntime?.session ||
      !collaborationRuntime.snapshot.hasCompletedInitialSync ||
      !collaborationRuntime.snapshot.transportSynced
    ) {
      return;
    }
    void refreshWorkflow();
  }, [
    collaborationRuntime?.session,
    collaborationRuntime?.snapshot.hasCompletedInitialSync,
    collaborationRuntime?.snapshot.status,
    collaborationRuntime?.snapshot.transportSynced,
    refreshWorkflow,
  ]);
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
  const recoverProjectProfileViolation = useCallback((error: unknown) => {
    if (!(error instanceof DocumentSessionInvalidProfileError)) return false;
    setProjectProfileViolation(error.violation);
    return true;
  }, []);
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
      if (event.defaultPrevented || pendingDocxExport || isModalSurfaceActive()) return;
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
  }, [openFind, pendingDocxExport]);

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

    if (isDocumentNavigation || saveState === "saved") {
      setDraft(initialDraft);
      setSelectionCommand(null);
      setSelectionAiResult(null);
      setSelectionApplicationNotice("");
      setSelectionProposalContexts({});
      setActiveProposalId(null);
      setAiChatMessages([]);
      setDocumentChanges([]);
      setDocumentChangesNextCursor(null);
      setIsLoadingDocumentChanges(false);
      setDocumentChangesError("");
      setUndoChangeError("");
      setProjectProfileViolation(null);
      setSaveConflict(null);
      setSaveConflictNotice("");
      setEditorSurface("editor");
      setIsCommandPaletteOpen(false);
      setIsFindOpen(false);
      setActiveOutlineItemId(null);
      setOutlineFocusRequest(null);
      setSelectedTemplateId(getInitialTemplate(templates, defaultTemplateId)?.id ?? "");
      setReviewProposals(proposals);
      setReviewRuns(aiRuns);
      setRunsCursor(aiRunsNextCursor);
      setProposalCursor(proposalsNextCursor);
      setReviewSummary(null);
      setIsReviewing(false);
      setReviewError("");
      setPendingDocxExport(null);
      setDocxExportError("");
      setTemplateVariables(initialTemplateVariables);
      setTemplateVariableErrors({});
      setRunningSelectionCommands([]);
    }
  }

  if (
    observedAiSnapshot.documentId !== document.id ||
    observedAiSnapshot.aiRuns !== aiRuns ||
    observedAiSnapshot.proposals !== proposals
  ) {
    setObservedAiSnapshot({ aiRuns, documentId: document.id, proposals });
    setReviewRuns(aiRuns);
    setRunsCursor(aiRunsNextCursor);
    setProposalCursor(proposalsNextCursor);
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
    setProjectProfileViolation(null);
    setSaveState("dirty");
  }, []);
  const handleLegacyMetadataChange = useCallback((change: { metadataJson?: DocumentMetadata; readiness?: DocumentReadiness }) => {
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
    setProjectProfileViolation(null);
    setSaveState("dirty");
  }, []);
  const handleMetadataFieldChange = useCallback((key: string, value: DocumentMetadata[string] | undefined) => {
    if (activeCollaborationFields) {
      try {
        activeCollaborationFields.setMetadataField(key, value);
      } catch {
        // The field store reports only bounded validation categories. The
        // controlled input remains on the last canonical snapshot.
      }
      return;
    }
    if (isCollaborationMode) return;
    const nextMetadata = { ...draftRef.current.metadataJson };
    if (value === undefined) delete nextMetadata[key];
    else nextMetadata[key] = Array.isArray(value) ? [...value] : value;
    handleLegacyMetadataChange({ metadataJson: nextMetadata });
  }, [activeCollaborationFields, handleLegacyMetadataChange, isCollaborationMode]);
  const handleReadinessChange = useCallback(async (next: DocumentReadiness) => {
    const initialWorkflow = workflowStateRef.current;
    if (
      !initialWorkflow ||
      isWorkflowMutating ||
      workflowMutationControllerRef.current ||
      (!isCollaborationMode && (saveState !== "saved" || saveConflict !== null)) ||
      next === initialWorkflow.readiness
    ) return;
    if (
      isCollaborationMode && (
        !collaborationRuntime?.snapshot.hasCompletedInitialSync ||
        collaborationRuntime.snapshot.permission !== "write" ||
        collaborationRuntime.snapshot.status === "fatal"
      )
    ) {
      return;
    }

    const requestScope = documentAsyncScopeRef.current;
    const controller = new AbortController();
    const pendingRead = workflowReadRequestRef.current?.promise;
    workflowMutationControllerRef.current = controller;
    setIsWorkflowMutating(true);
    setWorkflowFeedback(null);

    const readAuthoritativeWorkflow = async () => {
      const result = await documentSessionClient.readWorkflow(document.id, { signal: controller.signal });
      if (!isActiveDocumentAsyncScope(requestScope)) return null;
      adoptWorkflowState(result.workflow);
      return result.workflow;
    };

    try {
      if (pendingRead) await pendingRead;
      if (!isActiveDocumentAsyncScope(requestScope) || controller.signal.aborted) return;
      let expectedWorkflow = workflowStateRef.current;
      if (!expectedWorkflow) return;

      let command: Parameters<typeof documentSessionClient.updateWorkflow>[1];
      if (next === "approved") {
        expectedWorkflow = await readAuthoritativeWorkflow();
        if (!expectedWorkflow) return;
        if (expectedWorkflow.readiness !== "ready") {
          setWorkflowFeedback("expected_readiness_conflict");
          return;
        }
        if (!expectedWorkflow.collaboration) {
          setWorkflowFeedback("legacy_approval_unsupported");
          return;
        }
        const liveSnapshot = collaborationSnapshotRef.current;
        if (
          !liveSnapshot ||
          liveSnapshot.status !== "synced" ||
          !liveSnapshot.transportSynced ||
          hasPendingCollaborationUpdates(liveSnapshot)
        ) {
          setWorkflowFeedback("approval_durability_pending");
          return;
        }
        command = {
          expectedReadiness: "ready",
          nextReadiness: "approved",
          observedHeadSeq: expectedWorkflow.collaboration.headSeq,
        };
      } else {
        command = {
          expectedReadiness: expectedWorkflow.readiness,
          nextReadiness: next,
        };
      }

      const result = await documentSessionClient.updateWorkflow(document.id, command, {
        signal: controller.signal,
      });
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      adoptWorkflowState(result.workflow);
      if (
        !isCollaborationMode &&
        expectedWorkflow.revision === serverRevisionRef.current &&
        result.workflow.revision === expectedWorkflow.revision + 1
      ) {
        // Workflow and legacy body saves share one document revision. Only
        // advance the body CAS when this command is provably the sole
        // intervening revision; otherwise retain the stale revision so the
        // next body save conflicts instead of overwriting an external edit.
        adoptServerRevision(result.workflow.revision);
      }
      setWorkflowFeedback("saved");
      try {
        workflowNotificationBusRef.current?.publish(document.id);
      } catch {
        // The HTTP command already committed. Notification transports are
        // hints only; explicit re-read and recovery polling remain active.
      }
      try {
        await readAuthoritativeWorkflow();
      } catch {
        if (!controller.signal.aborted && isActiveDocumentAsyncScope(requestScope)) {
          setWorkflowFeedback("workflow_unavailable");
        }
      }
    } catch (error) {
      if (!isActiveDocumentAsyncScope(requestScope) || controller.signal.aborted) return;
      if (error instanceof DocumentWorkflowRequestError) {
        if (error.workflow) adoptWorkflowState(error.workflow);
        if (error.violation) setProjectProfileViolation(error.violation);
        setWorkflowFeedback(error.reason);
      } else {
        setWorkflowFeedback("network_error");
      }
      try {
        await readAuthoritativeWorkflow();
      } catch {
        // Preserve the stable command error while a later focus/online/poll
        // recovery retries the authoritative workflow read.
      }
    } finally {
      if (workflowMutationControllerRef.current === controller) {
        workflowMutationControllerRef.current = null;
      }
      if (isActiveDocumentAsyncScope(requestScope)) setIsWorkflowMutating(false);
    }
  }, [
    adoptServerRevision,
    adoptWorkflowState,
    collaborationRuntime,
    document.id,
    isActiveDocumentAsyncScope,
    isCollaborationMode,
    isWorkflowMutating,
    saveConflict,
    saveState,
  ]);

  const handleLanguageChange = useCallback((nextLanguage: string) => {
    if (!isEditorLanguage(nextLanguage)) {
      return;
    }

    setLanguage(nextLanguage);
    window.localStorage.setItem(EDITOR_LANGUAGE_STORAGE_KEY, nextLanguage);
  }, []);

  const createNewDocument = useCallback(async () => {
    const navigationPermit = isCollaborationMode
      ? collaborationNavigationRef.current?.requestTransition()
      : undefined;
    if ((isCollaborationMode && !navigationPermit) || isInternalNavigationBlocked) return;

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
        const destination = `/documents/${encodeURIComponent(body.document.id)}`;
        if (navigationPermit) {
          navigationPermit.continue(() => router.push(destination));
        } else {
          window.location.assign(destination);
        }
      }
    } catch {
      setReviewError(messages.errors.createDocumentFailed);
    } finally {
      setIsCreatingDocument(false);
    }
  }, [
    isCollaborationMode,
    isInternalNavigationBlocked,
    messages.errors.createDocumentFailed,
    messages.shell.untitledDocument,
    router,
  ]);

  const handleInternalNavigationClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (isInternalNavigationBlocked) {
      event.preventDefault();
      return;
    }
    if (!isCollaborationMode) return;
    if (
      event.button !== 0
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || event.currentTarget.target === "_blank"
    ) {
      return;
    }
    const destination = event.currentTarget.getAttribute("href");
    if (!destination || !destination.startsWith("/") || destination.startsWith("//")) return;
    event.preventDefault();
    const permit = collaborationNavigationRef.current?.requestTransition();
    permit?.continue(() => router.push(destination));
  }, [isCollaborationMode, isInternalNavigationBlocked, router]);

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

    const requestScope = documentAsyncScopeRef.current;
    const runningCommandId = createWorkspaceClientId(aiWorkspaceIdRef, "selection_job");
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
    const conversationAttempt = conversations.beginConversation({
      command,
      content: selectedText,
      scopeLabel: chatUserMessage.scopeLabel,
      title: getSelectionCommandLabel(command, language),
    });

    try {
      const requestBody = JSON.stringify({
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
        });
      const result = await postAiOperation<RewriteResponse>(
        aiIdempotencyKeyCacheRef.current,
        "/api/ai/rewrite",
        requestBody,
      );

      if (!result.ok) {
        throw new Error("Failed to rewrite selection");
      }
      if (!isActiveDocumentAsyncScope(requestScope)) return;

      const body = result.body;
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
        await conversations.completeConversation(conversationAttempt, {
          aiRunId: body.run?.id,
          command,
          content: body.proposal.replacementText,
          proposalId: body.proposal.id,
        });
      }
      if (body.run) {
        setReviewRuns((currentRuns) => [body.run!, ...currentRuns]);
      }
      if (!body.proposal) conversations.markConversationIdle(conversationAttempt);
    } catch {
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      await conversations.failConversation(conversationAttempt);
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      setReviewError(messages.errors.selectionRewriteFailed);
    } finally {
      if (isActiveDocumentAsyncScope(requestScope)) {
        updateRunningSelectionCommands((currentCommands) =>
          currentCommands.filter((runningCommand) => runningCommand.id !== runningCommandId),
        );
      }
    }
  }, [
    document.id,
    draft.contentJson,
    draft.title,
    language,
    messages,
    conversations,
    isActiveDocumentAsyncScope,
    selectedTemplate,
    templateVariables,
    updateRunningSelectionCommands,
  ]);

  const saveDraft = useCallback(async () => {
    if (
      isCollaborationMode
      || saveConflict
      || isWorkflowMutating
      || workflowMutationControllerRef.current
    ) return;
    const requestScope = documentAsyncScopeRef.current;
    const requestGeneration = saveRequestGenerationRef.current + 1;
    saveRequestGenerationRef.current = requestGeneration;
    const savingVersion = draftVersionRef.current;
    const savingDraft = draft;
    const expectedRevision = serverRevisionRef.current;

    setProjectProfileViolation(null);
    setSaveState("saving");

    const result = await documentSessionClient.save(document.id, savingDraft, expectedRevision);
    if (!isActiveDocumentAsyncScope(requestScope)) return;
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
    if (result.kind === "invalid_profile") {
      if (requestGeneration !== saveRequestGenerationRef.current) return;
      setProjectProfileViolation(result.violation);
      setSaveState(draftVersionRef.current === savingVersion ? "failed" : "dirty");
      return;
    }
    if (requestGeneration !== saveRequestGenerationRef.current) return;
    setSaveState(draftVersionRef.current === savingVersion ? "failed" : "dirty");
  }, [
    adoptServerRevision,
    document.id,
    draft,
    enterRevisionConflictRecovery,
    isActiveDocumentAsyncScope,
    isCollaborationMode,
    isWorkflowMutating,
    saveConflict,
  ]);

  useEffect(() => {
    if (isCollaborationMode || saveState !== "dirty" || saveConflict) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void saveDraft();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isCollaborationMode, saveConflict, saveDraft, saveState]);

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
    const hasPendingLegacyChanges = saveState === "dirty"
      || saveState === "failed"
      || saveState === "saving";
    if (isCollaborationMode || !hasPendingLegacyChanges) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (intentionalNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isCollaborationMode, saveState]);

  const downloadDocxSnapshot = useCallback(async (
    snapshot: Pick<PendingDocxExport, "contentJson" | "title">,
    acknowledgedLoss: boolean,
    signal: AbortSignal,
  ) => {
    const blob = await fetchDocumentInterchange(`/api/documents/${encodeURIComponent(document.id)}/export`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        acknowledgedLoss,
        title: snapshot.title,
        contentJson: snapshot.contentJson,
      }),
    }, async (response) => {
      if (!response.ok) throw new Error("Failed to export DOCX");
      return response.blob();
    });
    if (signal.aborted) throw signal.reason;
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${sanitizeDownloadFileName(snapshot.title)}.docx`;
    link.click();
    URL.revokeObjectURL(url);
  }, [document.id]);

  const exportDocxDraft = useCallback(async () => {
    if (isCollaborationMode || isExportingDocx || pendingDocxExport) return;
    docxExportRequestRef.current?.abort();
    const requestController = new AbortController();
    docxExportRequestRef.current = requestController;
    const snapshot = { contentJson: draft.contentJson, title: draft.title };
    setIsExportingDocx(true);
    setDocxExportError("");

    try {
      const body = await fetchDocumentInterchange(`/api/documents/${encodeURIComponent(document.id)}/export/preview`, {
        method: "POST",
        signal: requestController.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contentJson: snapshot.contentJson,
        }),
      }, async (response) => {
        if (!response.ok) throw new Error("Failed to preview DOCX export");
        return response.json() as Promise<{ fidelity?: FidelityReport }>;
      });
      if (!body.fidelity || !Array.isArray(body.fidelity.items)) {
        throw new Error("DOCX export fidelity missing");
      }

      if (body.fidelity.requiresAcknowledgement) {
        setPendingDocxExport({ ...snapshot, fidelity: body.fidelity });
      } else {
        await downloadDocxSnapshot(snapshot, false, requestController.signal);
      }
    } catch {
      if (docxExportRequestRef.current === requestController && !requestController.signal.aborted) {
        setDocxExportError(messages.errors.exportDocxFailed);
      }
    } finally {
      if (docxExportRequestRef.current === requestController) {
        docxExportRequestRef.current = null;
        setIsExportingDocx(false);
      }
    }
  }, [
    document.id,
    downloadDocxSnapshot,
    draft.contentJson,
    draft.title,
    isCollaborationMode,
    isExportingDocx,
    messages.errors.exportDocxFailed,
    pendingDocxExport,
  ]);

  const confirmLossyDocxExport = useCallback(async () => {
    if (isCollaborationMode || !pendingDocxExport || isExportingDocx) return;
    docxExportRequestRef.current?.abort();
    const requestController = new AbortController();
    docxExportRequestRef.current = requestController;
    setIsExportingDocx(true);
    setDocxExportError("");
    try {
      await downloadDocxSnapshot(pendingDocxExport, true, requestController.signal);
      setPendingDocxExport(null);
    } catch {
      if (docxExportRequestRef.current === requestController && !requestController.signal.aborted) {
        setPendingDocxExport(null);
        setDocxExportError(messages.errors.exportDocxFailed);
      }
    } finally {
      if (docxExportRequestRef.current === requestController) {
        docxExportRequestRef.current = null;
        setIsExportingDocx(false);
      }
    }
  }, [downloadDocxSnapshot, isCollaborationMode, isExportingDocx, messages.errors.exportDocxFailed, pendingDocxExport]);

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
    if (isCollaborationMode || !selectedTemplate) {
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

    const requestScope = documentAsyncScopeRef.current;
    setIsReviewing(true);
    setReviewError("");
    setActiveProposalId(null);
    setReviewProposals([]);
    setReviewSummary(null);
    setTemplateVariableErrors({});

    try {
      const requestBody = JSON.stringify({
          documentId: document.id,
          templateId: selectedTemplate.id,
          command: "Review document",
          variables: variablesForReview,
          documentText: extractPlainTextFromTiptap(draft.contentJson),
        });
      const result = await postAiOperation<ReviewResponse>(
        aiIdempotencyKeyCacheRef.current,
        "/api/ai/review",
        requestBody,
      );

      if (!result.ok) {
        throw new Error("Failed to run review");
      }
      if (!isActiveDocumentAsyncScope(requestScope)) return;

      const body = result.body;
      setReviewProposals((current) => prependItemsById(current, body.proposals ?? []));
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
      if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.reviewFailed);
    } finally {
      if (isActiveDocumentAsyncScope(requestScope)) setIsReviewing(false);
    }
  }, [document.id, draft.contentJson, isActiveDocumentAsyncScope, isCollaborationMode, messages, selectedTemplate, templateVariables]);

  const updateProposalStatus = useCallback(async (
    proposalId: string,
    status: AiReviewProposal["status"],
    applyMode: AiProposalApplyMode = "replace",
  ) => {
    if (isCollaborationMode) return;
    const requestScope = documentAsyncScopeRef.current;
    let previousProposal = reviewProposals.find((proposal) => proposal.id === proposalId);
    if (!previousProposal) {
      return;
    }
    if (status === "accepted") setProjectProfileViolation(null);
    if (status === "accepted" && previousProposal.isTruncated) {
      try {
        previousProposal = await fetchProposalDetail(previousProposal.id);
        if (!isActiveDocumentAsyncScope(requestScope)) return;
        const hydratedProposal = previousProposal;
        setReviewProposals((current) => current.map((proposal) =>
          proposal.id === hydratedProposal.id ? hydratedProposal : proposal));
      } catch {
        if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.updateProposalFailed);
        return;
      }
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
      if (!isActiveDocumentAsyncScope(requestScope)) return;
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
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      if (recoverProjectProfileViolation(error)) {
        setSelectionApplicationNotice("");
        setReviewError("");
        return;
      }
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
    isActiveDocumentAsyncScope,
    isCollaborationMode,
    messages.errors,
    messages.selectionResult.appliedNotice,
    reviewProposals,
    recoverProjectProfileViolation,
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

  const loadProposalDetail = useCallback(async (proposalId: string) => {
    const requestScope = documentAsyncScopeRef.current;
    try {
      const proposal = await fetchProposalDetail(proposalId);
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      setReviewProposals((current) => current.map((candidate) => candidate.id === proposal.id ? proposal : candidate));
      setActiveProposalId(proposalId);
      setReviewError("");
    } catch {
      if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.updateProposalFailed);
    }
  }, [isActiveDocumentAsyncScope, messages.errors.updateProposalFailed]);

  const updatePendingProposalStatuses = useCallback(async (status: "accepted" | "rejected") => {
    if (isCollaborationMode) return;
    if (proposalCursor !== null) {
      return;
    }
    const requestScope = documentAsyncScopeRef.current;
    let pendingProposals = reviewProposals.filter((proposal) => proposal.status === "pending");
    if (pendingProposals.length === 0) {
      return;
    }
    if (status === "accepted") setProjectProfileViolation(null);

    const startingDraftVersion = draftVersionRef.current;

    if (status === "accepted" && pendingProposals.some((proposal) => proposal.isTruncated)) {
      try {
        const hydrated = await Promise.all(pendingProposals.map((proposal) =>
          proposal.isTruncated ? fetchProposalDetail(proposal.id) : Promise.resolve(proposal)));
        if (!isActiveDocumentAsyncScope(requestScope)) return;
        const hydratedById = new Map(hydrated.map((proposal) => [proposal.id, proposal]));
        setReviewProposals((current) => current.map((proposal) => hydratedById.get(proposal.id) ?? proposal));
        pendingProposals = hydrated;
      } catch {
        if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.updateProposalFailed);
        return;
      }
    }

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
        if (!isActiveDocumentAsyncScope(requestScope)) return;
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
        if (!isActiveDocumentAsyncScope(requestScope)) return;
        if (recoverProjectProfileViolation(error)) {
          setReviewError("");
        } else if (recoverSessionRevisionConflict(error)) {
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
        if (!isActiveDocumentAsyncScope(requestScope)) return;
        if (updatedProposal) {
          updatedProposals.push(updatedProposal);
        }
      } catch (error) {
        if (!isActiveDocumentAsyncScope(requestScope)) return;
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
    isActiveDocumentAsyncScope,
    isCollaborationMode,
    messages.errors.staleSelection,
    messages.errors.updateProposalFailed,
    recoverProjectProfileViolation,
    recoverSessionRevisionConflict,
    reviewProposals,
    proposalCursor,
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

  const loadMoreRuns = useCallback(async () => {
    if (!runsCursor || isLoadingRuns) return;
    const requestScope = documentAsyncScopeRef.current;
    setIsLoadingRuns(true);
    try {
      const response = await fetch(
        `/api/documents/${encodeURIComponent(document.id)}/ai-runs?cursor=${encodeURIComponent(runsCursor)}&limit=20`,
      );
      if (!response.ok) throw new Error("Failed to load AI runs");
      const body = aiRunPageResponseSchema.parse(await response.json());
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      setReviewRuns((current) => mergeItemsById(current, body.runs.map((run) => ({
        ...run,
        createdAt: new Date(run.createdAt),
      }))));
      setRunsCursor(body.nextCursor);
    } catch {
      if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.reviewFailed);
    } finally {
      if (isActiveDocumentAsyncScope(requestScope)) setIsLoadingRuns(false);
    }
  }, [document.id, isActiveDocumentAsyncScope, isLoadingRuns, messages.errors.reviewFailed, runsCursor]);

  const loadMoreProposals = useCallback(async () => {
    if (!proposalCursor || isLoadingProposals) return;
    const requestScope = documentAsyncScopeRef.current;
    setIsLoadingProposals(true);
    try {
      const response = await fetch(
        `/api/documents/${encodeURIComponent(document.id)}/proposals?cursor=${encodeURIComponent(proposalCursor)}&limit=20`,
      );
      if (!response.ok) throw new Error("Failed to load proposals");
      const body = proposalPageResponseSchema.parse(await response.json());
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      setReviewProposals((current) => mergeItemsById(current, body.proposals));
      setProposalCursor(body.nextCursor);
    } catch {
      if (isActiveDocumentAsyncScope(requestScope)) setReviewError(messages.errors.reviewFailed);
    } finally {
      if (isActiveDocumentAsyncScope(requestScope)) setIsLoadingProposals(false);
    }
  }, [document.id, isActiveDocumentAsyncScope, isLoadingProposals, messages.errors.reviewFailed, proposalCursor]);

  const loadDocumentChanges = useCallback(async (cursor?: string) => {
    if (isCollaborationMode) return;
    if (documentChangesLoadingRef.current || (cursor === undefined && documentChangesLoadedRef.current)) return;
    const requestScope = documentAsyncScopeRef.current;
    documentChangesLoadingRef.current = true;
    setIsLoadingDocumentChanges(true);
    setDocumentChangesError("");
    try {
      const history = await documentSessionClient.listChanges(document.id, { cursor, limit: 20 });
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      setDocumentChanges((currentChanges) => mergeDocumentChanges(currentChanges, history.changes));
      setDocumentChangesNextCursor(history.nextCursor);
      if (cursor === undefined) {
        documentChangesLoadedRef.current = true;
      }
    } catch {
      if (isActiveDocumentAsyncScope(requestScope)) {
        setDocumentChangesError(messages.aiWorkspace.changeLoadFailed);
      }
    } finally {
      if (isActiveDocumentAsyncScope(requestScope)) {
        documentChangesLoadingRef.current = false;
        setIsLoadingDocumentChanges(false);
      }
    }
  }, [document.id, isActiveDocumentAsyncScope, isCollaborationMode, messages.aiWorkspace.changeLoadFailed]);

  const undoAppliedChange = useCallback(async (changeId: string) => {
    if (isCollaborationMode) return;
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

    const requestScope = documentAsyncScopeRef.current;
    const startingDraftVersion = draftVersionRef.current;
    setProjectProfileViolation(null);
    setUndoChangeError("");

    try {
      const result = await documentSessionClient.undoChange(changeId, serverRevisionRef.current);
      if (!isActiveDocumentAsyncScope(requestScope)) return;
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
      if (!isActiveDocumentAsyncScope(requestScope)) return;
      if (recoverProjectProfileViolation(error)) {
        setUndoChangeError("");
      } else if (recoverSessionRevisionConflict(error)) {
        setUndoChangeError("");
      } else {
        setUndoChangeError(messages.aiWorkspace.undoConflict);
      }
    }
  }, [
    adoptServerRevision,
    documentChanges,
    isActiveDocumentAsyncScope,
    isCollaborationMode,
    messages.aiWorkspace.undoConflict,
    recoverProjectProfileViolation,
    recoverSessionRevisionConflict,
    saveState,
  ]);

  const archiveAiChatSession = useCallback((sessionId: string) => {
    void conversations.archiveConversation(sessionId);
  }, [conversations]);

  const renameAiChatSession = useCallback((sessionId: string, title: string) => {
    void conversations.renameConversation(sessionId, title);
  }, [conversations]);

  const forkAiChatSession = useCallback((sessionId: string, messageId: string) => {
    void conversations.forkConversation(sessionId, messageId);
  }, [conversations]);

  const selectedTemplateName = selectedTemplate?.name ?? "";
  const workflowReadiness = workflowState?.readiness ?? draft.readiness;
  const collaborationApprovalIsDurable = Boolean(
    collaborationRuntime?.snapshot.status === "synced" &&
    collaborationRuntime.snapshot.transportSynced &&
    !hasPendingCollaborationUpdates(collaborationRuntime.snapshot),
  );
  const workflowControlEnabled = Boolean(
    workflowState &&
    !isWorkflowMutating &&
    (isCollaborationMode || (saveState === "saved" && saveConflict === null)) &&
    (
      !isCollaborationMode ||
      (
        collaborationRuntime?.snapshot.hasCompletedInitialSync &&
        collaborationRuntime.snapshot.permission === "write" &&
        collaborationRuntime.snapshot.status !== "fatal"
      )
    ),
  );
  const workflowDescription = workflowState?.collaboration === null
    ? messages.metadataPanel.readinessApprovalLegacyUnsupported
    : workflowReadiness === "ready" && isCollaborationMode && !collaborationApprovalIsDurable
      ? messages.metadataPanel.readinessApprovalDurability
      : messages.metadataPanel.readinessServerAuthority;
  const workflowFeedbackMessage = isWorkflowMutating
    ? messages.metadataPanel.readinessSaving
    : workflowFeedback === "saved"
      ? messages.metadataPanel.readinessSaved
      : workflowFeedback === "approval_durability_pending"
        ? messages.metadataPanel.readinessApprovalDurability
        : workflowFeedback === "legacy_approval_unsupported"
          ? messages.metadataPanel.readinessApprovalLegacyUnsupported
          : workflowFeedback === "expected_readiness_conflict" || workflowFeedback === "head_conflict"
            ? messages.metadataPanel.readinessConflict
            : workflowFeedback === "forbidden"
              ? messages.metadataPanel.readinessForbidden
              : workflowFeedback === "invalid_project_profile"
                ? messages.metadataPanel.readinessInvalidProfile
                : workflowFeedback
                  ? messages.metadataPanel.readinessUnavailable
                  : !workflowState && isCollaborationMode
                    ? messages.metadataPanel.readinessChecking
                    : "";
  const workflowFeedbackKind = workflowFeedback && (
    workflowFeedback !== "saved" && workflowFeedback !== "approval_durability_pending"
  ) ? "error" as const : "status" as const;
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
    const selectedTemplateForSnapshot = selectedTemplate ?? initialTemplate;
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
        readiness: workflowReadiness,
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
    workflowReadiness,
    draft.title,
    initialTemplate,
    messages.shell.untitledDocument,
    referenceDocuments,
    selectedTemplate,
    selectionCommand,
    templateVariables,
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
    if (isCollaborationMode && isLegacyBodyCommand(commandId)) return;
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
  }, [exportDocxDraft, isCollaborationMode, openFind, runDocumentReview, saveDraft, setWorkspaceOpen]);
  const commandPaletteActions = useMemo(
    () => buildDocumentCommandRegistry({
      editorSurface,
      hasSaveConflict: saveConflict !== null,
      isExportingDocx,
      messages: messages.commandPalette,
      saveState,
    }).map((definition): DocumentCommandAction => ({
      ...definition,
      enabled: isCollaborationMode && isLegacyBodyCommand(definition.id)
        ? false
        : definition.enabled,
      execute: () => executeDocumentCommand(definition.id),
    })),
    [
      editorSurface,
      executeDocumentCommand,
      isExportingDocx,
      isCollaborationMode,
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
          {messages.aiWorkspace.user.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-950">
            {messages.aiWorkspace.user}
          </p>
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
          disabled={isCollaborationMode}
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
        {!isCollaborationMode ? (
          <DocumentOutlinePanel
            activeItemId={activeOutlineItemId}
            messages={messages.outline}
            onSelectItem={selectOutlineItem}
            outline={documentOutline}
          />
        ) : null}

        <DocumentMetadataPanel
          isReadinessOptionDisabled={(next) => next === "approved" && (
            workflowState?.collaboration === null ||
            !isCollaborationMode ||
            !collaborationApprovalIsDurable
          )}
          language={language}
          metadata={activeCollaborationFields ? collaborationMetadata : draft.metadataJson}
          metadataDisabled={isCollaborationMode && (
            !activeCollaborationFields || !collaborationRuntime?.snapshot.writable
          )}
          metadataDraftIdentity={activeCollaborationFields ?? projectProfile}
          messages={messages.metadataPanel}
          onMetadataFieldChange={handleMetadataFieldChange}
          onReadinessChange={handleReadinessChange}
          profile={projectProfile}
          readiness={workflowReadiness}
          readinessDescription={workflowDescription}
          readinessDisabled={!workflowControlEnabled}
          readinessFeedback={workflowFeedbackMessage}
          readinessFeedbackKind={workflowFeedbackKind}
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
          <AiRunHistory
            hasMore={runsCursor !== null}
            isLoadingMore={isLoadingRuns}
            language={language}
            messages={messages.history}
            onLoadMore={() => void loadMoreRuns()}
            runs={reviewRuns}
          />
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
      conversationErrorMessage={conversations.errorReason ? messages.aiWorkspace.conversationLoadFailed : ""}
      conversationLoadState={conversations.loadState}
      errorMessage={reviewError}
      hasMoreChanges={documentChangesNextCursor !== null}
      hasMoreConversations={conversations.hasMore}
      isLoadingChanges={isLoadingDocumentChanges}
      isLoadingMoreConversations={conversations.isLoadingMore}
      isReviewing={isReviewing}
      isRunningCommand={isRewritingSelection}
      language={language}
      layout={layout}
      messages={messages.aiWorkspace}
      onArchiveChatSession={archiveAiChatSession}
      onBulkUpdateProposalStatus={proposalCursor === null ? updatePendingProposalStatuses : undefined}
      onChangesOpen={loadDocumentChanges}
      onClose={onClose}
      onFocusProposal={setActiveProposalId}
      hasMoreProposals={proposalCursor !== null}
      isLoadingMoreProposals={isLoadingProposals}
      onLoadMoreProposals={() => void loadMoreProposals()}
      onLoadProposalDetail={(proposalId) => void loadProposalDetail(proposalId)}
      onForkChatSession={forkAiChatSession}
      onLoadMoreChanges={documentChangesNextCursor !== null
        ? () => void loadDocumentChanges(documentChangesNextCursor)
        : undefined}
      onLoadMoreConversations={() => void conversations.loadMore()}
      onReviewDocument={runDocumentReview}
      onRenameChatSession={renameAiChatSession}
      onSelectChatSession={(sessionId) => void conversations.loadConversationDetail(sessionId)}
      onRetryConversation={() => void (conversations.hasPendingRetries
        ? conversations.retryLastMutation()
        : conversations.loadState === "failed"
          ? conversations.reload()
          : conversations.loadMoreErrorReason
            ? conversations.loadMore()
            : conversations.retryLastMutation())}
      onRetryChatSession={(sessionId) => void conversations.loadConversationDetail(sessionId, true)}
      onUndoChange={undoAppliedChange}
      onUpdateProposalStatus={updateProposalStatusLocally}
      proposals={reviewProposals}
      pluginContext={pluginWorkspaceContext}
      pluginPanels={resolvedPluginContributions.workspacePanels}
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
  const collaborationProvider = collaborationRuntime?.session?.provider ?? null;
  const collaborationEditorSession = useMemo(() => (
    collaborationRuntime?.snapshot.hasCompletedInitialSync
    && collaborationRuntime.session
    && activeCollaborationFields
    && hasCollaborationAwareness(collaborationProvider)
      ? {
          document: collaborationRuntime.session.document,
          fields: activeCollaborationFields,
          provider: collaborationProvider,
          writable: collaborationRuntime.snapshot.writable,
        }
      : null
  ), [
    collaborationProvider,
    collaborationRuntime,
    activeCollaborationFields,
  ]);

  return (
    <main className="flex h-dvh min-h-0 w-full min-w-0 overflow-hidden bg-white text-zinc-950">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 lg:flex">
        {renderSidebarContent()}
      </aside>

      {isSidebarOpen && isCompactSidebar ? (
        <ModalSurface
          aria-label={messages.shell.openSidebar}
          className="h-full w-[min(18rem,100vw)] bg-zinc-50 p-0"
          onClose={() => setIsSidebarOpen(false)}
          overlayClassName="fixed inset-0 flex items-stretch justify-start bg-zinc-950/20 p-0 lg:hidden"
          unstyled
        >
          <aside className="flex h-full flex-col border-r border-zinc-200 bg-zinc-50 shadow-2xl shadow-zinc-950/20">
            {renderSidebarContent()}
          </aside>
        </ModalSurface>
      ) : null}

      <section aria-label={messages.editor.workspaceLabel} className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex min-h-14 min-w-0 shrink-0 flex-col gap-2 border-b border-zinc-200 bg-white px-3 py-2 sm:px-4 xl:flex-row xl:items-center xl:justify-between xl:py-0">
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 xl:flex-nowrap">
            <button
              aria-label={messages.shell.openSidebar}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 lg:hidden"
              onClick={() => setIsSidebarOpen(true)}
              type="button"
            >
              <PanelLeftOpen aria-hidden="true" className="size-4" />
            </button>
            <p className="min-w-0 max-w-[34rem] flex-[1_1_8rem] truncate text-sm font-medium text-zinc-800">
              {(activeCollaborationFields ? collaborationTitle : draft.title) || messages.shell.untitledDocument}
            </p>
            {isCollaborationMode ? (
              <CollaborationStatus
                className="flex-[1_1_12rem] font-medium xl:flex-initial"
                language={language}
                snapshot={collaborationRuntime.snapshot}
              />
            ) : (
              <div
                aria-label={messages.header.saveStatus}
                aria-live="polite"
                className="shrink-0 text-xs font-medium text-zinc-500"
                role="status"
              >
                {messages.saveState[saveState]}
              </div>
            )}
            {isCollaborationMode ? (
              <CollaborationParticipants
                awareness={collaborationProvider?.awareness ?? null}
                className="ml-auto shrink-0"
                currentPrincipalId={collaborationRuntime.currentPrincipalId}
                language={language}
              />
            ) : null}
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 overflow-x-auto pb-1 xl:w-auto xl:overflow-visible xl:pb-0">
            <button
              aria-label={editorSurface === "source" ? messages.header.editorView : messages.header.sourceView}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              disabled={isCollaborationMode}
              onClick={() => {
                if (!isCollaborationMode) {
                  setEditorSurface((currentSurface) => (currentSurface === "source" ? "editor" : "source"));
                }
              }}
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
              disabled={isCollaborationMode || isExportingDocx}
              onClick={exportDocxDraft}
              ref={exportTriggerRef}
              type="button"
            >
              <Download aria-hidden="true" className="size-4" />
              <span className="hidden whitespace-nowrap 2xl:inline">
                {isExportingDocx ? messages.header.exportingDocx : messages.header.exportDocx}
              </span>
            </button>
            <AiSettingsDialog
              language={language}
              pluginSections={resolvedPluginContributions.settingsSections}
            />
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
              disabled={isCollaborationMode}
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
              disabled={
                isCollaborationMode
                || isWorkflowMutating
                || saveConflict !== null
                || saveState === "saved"
                || saveState === "saving"
              }
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

        {projectProfileViolation ? (
          <section
            aria-labelledby="project-profile-error-title"
            aria-live="assertive"
            className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-3 text-red-900"
            role="alert"
          >
            <h2 className="text-sm font-semibold" id="project-profile-error-title">
              {projectProfileErrorTitle}
            </h2>
            <p className="mt-1 text-sm leading-5">{projectProfileErrorMessage}</p>
          </section>
        ) : null}

        {!isCollaborationMode && docxExportError ? (
          <section
            aria-labelledby="docx-export-error-title"
            aria-live="assertive"
            className="flex shrink-0 items-start justify-between gap-4 border-b border-red-200 bg-red-50 px-4 py-3 text-red-900"
            role="alert"
          >
            <div>
              <h2 className="text-sm font-semibold" id="docx-export-error-title">
                {messages.documentInterchange.exportFailureTitle}
              </h2>
              <p className="mt-1 text-sm leading-5">{docxExportError}</p>
            </div>
            <button
              className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
              disabled={isExportingDocx}
              onClick={() => void exportDocxDraft()}
              type="button"
            >
              {messages.documentInterchange.retryExport}
            </button>
          </section>
        ) : null}

        {!isCollaborationMode && saveConflict ? (
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
              disabled={isCollaborationMode}
              type="button"
            >
              {messages.sourceView.sourceTab}
            </button>
          </div>
        </div>

        {editorSurface === "editor" || isCollaborationMode ? (
          collaborationEditorSession ? (
            <DocumentEditor
              key={`${document.id}:collaboration`}
              isFindOpen={isFindOpen}
              language={language}
              messages={messages.editor}
              mode={{
                kind: "collaboration",
                session: collaborationEditorSession,
              }}
              onFindOpenChange={setIsFindOpen}
              outlineFocusRequest={outlineFocusRequest}
              resolvedPluginContributions={resolvedPluginContributions}
            />
          ) : isCollaborationMode ? (
            <CollaborationReadOnlyProjection
              plainText={document.plainText}
              title={draft.title}
            />
          ) : (
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
              resolvedPluginContributions={resolvedPluginContributions}
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
          )
        ) : (
          <DocumentSourceView contentJson={draft.contentJson} messages={messages.sourceView} title={draft.title} />
        )}
      </section>

      {!isCollaborationMode && pendingDocxExport ? (
        <DocumentInterchangeDialog
          actionsDisabled={isExportingDocx}
          cancelLabel={messages.documentInterchange.cancel}
          confirmLabel={messages.documentInterchange.confirmExport}
          description={messages.documentInterchange.exportLossDescription}
          onClose={() => setPendingDocxExport(null)}
          onConfirm={() => void confirmLossyDocxExport()}
          returnFocusRef={exportTriggerRef}
          title={messages.documentInterchange.exportLossTitle}
        >
          <h3 className="mt-4 text-sm font-semibold text-zinc-900">
            {messages.documentInterchange.fidelityTitle}
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-700">
            {pendingDocxExport.fidelity.items
              .filter((item) => item.outcome !== "preserved")
              .map((item) => (
                <li key={`${item.feature}:${item.outcome}:${item.message ?? ""}`}>
                  {getFidelityFeatureLabel(item.feature, language)}: {getFidelityOutcomeLabel(item.outcome, language)}
                  {item.message ? ` — ${item.message}` : ""}
                </li>
              ))}
          </ul>
        </DocumentInterchangeDialog>
      ) : null}

      {isWorkspaceOpen && !isCollaborationMode ? (
        <>
          {renderWorkspacePanel("side")}
          {isCompactWorkspace ? (
            <ModalSurface
              aria-label={messages.shell.review}
              className="ml-auto h-full w-[min(100vw,24rem)] bg-white p-0"
              onClose={() => setWorkspaceOpen(false)}
              overlayClassName="fixed inset-0 flex items-stretch justify-end bg-zinc-950/20 p-0 xl:hidden"
              unstyled
            >
              {renderWorkspacePanel("drawer", () => setWorkspaceOpen(false))}
            </ModalSurface>
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

function formatProjectProfileViolation(
  profile: ProjectProfile,
  violation: ProjectProfileViolation,
  language: EditorLanguage,
) {
  const profileLabel = language === "ko"
    ? `${profile.labels.ko.name} 프로필`
    : `${profile.labels.en.name} profile`;

  if ("fieldId" in violation) {
    const field = profile.metadataFields.find((candidate) => candidate.id === violation.fieldId);
    const fieldLabel = field?.labels[language] ?? violation.fieldId;

    if (language === "ko") {
      switch (violation.reason) {
        case "required":
          return `${profileLabel}: ${fieldLabel} 필드는 필수입니다.`;
        case "invalid_length":
          if (field?.type === "tags") {
            const maxItems = field.maxItems ?? PROJECT_METADATA_LIMITS.maxTagCount;
            const itemMaxLength = field.itemMaxLength ?? PROJECT_METADATA_LIMITS.maxTagLength;
            return `${profileLabel}: ${fieldLabel} 값은 최대 ${maxItems}개, 항목당 ${itemMaxLength}자까지 입력할 수 있습니다.`;
          }
          return `${profileLabel}: ${fieldLabel} 값은 최대 ${field?.maxLength ?? PROJECT_METADATA_LIMITS.maxTextLength}자까지 입력할 수 있습니다.`;
        case "invalid_option":
          return `${profileLabel}: ${fieldLabel} 값이 허용된 옵션이 아닙니다. 목록에서 다시 선택하세요.`;
        case "invalid_type":
          return `${profileLabel}: ${fieldLabel} 값의 형식이 올바르지 않습니다. 필드 형식에 맞게 수정하세요.`;
        case "unknown_field":
          return `${profileLabel}: ${fieldLabel} 필드는 현재 프로필에 없습니다. 값을 제거한 뒤 다시 저장하세요.`;
      }
    }

    switch (violation.reason) {
      case "required":
        return `${profileLabel}: ${fieldLabel} is required.`;
      case "invalid_length":
        if (field?.type === "tags") {
          const maxItems = field.maxItems ?? PROJECT_METADATA_LIMITS.maxTagCount;
          const itemMaxLength = field.itemMaxLength ?? PROJECT_METADATA_LIMITS.maxTagLength;
          return `${profileLabel}: ${fieldLabel} accepts up to ${maxItems} items and ${itemMaxLength} characters per item.`;
        }
        return `${profileLabel}: ${fieldLabel} accepts up to ${field?.maxLength ?? PROJECT_METADATA_LIMITS.maxTextLength} characters.`;
      case "invalid_option":
        return `${profileLabel}: ${fieldLabel} is not an allowed option. Select a value from the list.`;
      case "invalid_type":
        return `${profileLabel}: ${fieldLabel} has an invalid value type. Enter a value that matches the field.`;
      case "unknown_field":
        return `${profileLabel}: ${fieldLabel} is not part of the active profile. Remove it and save again.`;
    }
  }

  const currentLabel = profile.readiness.find((state) => state.id === violation.current)?.labels[language]
    ?? violation.current;
  const nextLabel = profile.readiness.find((state) => state.id === violation.next)?.labels[language]
    ?? violation.next;
  return language === "ko"
    ? `${profileLabel}: ${currentLabel} 상태에서 ${nextLabel} 상태로 바로 변경할 수 없습니다. 허용된 준비 상태를 선택하세요.`
    : `${profileLabel}: readiness cannot move directly from ${currentLabel} to ${nextLabel}. Select an allowed state.`;
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

function CollaborationReadOnlyProjection({
  plainText,
  title,
}: {
  plainText: string;
  title: string;
}) {
  return (
    <article
      aria-label="Collaboration read-only projection"
      className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-8 sm:px-16 lg:px-20"
    >
      <div className="mx-auto w-full max-w-[54rem]">
        <h1 className="text-3xl font-semibold text-zinc-950">{title}</h1>
        <p className="mt-8 whitespace-pre-wrap text-base leading-7 text-zinc-800">
          {plainText}
        </p>
      </div>
    </article>
  );
}

function hasCollaborationAwareness(
  provider: HocuspocusProvider | null,
): provider is HocuspocusProvider & { awareness: Awareness } {
  return provider?.awareness !== null && provider?.awareness !== undefined;
}

function isLegacyBodyCommand(commandId: DocumentCommandAction["id"]) {
  return commandId === "open-workspace"
    || commandId === "review-document"
    || commandId === "show-source"
    || commandId === "save-document"
    || commandId === "export-docx";
}

function getInitialTemplate(templates: readonly ShellTemplate[], defaultTemplateId?: string) {
  return templates.find((template) => template.id === defaultTemplateId) ?? templates[0] ?? null;
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

function mergeItemsById<T extends { id: string }>(current: readonly T[], incoming: readonly T[]) {
  const currentIds = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !currentIds.has(id))];
}

function prependItemsById<T extends { id: string }>(current: readonly T[], incoming: readonly T[]) {
  const incomingIds = new Set(incoming.map(({ id }) => id));
  return [...incoming, ...current.filter(({ id }) => !incomingIds.has(id))];
}

async function fetchProposalDetail(proposalId: string): Promise<AiReviewProposal> {
  const response = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}`);
  if (!response.ok) throw new Error("Failed to load proposal detail");
  const body = proposalDetailResponseSchema.parse(await response.json());
  if (body.proposal.id !== proposalId) throw new Error("Mismatched proposal detail");
  return { ...body.proposal, isTruncated: false };
}

const parseableDateStringSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected a parseable date string",
);

const aiRunPageResponseSchema = z.object({
  nextCursor: z.string().min(1).nullable(),
  runs: z.array(z.object({
    commandType: z.enum(["selection_rewrite", "document_review"]),
    createdAt: parseableDateStringSchema,
    id: z.string().min(1),
    status: z.enum(["pending", "streaming", "completed", "failed"]),
  }).strict()),
}).strict();

const proposalSchema = z.object({
  appliedMode: z.enum(["replace", "insert_below"]).nullable(),
  command: z.string().nullable(),
  defaultApplyMode: z.enum(["replace", "insert_below"]),
  explanation: z.string(),
  id: z.string().min(1),
  occurrenceIndex: z.number().int().nullable(),
  replacementText: z.string(),
  source: z.enum(["selection", "review"]),
  status: z.enum(["pending", "accepted", "rejected"]),
  targetFrom: z.number().int().nullable(),
  targetText: z.string(),
  targetTo: z.number().int().nullable(),
}).strict();

const proposalDetailResponseSchema = z.object({
  proposal: proposalSchema,
}).strict();

const proposalPageResponseSchema = z.object({
  nextCursor: z.string().min(1).nullable(),
  proposals: z.array(proposalSchema.extend({
    createdAt: parseableDateStringSchema,
    isTruncated: z.boolean(),
  }).strict()),
}).strict();
