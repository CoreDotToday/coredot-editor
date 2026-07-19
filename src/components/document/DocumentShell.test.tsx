import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentShell, hasPendingCollaborationUpdates } from "./DocumentShell";
import { SelectionAiMenu } from "./SelectionAiMenu";
import { DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS } from "@/features/documents/document-interchange-fetch";
import { useCollaborationSession } from "@/features/collaboration/client/use-collaboration-session";
import type { CollaborationSessionSnapshot } from "@/features/collaboration/client/session-store";

vi.mock("@/features/collaboration/client/use-collaboration-session", () => ({
  useCollaborationSession: vi.fn(),
}));

vi.mock("./DocumentEditor", () => ({
  DocumentEditor: ({
    contentJson,
    inlineSuggestions = [],
    isFindOpen,
    isSelectionCommandLimitReached,
    isSelectionCommandRunning,
    onChange,
    onApplySelectionAiResult,
    onDismissSelectionAiResult,
    onSelectionCommand,
    runningSelectionCommand,
    runningSelectionCommands = [],
    resolvedPluginContributions,
    selectionAiResult,
    mode,
    language = "ko",
    messages = { titleLabel: "문서 제목" },
    title,
  }: {
    contentJson?: { type: "doc"; content?: unknown[] };
    inlineSuggestions?: Array<{ active?: boolean; id: string; targetText: string }>;
    isFindOpen?: boolean;
    isSelectionCommandLimitReached?: boolean;
    isSelectionCommandRunning?: boolean;
    language?: "en" | "ko";
    messages?: { titleLabel: string };
    mode?: {
      kind: "collaboration";
      session: { document?: unknown; writable: boolean };
      title: string;
    };
    onChange?: (draft: { title: string; contentJson: { type: "doc"; content?: unknown[] } }) => void;
    onApplySelectionAiResult?: (proposalId: string, applyMode: "replace" | "insert_below") => void;
    onDismissSelectionAiResult?: () => void;
    onSelectionCommand?: (
      command: string,
      selectedText: string,
      context?: {
        anchor: { left: number; side: "top" | "bottom"; top: number };
        occurrenceIndex: number;
        selectionRange?: { from: number; to: number };
      },
      references?: Array<{ id: string; title: string }>,
    ) => void;
    runningSelectionCommand?: string;
    runningSelectionCommands?: Array<{ command: string; id: string }>;
    resolvedPluginContributions?: {
      tiptapExtensions: Array<{ name: string }>;
      toolbarItems: Array<{ id: string }>;
    };
    selectionAiResult?: {
      command: string;
      defaultApplyMode: "replace" | "insert_below";
      proposalId: string;
      replacementText: string;
      targetText: string;
    } | null;
    title?: string;
  }) => {
    const resolvedContentJson = contentJson ?? { type: "doc" as const };
    const resolvedTitle = mode?.title ?? title ?? "";

    return <div>
      <input
        aria-label={messages.titleLabel}
        onChange={(event) => onChange?.({ title: event.currentTarget.value, contentJson: resolvedContentJson })}
        readOnly={mode?.kind === "collaboration"}
        value={resolvedTitle}
      />
      <output data-testid="mock-editor-mode">{mode?.kind ?? "legacy"}</output>
      <output data-testid="mock-editor-document-bound">{String(Boolean(mode?.session.document))}</output>
      <output data-testid="mock-editor-writable">{String(mode?.session.writable ?? true)}</output>
      <div data-testid="mock-document-body">{readMockTiptapText(resolvedContentJson)}</div>
      {isFindOpen ? <div role="search" aria-label="mock find bar">Find bar open</div> : null}
      <output data-testid="mock-inline-suggestions">{JSON.stringify(inlineSuggestions)}</output>
      {resolvedPluginContributions ? (
        <output data-testid="mock-resolved-plugin-contributions">
          {JSON.stringify({
            extensions: resolvedPluginContributions.tiptapExtensions.map((item) => item.name),
            toolbarItems: resolvedPluginContributions.toolbarItems.map((item) => item.id),
          })}
        </output>
      ) : null}
      {isSelectionCommandRunning ? (
        <div data-testid="mock-selection-command-running">
          {runningSelectionCommand} {runningSelectionCommands.length}
        </div>
      ) : null}
      {isSelectionCommandLimitReached ? <div data-testid="mock-selection-command-limit">limit reached</div> : null}
      <button onClick={() => onSelectionCommand?.("Improve clarity", "selected text")} type="button">
        Mock selection command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Translate to Korean", "selected text", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 0,
            selectionRange: { from: 1, to: 14 },
          })
        }
        type="button"
      >
        Mock translation command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Continue writing", "selected text", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 0,
            selectionRange: { from: 1, to: 14 },
          })
        }
        type="button"
      >
        Mock continue writing command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.("Improve clarity", "repeat", {
            anchor: { left: 80, side: "bottom", top: 140 },
            occurrenceIndex: 1,
            selectionRange: { from: 8, to: 14 },
          })
        }
        type="button"
      >
        Mock second occurrence command
      </button>
      <button
        onClick={() =>
          onSelectionCommand?.(
            "Compare @Revenue Memo",
            "selected text",
            {
              anchor: { left: 80, side: "bottom", top: 140 },
              occurrenceIndex: 0,
              selectionRange: { from: 1, to: 14 },
            },
            [{ id: "doc_ref", title: "Revenue Memo" }],
          )
        }
        type="button"
      >
        Mock referenced command
      </button>
      <button
        onClick={() =>
          onChange?.({
            title: resolvedTitle,
            contentJson: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "fresh edited body" }] }],
            },
          })
        }
        type="button"
      >
        Mock body edit
      </button>
      {selectionAiResult ? (
        <div aria-label={language === "en" ? "선택 AI 결과" : "선택 AI 결과"} role="region">
          <p>{getMockSelectionCommandLabel(selectionAiResult.command, language)}</p>
          <p>{selectionAiResult.targetText}</p>
          <p>{selectionAiResult.replacementText}</p>
          <button
            onClick={() =>
              onApplySelectionAiResult?.(selectionAiResult.proposalId, selectionAiResult.defaultApplyMode)
            }
            type="button"
          >
            {getMockApplyModeLabel(selectionAiResult.defaultApplyMode, language)}
          </button>
          <button
            onClick={() =>
              onApplySelectionAiResult?.(
                selectionAiResult.proposalId,
                selectionAiResult.defaultApplyMode === "insert_below" ? "replace" : "insert_below",
              )
            }
            type="button"
          >
            {getMockApplyModeLabel(
              selectionAiResult.defaultApplyMode === "insert_below" ? "replace" : "insert_below",
              language,
            )}
          </button>
          <button onClick={onDismissSelectionAiResult} type="button">
            {language === "en" ? "Dismiss" : "닫기"}
          </button>
        </div>
      ) : null}
    </div>
  },
}));

function getMockApplyModeLabel(applyMode: "replace" | "insert_below", language: "en" | "ko") {
  if (language === "en") {
    return applyMode === "insert_below" ? "Insert below" : "Replace";
  }

  return applyMode === "insert_below" ? "아래에 추가" : "교체";
}

function getMockSelectionCommandLabel(command: string, language: "en" | "ko") {
  if (language === "en") {
    return command;
  }

  const labels: Record<string, string> = {
    "Continue writing": "이어서 쓰기",
    "Improve clarity": "명확하게 개선",
    "Translate to Korean": "한국어로 번역",
  };

  return labels[command] ?? command;
}

function readMockTiptapText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  const typedNode = node as { text?: unknown; content?: unknown[] };
  const text = typeof typedNode.text === "string" ? typedNode.text : "";
  const childText = (typedNode.content ?? []).map((child) => readMockTiptapText(child)).join("");

  return `${text}${childText}`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function createDocument(id: string, title: string) {
  return {
    id,
    title,
    contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
    metadataJson: {},
    plainText: "",
    readiness: "draft" as const,
    revision: 0,
  };
}

function createDocumentWithContent(id: string, title: string, paragraphText: string) {
  return {
    id,
    title,
    contentJson: {
      type: "doc" as const,
      content: [{ type: "paragraph", content: [{ type: "text", text: paragraphText }] }],
    },
    metadataJson: {},
    plainText: paragraphText,
    readiness: "draft" as const,
    revision: 0,
  };
}

function createCollaborationConfiguration() {
  return {
    documentId: "doc_1",
    kind: "collaboration" as const,
    room: "organization:org_1:document:doc_1",
    schemaFingerprint: "schema-v1",
    websocketUrl: "wss://collaboration.example.test",
  };
}

function createCollaborationSnapshot(
  overrides: Partial<CollaborationSessionSnapshot> = {},
): CollaborationSessionSnapshot {
  return {
    hasCompletedInitialSync: false,
    pendingDurableAcknowledgementChecksums: [],
    pendingLocalChecksums: [],
    pendingLocalUpdateCount: 0,
    permission: null,
    status: "connecting",
    transportSynced: false,
    writable: false,
    ...overrides,
  };
}

function createMockCollaborationSession() {
  return {
    connect: vi.fn(),
    destroy: vi.fn(),
    document: {},
    provider: { awareness: {} },
    refreshCapability: vi.fn(),
    room: "organization:org_1:document:doc_1",
    store: {},
  } as never;
}

it.each([
  { pendingLocalUpdateCount: 1 },
  { pendingLocalChecksums: ["a".repeat(64)] },
  { pendingDurableAcknowledgementChecksums: ["b".repeat(64)] },
])("treats every collaboration durability queue as pending: %o", (pending) => {
  expect(hasPendingCollaborationUpdates(createCollaborationSnapshot(pending))).toBe(true);
});

it("treats a fully acknowledged collaboration snapshot as navigation-safe", () => {
  expect(hasPendingCollaborationUpdates(createCollaborationSnapshot({
    hasCompletedInitialSync: true,
    permission: "write",
    status: "synced",
    transportSynced: true,
    writable: true,
  }))).toBe(false);
});

function createListDocument(items: string[]) {
  return {
    id: "doc_1",
    title: "List review",
    contentJson: {
      type: "doc" as const,
      content: [{
        type: "bulletList",
        content: items.map((text) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      }],
    },
    metadataJson: {},
    plainText: items.join("\n"),
    readiness: "draft" as const,
    revision: 0,
  };
}

function createTemplate(id: string, name: string) {
  return {
    id,
    name,
    category: "review",
    variableSchemaJson: { fields: [], required: [] },
  };
}

function createRequiredTemplate() {
  return {
    id: "tpl_1",
    name: "Board review",
    category: "review",
    variableSchemaJson: {
      fields: [{ name: "audience", label: "Audience", type: "text" as const, required: true }],
      required: ["audience"],
    },
  };
}

function createStrategyTemplate() {
  return {
    id: "tpl_strategy",
    name: "Executive Rewrite",
    category: "executive_rewrite",
    variableSchemaJson: {
      fields: [
        { name: "audience", label: "Audience", type: "text" as const, required: true },
        { name: "objective", label: "Document objective", type: "textarea" as const, required: true },
        { name: "tone", label: "Tone", type: "select" as const, required: true, options: ["executive", "analytical"] },
      ],
      required: ["audience", "objective", "tone"],
    },
  };
}

function createContractTemplate() {
  return {
    id: "tpl_contract",
    name: "Contract Review",
    category: "contract_review",
    variableSchemaJson: {
      fields: [
        {
          name: "partyPerspective",
          label: "Party perspective",
          type: "select" as const,
          required: true,
          options: ["customer", "vendor", "mutual", "investor"],
        },
        {
          name: "contractType",
          label: "Contract type",
          type: "select" as const,
          required: true,
          options: ["MSA", "NDA", "SaaS Agreement"],
        },
        {
          name: "riskTolerance",
          label: "Risk tolerance",
          type: "select" as const,
          required: true,
          options: ["balanced", "conservative", "aggressive"],
        },
      ],
      required: ["partyPerspective", "contractType", "riskTolerance"],
    },
  };
}

function createProposal(
  id: string,
  status: "pending" | "accepted" | "rejected" = "pending",
  targetText = "growth was good",
) {
  return {
    id,
    targetText,
    replacementText: "revenue grew 8%",
    explanation: "Unclear metric: Specificity helps review.",
    source: "review" as const,
    command: null,
    occurrenceIndex: null,
    targetFrom: null,
    targetTo: null,
    defaultApplyMode: "replace" as const,
    appliedMode: null,
    status,
  };
}

function createChangeIdentity(
  id = "change_1",
  afterRevision = 1,
  kind: "single" | "batch" = "single",
) {
  return {
    id,
    documentId: "doc_1",
    kind,
    batchId: kind === "batch" ? `batch_${id}` : null,
    afterRevision,
    createdAt: "2026-01-01T00:00:00.000Z",
    undoneAt: null,
  };
}

function createProposalApplyResponse(
  proposal: Omit<
    ReturnType<typeof createProposal>,
    "appliedMode" | "defaultApplyMode" | "source" | "targetFrom" | "targetTo"
  > & {
    appliedMode: "replace" | "insert_below" | null;
    defaultApplyMode: "replace" | "insert_below";
    source: "review" | "selection";
    targetFrom: number | null;
    targetTo: number | null;
  },
  document: {
    id: string;
    title: string;
    contentJson: { type: "doc"; content?: unknown[] };
    metadataJson?: Record<string, unknown>;
    readiness?: "draft" | "needs_review" | "ready" | "approved";
    plainText?: string;
    revision?: number;
  },
  appliedMode: "replace" | "insert_below" = "replace",
  revision = 1,
) {
  return {
    change: createChangeIdentity("change_1", revision),
    document: {
      ...document,
      metadataJson: document.metadataJson ?? {},
      readiness: document.readiness ?? "draft",
      revision,
    },
    proposal: { ...proposal, appliedMode, status: "accepted" as const },
  };
}

function createAiRun(id: string) {
  return {
    id,
    commandType: "document_review" as const,
    status: "completed" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });

  return { promise, reject, resolve };
}

function expectProposalApplyFetch(
  fetchMock: { mock: { calls: Array<[unknown, RequestInit?]> } },
  proposalId: string,
  appliedMode: "replace" | "insert_below",
) {
  const expectedUrl = `/api/proposals/${proposalId}/apply`;
  const call = fetchMock.mock.calls.find(([input]) => input === expectedUrl);

  expect(call).toBeDefined();
  const [, init] = call!;
  expect(init).toEqual(expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(String(init?.body))).toMatchObject({
    appliedMode,
    document: {
      id: "doc_1",
      title: expect.any(String),
      contentJson: expect.objectContaining({ type: "doc" }),
      metadataJson: expect.any(Object),
      readiness: expect.any(String),
    },
    expectedRevision: expect.any(Number),
  });
}

function expectLastProposalApplyFetch(
  fetchMock: { mock: { calls: Array<[unknown, RequestInit?]> } },
  proposalId: string,
  appliedMode: "replace" | "insert_below",
) {
  const call = fetchMock.mock.calls.at(-1);

  expect(call).toBeDefined();
  const [input, init] = call!;
  expect(input).toBe(`/api/proposals/${proposalId}/apply`);
  expect(init).toEqual(expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(String(init?.body))).toMatchObject({
    appliedMode,
    document: {
      id: "doc_1",
      title: expect.any(String),
      contentJson: expect.objectContaining({ type: "doc" }),
      metadataJson: expect.any(Object),
      readiness: expect.any(String),
    },
    expectedRevision: expect.any(Number),
  });
}

describe("DocumentShell", () => {
  it("fails closed to the SQL projection when the collaboration session cannot start", async () => {
    vi.mocked(useCollaborationSession).mockReturnValue({
      session: null,
      snapshot: createCollaborationSnapshot({ status: "fatal" }),
    });

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocumentWithContent("doc_1", "Projected title", "Last durable body")}
        templates={[]}
      />,
    );

    await waitFor(() => {
      const projection = screen.getByRole("article", { name: "Collaboration read-only projection" });
      expect(projection).toHaveTextContent("Projected title");
      expect(projection).toHaveTextContent("Last durable body");
      expect(screen.queryByTestId("mock-editor-mode")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    });
  });

  it("keeps the SQL projection mounted until authentication and initial sync both complete", async () => {
    const session = createMockCollaborationSession();
    vi.mocked(useCollaborationSession).mockReturnValue({
      session,
      snapshot: createCollaborationSnapshot({
        permission: "write",
        status: "connecting",
      }),
    });

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocumentWithContent("doc_1", "Projected title", "Pre-sync projection")}
        templates={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("article", { name: "Collaboration read-only projection" })).toHaveTextContent(
        "Pre-sync projection",
      );
      expect(screen.queryByTestId("mock-editor-mode")).not.toBeInTheDocument();
    });
  });

  it("mounts the Yjs editor only after initial sync and disables legacy save paths", async () => {
    const session = createMockCollaborationSession();
    const collaboration = createCollaborationConfiguration();
    const document = createDocumentWithContent("doc_1", "Collaborative title", "Durable projection");
    vi.mocked(useCollaborationSession).mockReturnValue({
      session,
      snapshot: createCollaborationSnapshot(),
    });
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        collaboration={collaboration}
        document={document}
        templates={[]}
      />,
    );
    expect(screen.getByRole("article", { name: "Collaboration read-only projection" })).toBeInTheDocument();

    vi.mocked(useCollaborationSession).mockReturnValue({
      session,
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        permission: "write",
        status: "synced",
        transportSynced: true,
        writable: true,
      }),
    });
    await act(async () => {
      rerender(
        <DocumentShell
          aiRuns={[]}
          collaboration={collaboration}
          document={document}
          templates={[]}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-editor-mode")).toHaveTextContent("collaboration");
      expect(screen.getByTestId("mock-editor-document-bound")).toHaveTextContent("true");
      expect(screen.getByTestId("mock-editor-writable")).toHaveTextContent("true");
      expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "새 문서로 저장" })).not.toBeInTheDocument();
      expect(useCollaborationSession).toHaveBeenCalledWith(expect.objectContaining(collaboration));
    });
  });

  it("fails closed every SQL-backed body surface in collaboration mode", async () => {
    const user = userEvent.setup();
    vi.mocked(useCollaborationSession).mockReturnValue({
      session: createMockCollaborationSession(),
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        permission: "write",
        status: "synced",
        transportSynced: true,
        writable: true,
      }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocumentWithContent("doc_1", "Collaborative title", "Stale SQL projection")}
        proposals={[createProposal("proposal_stale", "pending", "Stale SQL projection")]}
        templates={[createTemplate("tpl_1", "SQL-backed review")]}
      />,
    );

    expect(screen.getByRole("button", { name: "Source 보기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "DOCX 내보내기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "검토" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI 채팅" })).toBeDisabled();
    expect(screen.queryByRole("navigation", { name: "개요" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stale SQL projection 제안으로 교체/ })).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    const palette = screen.getByRole("dialog", { name: "명령 팔레트" });
    expect(within(palette).queryByRole("option", { name: /문서 검토/ })).not.toBeInTheDocument();
    expect(within(palette).queryByRole("option", { name: /Source 보기/ })).not.toBeInTheDocument();
    expect(within(palette).queryByRole("option", { name: /DOCX 내보내기/ })).not.toBeInTheDocument();
    expect(within(palette).getByRole("option", { name: /문서에서 찾기/ })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the collaborative editor mounted and writable while post-sync changes are pending offline", async () => {
    const session = createMockCollaborationSession();
    vi.mocked(useCollaborationSession).mockReturnValue({
      session,
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        pendingLocalChecksums: ["a".repeat(64)],
        permission: "write",
        status: "offline_pending",
        writable: true,
      }),
    });

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocumentWithContent("doc_1", "Collaborative title", "Durable projection")}
        templates={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("article", { name: "Collaboration read-only projection" })).not.toBeInTheDocument();
      expect(screen.getByTestId("mock-editor-mode")).toHaveTextContent("collaboration");
      expect(screen.getByTestId("mock-editor-writable")).toHaveTextContent("true");
      expect(screen.getByText("offline_pending", { selector: "[role='status']" })).toBeInTheDocument();
    });
  });

  it("blocks unload, internal navigation, and new-document creation while collaboration updates await durability", () => {
    vi.mocked(useCollaborationSession).mockReturnValue({
      session: createMockCollaborationSession(),
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        pendingDurableAcknowledgementChecksums: ["a".repeat(64)],
        permission: "write",
        status: "storage_delayed",
        transportSynced: true,
        writable: true,
      }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocument("doc_1", "Pending collaboration")}
        templates={[]}
      />,
    );

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    expect(fireEvent.click(screen.getByRole("link", { name: "문서" }))).toBe(false);
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows navigation once every collaboration update is durably acknowledged", () => {
    vi.mocked(useCollaborationSession).mockReturnValue({
      session: createMockCollaborationSession(),
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        permission: "write",
        status: "synced",
        transportSynced: true,
        writable: true,
      }),
    });

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocument("doc_1", "Durable collaboration")}
        templates={[]}
      />,
    );

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "문서" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not schedule legacy autosave or expose conflict-copy actions in collaboration mode", async () => {
    vi.useFakeTimers();
    vi.mocked(useCollaborationSession).mockReturnValue({
      session: createMockCollaborationSession(),
      snapshot: createCollaborationSnapshot({
        hasCompletedInitialSync: true,
        permission: "write",
        status: "synced",
        transportSynced: true,
        writable: true,
      }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    render(
      <DocumentShell
        aiRuns={[]}
        collaboration={createCollaborationConfiguration()}
        document={createDocumentWithContent("doc_1", "Collaborative title", "Durable projection")}
        templates={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "새 문서로 저장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "로컬 내용 복사" })).not.toBeInTheDocument();
  });

  it("uses the localized generic user role instead of a personal placeholder", async () => {
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocument("doc_1", "Product identity")}
        templates={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("사용자", { exact: true })).toBeInTheDocument();
      expect(screen.queryByText("Kyunghoon K...")).not.toBeInTheDocument();
    });
  });

  it("renders plugin workspace tabs and their live document panel", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocument("doc_1", "Market Entry Memo")}
        pluginContributions={{
          workspacePanels: [
            {
              id: "plugin panel/한글",
              label: "Plugin workspace",
              render: ({ document }) => <p>Workspace document: {document.title}</p>,
            },
            { id: "", label: "Empty ID workspace", render: () => null },
            { id: "empty", label: "Literal empty workspace", render: () => null },
          ],
        }}
        templates={[]}
      />,
    );

    const pluginTab = screen.getByRole("tab", { name: "Plugin workspace" });
    expect(pluginTab.getAttribute("aria-controls")).not.toMatch(/[ ./한글]/);
    const pluginPanelIds = [
      pluginTab,
      screen.getByRole("tab", { name: "Empty ID workspace" }),
      screen.getByRole("tab", { name: "Literal empty workspace" }),
    ].map((tab) => tab.getAttribute("aria-controls"));
    expect(new Set(pluginPanelIds).size).toBe(3);
    await user.click(pluginTab);

    expect(screen.getByRole("tabpanel", { name: "Plugin workspace" })).toHaveTextContent(
      "Workspace document: Market Entry Memo",
    );
  });

  it("resolves plugin factories once in the shell and passes the full result to the editor", () => {
    const toolbarItems = vi.fn(() => [
      { id: "plugin.once-toolbar", label: "Once toolbar", run: () => undefined },
    ]);
    const workspacePanels = vi.fn(() => [
      { id: "plugin.once-workspace", label: "Once workspace", render: () => null },
    ]);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocument("doc_1", "Factory once")}
        plugins={[
          {
            id: "plugin.once",
            name: "Factory once plugin",
            toolbarItems,
            version: "1.0.0",
            workspacePanels,
          },
        ]}
        templates={[]}
      />,
    );

    expect(toolbarItems).toHaveBeenCalledTimes(1);
    expect(workspacePanels).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-resolved-plugin-contributions")).toHaveTextContent("plugin.once-toolbar");
    expect(screen.getByTestId("mock-resolved-plugin-contributions")).toHaveTextContent("starterKit");
    expect(screen.getByRole("tab", { name: "Once workspace" })).toBeInTheDocument();
  });

  it("renders three workspace regions", () => {
    render(
      <DocumentShell
        document={{
          id: "doc_1",
          title: "Market Entry Memo",
          contentJson: { type: "doc", content: [{ type: "paragraph" }] },
          plainText: "",
          revision: 0,
        }}
        templates={[]}
        aiRuns={[]}
      />,
    );

    expect(screen.getByText("개요")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Market Entry Memo");
    expect(screen.getByRole("button", { name: "LLM 설정" })).toBeInTheDocument();
    expect(screen.getByText("AI 검토")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "검토" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "대화" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "변경내역" })).toBeInTheDocument();
  });

  it("defaults to Korean and persists English editor language", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByRole("combobox", { name: "언어" })).toHaveValue("ko");
    expect(screen.getByText("AI 검토")).toBeInTheDocument();
    expect(screen.getByText("개요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "문서 검토" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "언어" }), "en");

    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(screen.getByText("AI Review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New document" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(window.localStorage.getItem("coredot-editor-language")).toBe("en");
  });

  it("renders required template validation messages in the selected language", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Audience" }));
    await user.click(screen.getByRole("button", { name: "Review document" }));

    expect(screen.getByText("Audience is required.")).toBeInTheDocument();
  });

  it("loads the saved editor language preference", () => {
    window.localStorage.setItem("coredot-editor-language", "en");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByText("AI Review")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
  });

  it("renders contract review template variables through the Korean language pack", () => {
    window.localStorage.setItem("coredot-editor-language", "ko");

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "body")}
        templates={[createContractTemplate()]}
      />,
    );

    expect(screen.getByLabelText("검토 관점")).toHaveValue("customer");
    expect(screen.getByLabelText("계약 유형")).toHaveValue("MSA");
    expect(screen.getByLabelText("위험 허용도")).toHaveValue("balanced");
  });

  it("keeps newer unsaved edits dirty when an older save resolves", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(titleInput);
    await user.type(titleInput, "Market Entry Memo v2");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.type(titleInput, " updated");

    await act(async () => {
      deferredSave.resolve(new Response(JSON.stringify({ document: createDocument("doc_1", "Market Entry Memo v2") })));
      await deferredSave.promise;
    });

    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
  });

  it("lets the newest overlapping save own an equal-revision conflict", async () => {
    const user = userEvent.setup();
    const firstSave = createDeferredResponse();
    const secondSave = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });

    await user.clear(titleInput);
    await user.type(titleInput, "Draft v1");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.type(titleInput, " + v2");
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      expectedRevision: 0,
      title: "Draft v1",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      expectedRevision: 0,
      title: "Draft v1 + v2",
    });

    await act(async () => {
      firstSave.resolve(new Response(JSON.stringify({
        document: { ...createDocument("doc_1", "Draft v1"), revision: 1 },
      })));
      await firstSave.promise;
    });
    await act(async () => {
      secondSave.resolve(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: { ...createDocument("doc_1", "Draft v1"), revision: 1 },
      }), { status: 409 }));
      await secondSave.promise;
    });

    expect(titleInput).toHaveValue("Draft v1 + v2");
    expect(screen.getByRole("alert")).toHaveTextContent("다른 곳에서 문서가 변경되었습니다.");
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장 실패");
  });

  it("shows a required Project Profile field error and clears it on retry and success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "invalid_project_profile",
        violation: { fieldId: "owner", ok: false, reason: "required" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: createDocument("doc_1", "Edited title"),
      })));
    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const title = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(title);
    await user.type(title, "Edited title");

    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert", { name: "프로젝트 프로필 확인 필요" }))
      .toHaveTextContent("일반 문서 프로필: 소유자 필드는 필수입니다.");

    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert", { name: "프로젝트 프로필 확인 필요" })).not.toBeInTheDocument();
      expect(screen.getByText("저장됨")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a Project Profile length cap and clears it when the draft is edited", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      reason: "invalid_project_profile",
      violation: { fieldId: "owner", ok: false, reason: "invalid_length" },
    }), { status: 400 }));
    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const title = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(title);
    await user.type(title, "Edited title");

    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert", { name: "프로젝트 프로필 확인 필요" }))
      .toHaveTextContent("일반 문서 프로필: 소유자 값은 최대 2000자까지 입력할 수 있습니다.");

    await user.type(title, " again");
    expect(screen.queryByRole("alert", { name: "프로젝트 프로필 확인 필요" })).not.toBeInTheDocument();
  });

  it("keeps an invalid-profile alert after rejecting an unrelated single proposal", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "invalid_project_profile",
        violation: { fieldId: "owner", ok: false, reason: "required" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        proposal: createProposal("proposal_1", "rejected"),
      })));
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Initial", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[]}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), " edited");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByRole("alert", { name: "프로젝트 프로필 확인 필요" });

    await user.click(screen.getByRole("button", { name: "growth was good 제안 거절" }));

    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장 실패");
  });

  it("keeps an invalid-profile alert after rejecting unrelated proposals in bulk", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "invalid_project_profile",
        violation: { fieldId: "owner", ok: false, reason: "required" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: createProposal("proposal_1", "rejected") })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: createProposal("proposal_2", "rejected", "owner is unclear") })));
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Initial", "growth was good")}
        proposals={[createProposal("proposal_1"), createProposal("proposal_2", "pending", "owner is unclear")]}
        templates={[]}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), " edited");
    await user.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByRole("alert", { name: "프로젝트 프로필 확인 필요" });

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 거절" }));

    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장 실패");
  });

  it("autosaves dirty drafts after a short debounce", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ document: createDocument("doc_1", "Market Entry Memo") })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/doc_1",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("fresh edited body"),
      }),
    );
    const [, saveInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(saveInit?.body))).toMatchObject({ expectedRevision: 0 });
  });

  it("advances the expected revision after each successful save", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: { ...createDocument("doc_1", "First save"), revision: 1 } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: { ...createDocument("doc_1", "Second save"), revision: 2 } })),
      );

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });

    fireEvent.change(titleInput, { target: { value: "First save" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());

    fireEvent.change(titleInput, { target: { value: "Second save" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 1 });
  });

  it("ignores an obsolete save conflict that arrives after proposal application", async () => {
    const user = userEvent.setup();
    const delayedSave = createDeferredResponse();
    const proposalDocument = {
      ...createDocumentWithContent("doc_1", "Edited before proposal", "revenue grew 8%"),
      metadataJson: {},
      readiness: "draft" as const,
      revision: 2,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(delayedSave.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          change: createChangeIdentity("change_1", 2),
          document: proposalDocument,
          proposal: { ...createProposal("proposal_1"), appliedMode: "replace", status: "accepted" },
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: { ...proposalDocument, title: "Edited after proposal", revision: 3 } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Initial", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );
    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });
    await user.clear(titleInput);
    await user.type(titleInput, "Edited before proposal");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    await waitFor(() => expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%"));

    await act(async () => {
      delayedSave.resolve(
        new Response(JSON.stringify({
          reason: "revision_conflict",
          document: proposalDocument,
        }), { status: 409 }),
      );
      await delayedSave.promise;
    });

    expect(titleInput).toHaveValue("Edited before proposal");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(titleInput);
    await user.type(titleInput, "Edited after proposal");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ expectedRevision: 2 });
  });

  it("ignores an entire stale same-document snapshot and later accepts the current revision", async () => {
    const user = userEvent.setup();
    const currentContent = createDocumentWithContent("doc_1", "Revision two", "Current body").contentJson;
    const staleContent = createDocumentWithContent("doc_1", "Stale revision", "Stale body").contentJson;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rejected for test" }), { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          document: {
            ...createDocumentWithContent("doc_1", "Saved current snapshot", "Current body"),
            metadataJson: { owner: "Current owner" },
            readiness: "ready",
            revision: 3,
          },
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          document: {
            ...createDocumentWithContent("doc_1", "After newer render", "Newer body"),
            metadataJson: { owner: "Newer owner" },
            readiness: "approved",
            revision: 5,
          },
        })),
      );
    const initial = {
      ...createDocumentWithContent("doc_1", "Revision two", "Current body"),
      metadataJson: { owner: "Current owner" },
      readiness: "ready" as const,
      revision: 2,
    };
    const proposals = [createProposal("proposal_1", "pending", "Current body")];
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={initial} proposals={proposals} templates={[]} />,
    );

    await user.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByRole("search", { name: "mock find bar" })).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={{
          ...initial,
          title: "Stale revision",
          contentJson: staleContent,
          metadataJson: { owner: "Stale owner" },
          readiness: "draft",
          revision: 1,
        }}
        proposals={proposals}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Revision two");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Current body");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("Stale body");
    expect(screen.getByRole("search", { name: "mock find bar" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Current body 제안으로 교체" }));
    const proposalPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(proposalPayload).toMatchObject({
      document: {
        id: "doc_1",
        title: "Revision two",
        contentJson: currentContent,
        metadataJson: { owner: "Current owner" },
        readiness: "ready",
      },
      expectedRevision: 2,
    });

    fireEvent.change(screen.getByRole("textbox", { name: "문서 제목" }), {
      target: { value: "Saved current snapshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      contentJson: currentContent,
      expectedRevision: 2,
      metadataJson: { owner: "Current owner" },
      readiness: "ready",
      title: "Saved current snapshot",
    });

    const acceptedRevision = {
      ...initial,
      title: "Accepted revision three",
      contentJson: createDocumentWithContent("doc_1", "Accepted revision three", "Accepted body").contentJson,
      metadataJson: { owner: "Accepted owner" },
      readiness: "approved" as const,
      revision: 3,
    };
    rerender(<DocumentShell aiRuns={[]} document={acceptedRevision} proposals={proposals} templates={[]} />);

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Accepted revision three");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Accepted body");

    const newerRevision = {
      ...acceptedRevision,
      title: "Newer revision four",
      contentJson: createDocumentWithContent("doc_1", "Newer revision four", "Newer body").contentJson,
      metadataJson: { owner: "Newer owner" },
      revision: 4,
    };
    rerender(<DocumentShell aiRuns={[]} document={newerRevision} proposals={proposals} templates={[]} />);

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Newer revision four");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Newer body");

    fireEvent.change(screen.getByRole("textbox", { name: "문서 제목" }), { target: { value: "After newer render" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      contentJson: newerRevision.contentJson,
      expectedRevision: 4,
      metadataJson: { owner: "Newer owner" },
      readiness: "approved",
    });
  });

  it("resets the revision token when navigating to a different document", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ document: { ...createDocument("doc_new", "New document edit"), revision: 1 } })),
    );
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={{ ...createDocument("doc_old", "Old document"), revision: 5 }} templates={[]} />,
    );

    rerender(
      <DocumentShell aiRuns={[]} document={{ ...createDocument("doc_new", "New document"), revision: 0 }} templates={[]} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "문서 제목" }), { target: { value: "New document edit" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/documents/doc_new");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
  });

  it("keeps a dirty draft on its base revision when a newer same-document snapshot arrives", async () => {
    const user = userEvent.setup();
    const baseDocument = createDocumentWithContent("doc_1", "Base title", "Base body");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rejected for test" }), { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Document revision conflict",
            reason: "revision_conflict",
            document: {
              ...createDocumentWithContent("doc_1", "Remote title", "Remote body"),
              revision: 1,
            },
          }),
          { status: 409 },
        ),
      );
    const proposals = [createProposal("proposal_1", "pending", "fresh edited body")];
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={baseDocument} proposals={proposals} templates={[]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));
    rerender(
      <DocumentShell
        aiRuns={[]}
        document={{
          ...createDocumentWithContent("doc_1", "Remote title", "Remote body"),
          revision: 1,
        }}
        proposals={proposals}
        templates={[]}
      />,
    );

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Base title");

    await user.click(screen.getByRole("button", { name: "fresh edited body 제안으로 교체" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      document: {
        id: "doc_1",
        title: "Base title",
        contentJson: createDocumentWithContent("doc_1", "Base title", "fresh edited body").contentJson,
        metadataJson: {},
        readiness: "draft",
      },
      expectedRevision: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByText("저장 실패")).toBeInTheDocument());

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      contentJson: createDocumentWithContent("doc_1", "Base title", "fresh edited body").contentJson,
      expectedRevision: 0,
      title: "Base title",
    });
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
  });

  it("does not advance the base revision from an incoming snapshot while saving", async () => {
    const firstSave = createDeferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }));
    const initial = createDocumentWithContent("doc_1", "Base title", "Base body");
    const { rerender } = render(<DocumentShell aiRuns={[]} document={initial} templates={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    rerender(
      <DocumentShell
        aiRuns={[]}
        document={{
          ...createDocumentWithContent("doc_1", "Remote title", "Remote body"),
          revision: 1,
        }}
        templates={[]}
      />,
    );

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    await act(async () => {
      firstSave.resolve(new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }));
      await firstSave.promise;
    });
    expect(screen.getByText("저장 실패")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
  });

  it("does not advance the base revision from an incoming snapshot after a failed save", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }));
    const initial = createDocumentWithContent("doc_1", "Base title", "Base body");
    const { rerender } = render(<DocumentShell aiRuns={[]} document={initial} templates={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByText("저장 실패")).toBeInTheDocument());

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={{
          ...createDocumentWithContent("doc_1", "Remote title", "Remote body"),
          revision: 1,
        }}
        templates={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Base title");
  });

  it("preserves the local draft and does not retry automatically after a revision conflict", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Document revision conflict",
          reason: "revision_conflict",
          document: {
            ...createDocument("doc_1", "Server version"),
            metadataJson: {},
            readiness: "draft",
            revision: 1,
          },
        }),
        { status: 409 },
      ),
    );

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "문서 제목" });
    fireEvent.change(titleInput, { target: { value: "Local unsaved version" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await act(async () => Promise.resolve());

    expect(titleInput).toHaveValue("Local unsaved version");
    expect(screen.getByText("저장 실패")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("다른 곳에서 문서가 변경되었습니다.");
    expect(screen.getByRole("button", { name: "서버 버전 불러오기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로컬 내용 복사" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 문서로 저장" })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "서버 버전 불러오기" }));
    expect(titleInput).toHaveValue("Server version");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(titleInput, { target: { value: "Edit from server version" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 1 });
  });

  it("loads persisted history and atomically adopts a durable server undo", async () => {
    const user = userEvent.setup();
    const proposal = { ...createProposal("proposal_1", "accepted"), appliedMode: "replace" as const };
    const createdAt = "2026-07-13T01:00:00.000Z";
    const change = {
      id: "change_1",
      documentId: "doc_1",
      kind: "single" as const,
      batchId: null,
      afterRevision: 1,
      createdAt,
      undoneAt: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        changes: [{
          ...change,
          proposals: [{
            id: proposal.id,
            targetText: proposal.targetText,
            replacementText: proposal.replacementText,
            appliedMode: "replace",
            ordinal: 0,
          }],
        }],
        nextCursor: null,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        change: { ...change, undoneAt: "2026-07-13T01:01:00.000Z" },
        document: {
          ...createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good"),
          metadataJson: {},
          readiness: "draft",
          revision: 2,
        },
        proposals: [{ ...proposal, appliedMode: null, status: "pending" }],
      })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={{ ...createDocumentWithContent("doc_1", "Market Entry Memo", "revenue grew 8%"), revision: 1 }}
        proposals={[]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await user.click(await screen.findByRole("button", { name: "growth was good 변경 되돌리기" }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/document-changes?documentId=doc_1&limit=20",
      { method: "GET" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/document-changes/change_1/undo", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 }),
    }));
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
    await user.click(screen.getByRole("tab", { name: "검토" }));
    expect(screen.getByText("대기 중")).toBeInTheDocument();
  });

  it("merges paginated change history without duplicates and stops at the end", async () => {
    const user = userEvent.setup();
    const first = {
      ...createChangeIdentity("change_1", 2),
      proposals: [{
        id: "proposal_1",
        targetText: "First target",
        replacementText: "First replacement",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    const second = {
      ...createChangeIdentity("change_2", 1),
      proposals: [{
        id: "proposal_2",
        targetText: "Second target",
        replacementText: "Second replacement",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: [first], nextCursor: "older" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: [first, second], nextCursor: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={{ ...createDocument("doc_1", "History"), revision: 2 }}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await screen.findByText("First target");
    await user.click(screen.getByRole("button", { name: "더 불러오기" }));
    await screen.findByText("Second target");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/document-changes?documentId=doc_1&limit=20&cursor=older",
      { method: "GET" },
    );
    expect(screen.getAllByText("First target")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "더 불러오기" })).not.toBeInTheDocument();
  });

  it("appends proposal pages without overwriting or moving current proposal state", async () => {
    const user = userEvent.setup();
    const current = createProposal("proposal_1", "accepted", "current exact target");
    const staleDuplicate = createProposal("proposal_1", "pending", "stale duplicate target");
    const older = createProposal("proposal_2", "pending", "older target");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      proposals: [staleDuplicate, older].map((proposal) => ({
        ...proposal,
        createdAt: "2026-01-01T00:00:00.000Z",
        isTruncated: false,
      })),
      nextCursor: null,
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current exact target")}
        proposals={[current]}
        proposalsNextCursor="older"
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));
    expect((await screen.findAllByText("older target")).length).toBeGreaterThan(0);

    expect(fetchMock).toHaveBeenCalledWith("/api/documents/doc_1/proposals?cursor=older&limit=20");
    expect(screen.getAllByText("current exact target").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale duplicate target")).not.toBeInTheDocument();
    expect(screen.getByText("수락됨")).toBeInTheDocument();
  });

  it("withholds all-pending actions until the final proposal page loads successfully", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      proposals: [{
        ...createProposal("proposal_older", "pending", "older target"),
        createdAt: "2026-01-01T00:00:00.000Z",
        isTruncated: false,
      }],
      nextCursor: null,
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current target older target")}
        proposals={[createProposal("proposal_current", "pending", "current target")]}
        proposalsNextCursor="older"
        templates={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: "대기 중인 모든 제안 수락" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "대기 중인 모든 제안 거절" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));

    expect(await screen.findByRole("button", { name: "대기 중인 모든 제안 수락" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "대기 중인 모든 제안 거절" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the run cursor and current history when a run page has an invalid date", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      runs: [{
        ...createAiRun("run_invalid"),
        createdAt: "not-a-date",
      }],
      nextCursor: null,
    })));

    render(
      <DocumentShell
        aiRuns={[createAiRun("run_current")]}
        aiRunsNextCursor="older-runs"
        document={createDocument("doc_1", "Run history")}
        templates={[]}
      />,
    );
    const currentRunLabelCount = screen.getAllByText("문서 검토").length;

    await user.click(screen.getByRole("button", { name: "이전 실행 더 보기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("검토에 실패했습니다. 다시 시도하세요.");
    expect(screen.getByRole("button", { name: "이전 실행 더 보기" })).toBeInTheDocument();
    expect(screen.getAllByText("문서 검토")).toHaveLength(currentRunLabelCount);
  });

  it("keeps the proposal cursor and loaded proposals when a proposal page is malformed", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      proposals: [{
        ...createProposal("proposal_invalid", "pending", "invalid proposal target"),
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "unknown",
      }],
      nextCursor: null,
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current target")}
        proposals={[createProposal("proposal_current", "pending", "current target")]}
        proposalsNextCursor="older-proposals"
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("검토에 실패했습니다. 다시 시도하세요.");
    expect(screen.getByRole("button", { name: "이전 제안 더 보기" })).toBeInTheDocument();
    expect(screen.queryByText("invalid proposal target")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "대기 중인 모든 제안 수락" })).not.toBeInTheDocument();
  });

  it("rejects an empty proposal page cursor without appending data or losing the current cursor", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      proposals: [{
        ...createProposal("proposal_empty_cursor", "pending", "empty cursor target"),
        createdAt: "2026-01-01T00:00:00.000Z",
        isTruncated: false,
      }],
      nextCursor: "",
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current target")}
        proposals={[createProposal("proposal_current", "pending", "current target")]}
        proposalsNextCursor="older-proposals"
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("검토에 실패했습니다. 다시 시도하세요.");
    expect(screen.queryByText("empty cursor target")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 제안 더 보기" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not focus a proposal when lazy detail returns a different proposal id", async () => {
    const user = userEvent.setup();
    const preview = {
      ...createProposal("proposal_preview", "pending", "current target"),
      isTruncated: true,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      proposal: { ...preview, id: "proposal_other", isTruncated: undefined },
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current target")}
        proposals={[preview]}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "전체 제안 보기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
    expect(screen.getByTestId("mock-inline-suggestions")).toHaveTextContent('"active":false');
    expect(screen.getByTestId("mock-inline-suggestions")).not.toHaveTextContent('"active":true');
  });

  it("does not apply a truncated proposal when lazy detail returns a different proposal id", async () => {
    const user = userEvent.setup();
    const preview = {
      ...createProposal("proposal_preview", "pending", "current target"),
      isTruncated: true,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      proposal: { ...createProposal("proposal_other", "pending", "current target") },
    })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Proposal history", "current target")}
        proposals={[preview]}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "current target 제안으로 교체" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/proposals/proposal_preview");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("current target");
    expect(await screen.findByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("isolates delayed review, run page, proposal page, and proposal detail responses after document navigation", async () => {
    const user = userEvent.setup();
    const delayedReview = createDeferredResponse();
    const delayedRuns = createDeferredResponse();
    const delayedProposals = createDeferredResponse();
    const delayedDetail = createDeferredResponse();
    const delayedReviewB = createDeferredResponse();
    const delayedRunsB = createDeferredResponse();
    const delayedProposalsB = createDeferredResponse();
    const delayedDetailB = createDeferredResponse();
    let reviewCallCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/ai/review") {
        reviewCallCount += 1;
        return reviewCallCount === 1 ? delayedReview.promise : delayedReviewB.promise;
      }
      if (url.includes("/api/documents/doc_1/ai-runs?")) return delayedRuns.promise;
      if (url.includes("/api/documents/doc_1/proposals?")) return delayedProposals.promise;
      if (url === "/api/proposals/proposal_preview") return delayedDetail.promise;
      if (url.includes("/api/documents/doc_2/ai-runs?")) return delayedRunsB.promise;
      if (url.includes("/api/documents/doc_2/proposals?")) return delayedProposalsB.promise;
      if (url === "/api/proposals/proposal_b") return delayedDetailB.promise;
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    const preview = { ...createProposal("proposal_preview", "pending", "A preview target"), isTruncated: true };
    const { rerender } = render(
      <DocumentShell
        aiRuns={[createAiRun("run_a")]}
        aiRunsNextCursor="older-runs-a"
        document={createDocumentWithContent("doc_1", "Document A", "A preview target")}
        proposals={[preview]}
        proposalsNextCursor="older-proposals-a"
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "이전 실행 더 보기" }));
    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));
    await user.click(screen.getByRole("button", { name: "전체 제안 보기" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_b")]}
        aiRunsNextCursor="older-runs-b"
        document={createDocumentWithContent("doc_2", "Document B", "B current target")}
        proposals={[{ ...createProposal("proposal_b", "pending", "B current target"), isTruncated: true }]}
        proposalsNextCursor="older-proposals-b"
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Document B");

    await user.click(screen.getByRole("button", { name: "이전 실행 더 보기" }));
    await user.click(screen.getByRole("button", { name: "이전 제안 더 보기" }));
    await user.click(screen.getByRole("button", { name: "전체 제안 보기" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));

    await act(async () => {
      delayedReview.resolve(new Response(JSON.stringify({
        proposals: [createProposal("proposal_stale_review", "pending", "STALE REVIEW TARGET")],
        review: { findings: [], summary: "STALE REVIEW SUMMARY" },
        run: {
          id: "run_stale_review",
          commandType: "stale_review_command",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      })));
      await delayedReview.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("STALE REVIEW TARGET")).not.toBeInTheDocument();
    expect(screen.queryByText("STALE REVIEW SUMMARY")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검토 중..." })).toBeDisabled();

    await act(async () => {
      delayedReviewB.resolve(new Response(JSON.stringify({
        proposals: [createProposal("proposal_b", "pending", "B current target")],
        review: { findings: [], summary: "B done" },
      })));
      await delayedReviewB.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("B done")).toBeInTheDocument();

    await act(async () => {
      delayedRuns.resolve(new Response(JSON.stringify({
        nextCursor: null,
        runs: [{
          id: "run_stale_page",
          commandType: "stale_page_command",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
      })));
      await delayedRuns.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("stale page command")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "불러오는 중..." })).toHaveLength(2);

    await act(async () => {
      delayedProposals.resolve(new Response(JSON.stringify({
        nextCursor: null,
        proposals: [createProposal("proposal_stale_page", "pending", "STALE PAGE TARGET")],
      })));
      await delayedProposals.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("STALE PAGE TARGET")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "불러오는 중..." })).toHaveLength(2);

    await act(async () => {
      delayedDetail.resolve(new Response(JSON.stringify({ error: "expired" }), { status: 404 }));
      await delayedDetail.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("제안 상태를 업데이트하지 못했습니다.")).not.toBeInTheDocument();

    await act(async () => {
      delayedRunsB.resolve(new Response(JSON.stringify({ nextCursor: null, runs: [] })));
      delayedProposalsB.resolve(new Response(JSON.stringify({ nextCursor: null, proposals: [] })));
      delayedDetailB.resolve(new Response(JSON.stringify({
        proposal: createProposal("proposal_b", "pending", "B current target"),
      })));
      await Promise.all([
        delayedRunsB.promise,
        delayedProposalsB.promise,
        delayedDetailB.promise,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getAllByText("B current target").length).toBeGreaterThan(0);
  });

  it("ignores a delayed review continuation after unmount without React lifecycle warnings", async () => {
    const user = userEvent.setup();
    const delayedReview = createDeferredResponse();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/ai/review") return delayedReview.promise;
      return Promise.reject(new Error(`Unexpected request: ${String(input)}`));
    });
    const { unmount } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Document A", "A body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/ai/review", expect.anything()));

    unmount();
    await act(async () => {
      delayedReview.resolve(new Response(JSON.stringify({
        proposals: [createProposal("late_proposal", "pending", "LATE")],
        review: { findings: [], summary: "LATE" },
      })));
      await delayedReview.promise;
      await Promise.resolve();
    });

    const lifecycleWarnings = consoleError.mock.calls
      .flatMap((call) => call.map(String))
      .filter((message) => /not wrapped in act|unmounted component/i.test(message));
    expect(lifecycleWarnings).toEqual([]);
  });

  it("keeps the change-history cursor available after a load-more error", async () => {
    const user = userEvent.setup();
    const first = {
      ...createChangeIdentity("change_1", 2),
      proposals: [{
        id: "proposal_1",
        targetText: "First target",
        replacementText: "First replacement",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    const second = {
      ...createChangeIdentity("change_2", 1),
      proposals: [{
        id: "proposal_2",
        targetText: "Second target",
        replacementText: "Second replacement",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: [first], nextCursor: "older" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "temporary" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: [second], nextCursor: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={{ ...createDocument("doc_1", "History"), revision: 2 }}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await user.click(await screen.findByRole("button", { name: "더 불러오기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("변경내역을 불러오지 못했습니다. 다시 시도해 주세요.");
    expect(screen.getByText("First target")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "더 불러오기" }));
    await screen.findByText("Second target");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/document-changes?documentId=doc_1&limit=20&cursor=older");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/document-changes?documentId=doc_1&limit=20&cursor=older");
  });

  it("routes an undo revision conflict into draft recovery without overwriting local content", async () => {
    const user = userEvent.setup();
    const change = {
      ...createChangeIdentity("change_1", 0),
      proposals: [{
        id: "proposal_1",
        targetText: "Original target",
        replacementText: "Replacement",
        appliedMode: "replace",
        ordinal: 0,
      }],
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: [change], nextCursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: { ...createDocumentWithContent("doc_1", "Server title", "Server body"), revision: 1 },
      }), { status: 409 }));

    render(<DocumentShell aiRuns={[]} document={createDocumentWithContent("doc_1", "Local title", "Local body")} templates={[]} />);
    await user.click(screen.getByRole("tab", { name: "변경내역" }));
    await user.click(await screen.findByRole("button", { name: "Original target 변경 되돌리기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("다른 곳에서 문서가 변경되었습니다.");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local title");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Local body");
  });

  it("offers English copy and atomic save-as-new actions without overwriting a conflicted draft", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          metadataJson: {},
          readiness: "draft",
          revision: 2,
        },
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "test failure" }), { status: 500 }));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    await user.clear(screen.getByRole("textbox", { name: "Document title" }));
    await user.type(screen.getByRole("textbox", { name: "Document title" }), "Local recovery copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This document changed somewhere else.");
    await user.click(screen.getByRole("button", { name: "Copy local content" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Local recovery copy"));
    await user.click(screen.getByRole("button", { name: "Save as new document" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/documents");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      title: "Local recovery copy",
      metadataJson: {},
      readiness: "draft",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save the local draft as a new document.");
  });

  it("bypasses the unload warning after an atomic save-as-new succeeds", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          metadataJson: {},
          readiness: "draft",
          revision: 1,
        },
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: {
          ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
          metadataJson: {},
          readiness: "draft",
          revision: 0,
        },
        replayed: false,
      }), { status: 201 }));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Local copy");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "새 문서로 저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps edits made during save-as-new and retries them into the created copy", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const createCopy = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          revision: 1,
        },
      }), { status: 409 }))
      .mockReturnValueOnce(createCopy.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: {
          ...createDocumentWithContent("doc_copy", "Latest local copy", "Local body"),
          revision: 1,
        },
      })));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Local copy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await user.clear(titleInput);
    await user.type(titleInput, "Latest local copy");
    await act(async () => {
      createCopy.resolve(new Response(JSON.stringify({
        document: {
          ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
          revision: 0,
        },
        replayed: false,
      }), { status: 201 }));
      await createCopy.promise;
    });

    expect(screen.getByText(
      "The local draft changed while the copy was being saved. Review it, then save again.",
    )).toHaveAttribute("role", "status");
    const beforeRetry = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeRetry);
    expect(beforeRetry.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/documents/doc_copy");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      expectedRevision: 0,
      title: "Latest local copy",
    });
    const afterRetry = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterRetry);
    expect(afterRetry.defaultPrevented).toBe(false);
  });

  it("replays a lost recovery-create response with the same key before saving the latest draft", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const originalCopy = {
      ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
      revision: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          revision: 1,
        },
      }), { status: 409 }))
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: originalCopy, replayed: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: { ...originalCopy, title: "Latest local copy", revision: 1 },
      })));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Local copy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    expect(await screen.findByText("Could not save the local draft as a new document.")).toBeInTheDocument();
    await user.clear(titleInput);
    await user.type(titleInput, "Latest local copy");
    await user.click(screen.getByRole("button", { name: "Save as new document" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const firstCreationHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    const replayHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(firstCreationHeaders["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(replayHeaders["Idempotency-Key"]).toBe(firstCreationHeaders["Idempotency-Key"]);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/documents/doc_copy");
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      expectedRevision: 0,
      title: "Latest local copy",
    });
    const afterRecovery = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterRecovery);
    expect(afterRecovery.defaultPrevented).toBe(false);
  });

  it("does not overwrite a recovery copy after its own revision conflict", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const createCopy = createDeferredResponse();
    const originalCopy = {
      ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
      revision: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          revision: 1,
        },
      }), { status: 409 }))
      .mockReturnValueOnce(createCopy.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: { ...originalCopy, title: "Other writer copy", revision: 1 },
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: { ...originalCopy, id: "doc_fresh", title: "Latest local copy" },
        replayed: false,
      }), { status: 201 }));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Local copy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await user.clear(titleInput);
    await user.type(titleInput, "Latest local copy");
    await act(async () => {
      createCopy.resolve(new Response(JSON.stringify({ document: originalCopy, replayed: false }), { status: 201 }));
      await createCopy.promise;
    });
    const initialCreationHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    expect(await screen.findByText(
      "The recovery copy changed somewhere else. Nothing was overwritten. Try again to create a separate copy.",
    )).toHaveAttribute("role", "status");
    expect(titleInput).toHaveValue("Latest local copy");
    const afterCopyConflict = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterCopyConflict);
    expect(afterCopyConflict.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/documents");
    const freshCreationHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(freshCreationHeaders["Idempotency-Key"]).not.toBe(initialCreationHeaders["Idempotency-Key"]);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({ title: "Latest local copy" });
  });

  it("abandons a missing recovery copy and creates a fresh copy on the next retry", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const createCopy = createDeferredResponse();
    const originalCopy = {
      ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
      revision: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          revision: 1,
        },
      }), { status: 409 }))
      .mockReturnValueOnce(createCopy.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Document not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: { ...originalCopy, id: "doc_fresh", title: "Latest local copy" },
        replayed: false,
      }), { status: 201 }));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Local copy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await user.clear(titleInput);
    await user.type(titleInput, "Latest local copy");
    await act(async () => {
      createCopy.resolve(new Response(JSON.stringify({ document: originalCopy, replayed: false }), { status: 201 }));
      await createCopy.promise;
    });
    const initialCreationHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    expect(await screen.findByText(
      "The recovery copy changed somewhere else. Nothing was overwritten. Try again to create a separate copy.",
    )).toHaveAttribute("role", "status");
    expect(titleInput).toHaveValue("Latest local copy");
    const afterMissingCopy = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterMissingCopy);
    expect(afterMissingCopy.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/documents");
    const freshCreationHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(freshCreationHeaders["Idempotency-Key"]).not.toBe(initialCreationHeaders["Idempotency-Key"]);
  });

  it("keeps an ambiguous missing response targeted at the same recovery copy", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("coredot-editor-language", "en");
    const createCopy = createDeferredResponse();
    const originalCopy = {
      ...createDocumentWithContent("doc_copy", "Local copy", "Local body"),
      revision: 0,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reason: "revision_conflict",
        document: {
          ...createDocumentWithContent("doc_1", "Server version", "Server body"),
          revision: 1,
        },
      }), { status: 409 }))
      .mockReturnValueOnce(createCopy.promise)
      .mockRejectedValueOnce(new Error("recovery PUT response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        document: { ...originalCopy, title: "Latest local copy", revision: 1 },
      })));

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Initial")} templates={[]} />);
    const titleInput = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Local copy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await user.clear(titleInput);
    await user.type(titleInput, "Latest local copy");
    await act(async () => {
      createCopy.resolve(new Response(JSON.stringify({ document: originalCopy, replayed: false }), { status: 201 }));
      await createCopy.promise;
    });

    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    expect(await screen.findByText("Could not save the local draft as a new document.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save as new document" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/documents/doc_copy");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/documents/doc_copy");
  });

  it("blocks internal sidebar navigation while local edits are unsaved", () => {
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    expect(screen.getByText("저장되지 않음")).toBeInTheDocument();
    expect(fireEvent.click(screen.getByRole("link", { name: "문서" }))).toBe(false);
  });

  it("warns before unload while an autosave is still in flight", async () => {
    vi.useFakeTimers();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("exports the current unsaved draft as DOCX", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "paragraph", outcome: "preserved" }],
          requiresAcknowledgement: false,
        },
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }));
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrl = vi.fn(() => "blob:docx");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/documents/doc_1/export/preview",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("fresh edited body"),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/documents/doc_1/export",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("fresh edited body"),
      }),
    );
    expect(screen.queryByRole("dialog", { name: "DOCX 형식 손실 확인" })).not.toBeInTheDocument();
    expect(createObjectUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:docx");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("previews lossy export and waits for explicit acknowledgement before downloading", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "table", outcome: "approximated" }],
          requiresAcknowledgement: true,
        },
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }));
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrl = vi.fn(() => "blob:lossy-docx");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));

    expect(await screen.findByRole("dialog", { name: "DOCX 형식 손실 확인" })).toBeInTheDocument();
    expect(screen.getByText(/표.*유사하게 변환됨/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "손실을 이해하고 내보내기" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/documents/doc_1/export",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"acknowledgedLoss":true'),
      }),
    );
    expect(createObjectUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:lossy-docx");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
  });

  it("traps export review focus, closes on Escape, and restores the export trigger", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      fidelity: {
        items: [{ feature: "table", outcome: "approximated" }],
        requiresAcknowledgement: true,
      },
    }), { headers: { "Content-Type": "application/json" } }));
    const { container } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "DOCX 내보내기" });

    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "DOCX 형식 손실 확인" })).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "취소" });
    const confirm = screen.getByRole("button", { name: "손실을 이해하고 내보내기" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");

    const lateBackgroundSibling = document.createElement("aside");
    document.body.append(lateBackgroundSibling);
    await waitFor(() => expect(lateBackgroundSibling).toHaveAttribute("inert"));

    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    expect(cancel).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(1);

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "DOCX 형식 손실 확인" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute("inert");
    expect(lateBackgroundSibling).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("");
    lateBackgroundSibling.remove();
  });

  it("keeps the export review open while the acknowledged artifact request is in flight", async () => {
    const user = userEvent.setup();
    const deferredArtifact = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "table", outcome: "approximated" }],
          requiresAcknowledgement: true,
        },
      }), { headers: { "Content-Type": "application/json" } }))
      .mockReturnValueOnce(deferredArtifact.promise);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pending-artifact-docx");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));
    const dialog = await screen.findByRole("dialog", { name: "DOCX 형식 손실 확인" });
    await user.click(screen.getByRole("button", { name: "손실을 이해하고 내보내기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "DOCX 형식 손실 확인" })).toBeInTheDocument();
    deferredArtifact.resolve(new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "DOCX 형식 손실 확인" })).not.toBeInTheDocument();
    });
  });

  it("announces a preview failure outside the closed AI workspace and retries the full export", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "paragraph", outcome: "preserved" }],
          requiresAcknowledgement: false,
        },
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried-preview-docx");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "검토", pressed: true }));
    expect(screen.getByRole("button", { name: "검토", pressed: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));

    const alert = await screen.findByRole("alert", { name: "DOCX 내보내기 중단" });
    expect(within(alert).getByText("DOCX 내보내기에 실패했습니다. 다시 시도하세요.")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "DOCX 내보내기 다시 시도" }));

    await waitFor(() => expect(screen.queryByRole("alert", { name: "DOCX 내보내기 중단" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/documents/doc_1/export/preview",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/documents/doc_1/export",
      expect.objectContaining({ method: "POST" }),
    );
    expect(click).toHaveBeenCalled();
  });

  it("announces an artifact failure outside the closed AI workspace and retries the full export", async () => {
    const user = userEvent.setup();
    const preservedPreview = () => new Response(JSON.stringify({
      fidelity: {
        items: [{ feature: "paragraph", outcome: "preserved" }],
        requiresAcknowledgement: false,
      },
    }), { headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(preservedPreview())
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(preservedPreview())
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried-artifact-docx");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "검토", pressed: true }));
    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));

    const alert = await screen.findByRole("alert", { name: "DOCX 내보내기 중단" });
    await user.click(within(alert).getByRole("button", { name: "DOCX 내보내기 다시 시도" }));

    await waitFor(() => expect(screen.queryByRole("alert", { name: "DOCX 내보내기 중단" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(click).toHaveBeenCalled();
  });

  it("aborts an active DOCX export on unmount and never downloads a late artifact", async () => {
    const user = userEvent.setup();
    const deferredArtifact = createDeferredResponse();
    let artifactSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "paragraph", outcome: "preserved" }],
          requiresAcknowledgement: false,
        },
      })))
      .mockImplementationOnce((_input, init) => {
        artifactSignal = init?.signal ?? undefined;
        return deferredArtifact.promise;
      });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late-artifact-docx");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { unmount } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "DOCX 내보내기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    unmount();

    expect(artifactSignal?.aborted).toBe(true);
    deferredArtifact.resolve(new Response(new Uint8Array([1, 2, 3])));
    await deferredArtifact.promise;
    expect(click).not.toHaveBeenCalled();
  });

  it("times out stalled DOCX artifact body consumption and exposes full-export retry", async () => {
    vi.useFakeTimers();
    const stalledResponse = new Response(new Uint8Array([1]));
    const stalledBlob = vi.spyOn(stalledResponse, "blob").mockImplementation(
      () => new Promise<Blob>(() => undefined),
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fidelity: {
          items: [{ feature: "paragraph", outcome: "preserved" }],
          requiresAcknowledgement: false,
        },
      })))
      .mockResolvedValueOnce(stalledResponse);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "DOCX 내보내기" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stalledBlob).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(DOCUMENT_INTERCHANGE_CLIENT_TIMEOUT_MS));

    const alert = screen.getByRole("alert", { name: "DOCX 내보내기 중단" });
    expect(within(alert).getByRole("button", { name: "DOCX 내보내기 다시 시도" })).toBeEnabled();
    expect(click).not.toHaveBeenCalled();
  });

  it("resets the title textbox when rerendered with a different document", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited title");

    rerender(<DocumentShell aiRuns={[]} document={createDocument("doc_2", "Board Brief")} templates={[]} />);

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Board Brief");
  });

  it("accepts same-document prop updates while saved", () => {
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo Updated", "Updated body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Market Entry Memo Updated");
  });

  it("preserves local dirty edits during same-document prop updates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local dirty title");
  });

  it("preserves local edits during same-document prop updates while saving", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Saving local title");
    await user.click(screen.getByRole("button", { name: "저장" }));

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Saving local title");
  });

  it("preserves local edits during same-document prop updates after save failure", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        templates={[]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Failed local title");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await act(async () => {
      deferredSave.reject(new Error("network"));
      await deferredSave.promise.catch(() => undefined);
    });

    expect(screen.getByText("저장 실패")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Server title", "Server body")}
        templates={[]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Failed local title");
  });

  it("reflects the last selection command in the AI panel", async () => {
    const user = userEvent.setup();

    render(<DocumentShell aiRuns={[]} document={createDocument("doc_1", "Market Entry Memo")} templates={[]} />);

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    expect(screen.getByText("마지막 선택 명령: 명확하게 개선")).toBeInTheDocument();
    expect(screen.getByText("선택됨: selected text")).toBeInTheDocument();
  });

  it("keeps the AI context inspector pinned to the document snapshot captured when a selection command starts", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "original body")}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "컨텍스트 복사" }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copiedSnapshot = JSON.parse(writeText.mock.calls.at(-1)?.[0] ?? "{}") as {
      document?: { text?: string };
    };
    expect(copiedSnapshot.document?.text).toBe("original body");
  });

  it("runs selection rewrite commands and adds the returned proposal", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/rewrite",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"selectedText":"selected text"'),
        }),
      );
    });
    const rewriteRequest = fetchMock.mock.calls.find(([url]) => url === "/api/ai/rewrite")?.[1] as RequestInit;
    expect(new Headers(rewriteRequest.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(screen.getAllByText("selected text").length).toBeGreaterThan(0);
    expect(screen.getAllByText("revenue grew 8%").length).toBeGreaterThan(0);
  });

  it("reuses the idempotency key when the user retries a selection rewrite after a 5xx response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).toBe(keys[0]);
  });

  it("reuses the idempotency key when the user retries after the rewrite response is lost", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it("uses a fresh idempotency key when the serialized rewrite body changes after a failed attempt", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(requests[0].body).not.toBe(requests[1].body);
    expect(new Headers(requests[1].headers).get("Idempotency-Key")).not.toBe(
      new Headers(requests[0].headers).get("Idempotency-Key"),
    );
  });

  it.each([408, 409, 429, 503])(
    "reuses the idempotency key when a selection rewrite returns retryable status %i",
    async (status) => {
      const user = userEvent.setup();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

      render(
        <DocumentShell
          aiRuns={[]}
          document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
          templates={[createTemplate("tpl_1", "Rewrite template")]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Mock selection command" }));
      await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
      await user.click(screen.getByRole("button", { name: "Mock selection command" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      const keys = fetchMock.mock.calls.map(([, init]) =>
        new Headers((init as RequestInit).headers).get("Idempotency-Key"),
      );
      expect(keys[1]).toBe(keys[0]);
    },
  );

  it("clears a retained idempotency key after a successful selection rewrite retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 500 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ run: createAiRun("run_success"), proposal: null })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(screen.queryByTestId("mock-selection-command-running")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("clears a retained idempotency key after a definitive selection rewrite 4xx", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 500 }))
      .mockResolvedValueOnce(new Response("{", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("clears a retained rewrite key after a non-allowlisted redirect response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 500 }))
      .mockResolvedValueOnce(new Response("{", { status: 302 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("retains a rewrite key when a 200 response body cannot be consumed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: createAiRun("run_retry"), proposal: null })));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByText("선택 영역 처리에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it("passes selected document references to selection rewrite requests", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock referenced command" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/ai/rewrite", expect.anything());
    });
    const requestInit = fetchMock.mock.calls.find(([url]) => url === "/api/ai/rewrite")?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));

    expect(body.references).toEqual({
      documents: [{ documentId: "doc_ref", titleSnapshot: "Revenue Memo" }],
    });
  });

  it("records AI command conversation in the right chat tab", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("tab", { name: "대화" }));
    const chatPanel = screen.getByRole("tabpanel", { name: "대화" });

    expect(within(chatPanel).getByText("사용자")).toBeInTheDocument();
    expect(within(chatPanel).getAllByText("명확하게 개선").length).toBeGreaterThan(0);
    expect(within(chatPanel).getByText("AI")).toBeInTheDocument();
    expect(within(chatPanel).getByText("revenue grew 8%")).toBeInTheDocument();
  });

  it("opens a command palette and runs workspace commands", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "source body")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.keyboard("{Meta>}k{/Meta}");

    const palette = screen.getByRole("dialog", { name: "명령 팔레트" });
    expect(within(palette).getByRole("textbox", { name: "명령 검색" })).toBeInTheDocument();
    expect(within(palette).getByRole("option", { name: /문서 검토/ })).toBeInTheDocument();

    await user.type(within(palette).getByRole("textbox", { name: "명령 검색" }), "source");
    await user.click(within(palette).getByRole("option", { name: /Source 보기/ }));

    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "문서 Source" })).toHaveTextContent("source body");
  });

  it("opens document find through the shell shortcut layer", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "source body")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.keyboard("{Meta>}f{/Meta}");

    expect(screen.getByRole("search", { name: "mock find bar" })).toBeInTheDocument();
  });

  it("does not dispatch document shortcuts behind an active modal surface", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      secrets: { coredotConfigured: true, openaiConfigured: false },
      settings: {
        aiBaseUrl: null,
        aiMaxCompletionTokens: null,
        aiModel: "gpt-5-mini",
        aiProvider: "coredot",
        aiReasoningEffort: null,
        id: "settings-a",
      },
    }), { headers: { "Content-Type": "application/json" } }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "source body")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "LLM 설정" }));
    expect(await screen.findByRole("dialog", { name: "LLM 설정" })).toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}{Meta>}f{/Meta}");

    expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument();
    expect(screen.queryByRole("search", { name: "mock find bar" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "LLM 설정" })).toBeInTheDocument();
  });

  it("unmounts compact drawer modals and restores the desktop surface across breakpoints", async () => {
    const user = userEvent.setup();
    const matches = new Map([
      ["(max-width: 1023px)", true],
      ["(max-width: 1279px)", true],
    ]);
    const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => {
      const queryListeners = listeners.get(query) ?? new Set();
      listeners.set(query, queryListeners);
      return {
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
          queryListeners.add(listener as (event: MediaQueryListEvent) => void),
        addListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null) => {
          if (listener) queryListeners.add(listener);
        },
        dispatchEvent: () => true,
        matches: matches.get(query) ?? false,
        media: query,
        onchange: null,
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
          queryListeners.delete(listener as (event: MediaQueryListEvent) => void),
        removeListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null) => {
          if (listener) queryListeners.delete(listener);
        },
      } as MediaQueryList;
    }));
    const resize = (query: string, value: boolean) => {
      matches.set(query, value);
      const event = { matches: value, media: query } as MediaQueryListEvent;
      for (const listener of listeners.get(query) ?? []) listener(event);
    };
    const { container } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "source body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "사이드바 열기" }));
    expect(await screen.findByRole("dialog", { name: "사이드바 열기" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    expect(container).toHaveAttribute("inert");

    act(() => {
      resize("(max-width: 1023px)", false);
      resize("(max-width: 1279px)", false);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "사이드바 열기" })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(container).not.toHaveAttribute("inert");

    act(() => resize("(max-width: 1279px)", true));
    await user.click(screen.getByRole("button", { name: "검토" }));
    expect(await screen.findByRole("dialog", { name: "검토" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    act(() => resize("(max-width: 1279px)", false));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "검토" })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(container).not.toHaveAttribute("inert");

    await user.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByRole("region", { name: "문서 Source" })).toHaveTextContent("source body");
  });

  it("keeps AI command conversations in separate sessions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_clarity"),
            proposal: createProposal("proposal_clarity", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_translate"),
            proposal: {
              ...createProposal("proposal_translate", "pending", "selected text"),
              replacementText: "선택된 텍스트",
            },
          }),
        ),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("button", { name: "Mock translation command" }));
    await waitFor(() => expect(screen.getAllByText("선택된 텍스트").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("tab", { name: "대화" }));

    expect(screen.getByRole("tab", { name: "명확하게 개선" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "한국어로 번역" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "명확하게 개선" }));
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).not.toHaveTextContent("선택된 텍스트");

    await user.click(screen.getByRole("tab", { name: "한국어로 번역" }));
    expect(screen.getByRole("tabpanel", { name: "한국어로 번역" })).toHaveTextContent("선택된 텍스트");
  });

  it("restores document-scoped AI command conversations and can hide a session", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_translate"),
            proposal: {
              ...createProposal("proposal_translate", "pending", "selected text"),
              replacementText: "선택된 텍스트",
            },
          }),
        ),
      );

    const rendered = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    rendered.unmount();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "대화" }));
    expect(screen.getByRole("tab", { name: "명확하게 개선" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");

    await user.click(screen.getByRole("button", { name: "Mock translation command" }));
    await waitFor(() => expect(screen.getAllByText("선택된 텍스트").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("tab", { name: "명확하게 개선" }));
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).toHaveTextContent("revenue grew 8%");
    expect(screen.getByRole("tabpanel", { name: "명확하게 개선" })).not.toHaveTextContent("선택된 텍스트");

    await user.click(screen.getByRole("button", { name: "대화 숨기기" }));
    expect(screen.queryByRole("tab", { name: "명확하게 개선" })).not.toBeInTheDocument();
    expect(screen.queryByText("revenue grew 8%")).not.toBeInTheDocument();
  });

  it("shows the current draft in source view and switches back to rich editing", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "saved body")}
        templates={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "Source 보기" }));

    const sourceRegion = screen.getByRole("region", { name: "문서 Source" });
    expect(sourceRegion).toHaveTextContent("fresh edited body");
    expect(sourceRegion).toHaveTextContent('"type": "doc"');

    await user.click(screen.getByRole("button", { name: "편집 보기" }));

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "문서 Source" })).not.toBeInTheDocument();
  });

  it("shows a selection rewrite result preview with a translate default insert action", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "selected text"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createProposalApplyResponse(
          createProposal("proposal_rewrite", "pending", "selected text"),
          createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document revenue grew 8%"),
          "insert_below",
        ))),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock translation command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByText("한국어로 번역")).toBeInTheDocument();
    expect(within(preview).getByText("revenue grew 8%")).toBeInTheDocument();

    await user.click(within(preview).getByRole("button", { name: "아래에 추가" }));

    expectLastProposalApplyFetch(fetchMock, "proposal_rewrite", "insert_below");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("selected text");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("초안에 반영되었습니다. 변경 사항을 유지하려면 저장하세요.")).toBeInTheDocument();
  });

  it("shows a selection rewrite result preview with a continue-writing default insert action", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_continue"),
          proposal: {
            ...createProposal("proposal_continue", "pending", "selected text"),
            command: "Continue writing",
            defaultApplyMode: "insert_below",
            source: "selection",
          },
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock continue writing command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByText("이어서 쓰기")).toBeInTheDocument();
    expect(within(preview).getByRole("button", { name: "아래에 추가" })).toBeInTheDocument();
  });

  it("uses replace as the default action for rewrite-style selection results", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });
    expect(within(preview).getByRole("button", { name: "교체" })).toBeInTheDocument();
  });

  it("applies current-session selection proposals to the captured occurrence", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_rewrite"),
            proposal: createProposal("proposal_rewrite", "pending", "repeat"),
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createProposalApplyResponse(
          createProposal("proposal_rewrite", "pending", "repeat"),
          createDocumentWithContent("doc_1", "Market Entry Memo", "repeat revenue grew 8%"),
        ))),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "repeat repeat")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock second occurrence command" }));
    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai/rewrite",
      expect.objectContaining({
        body: expect.stringContaining('"occurrenceIndex":1'),
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai/rewrite",
      expect.objectContaining({
        body: expect.stringContaining('"selectionRange":{"from":8,"to":14}'),
      }),
    );

    await user.click(within(preview).getByRole("button", { name: "교체" }));

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("repeat revenue grew 8%");
  });

  it("does not apply a current-session selection proposal after the draft content changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    const preview = await screen.findByRole("region", { name: "선택 AI 결과" });

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(within(preview).getByRole("button", { name: "교체" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("runs selection rewrite commands immediately with default template variables", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createStrategyTemplate()]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "대상 독자" })).toHaveValue("Executive stakeholders");
    expect(screen.getByRole("textbox", { name: "문서 목표" })).toHaveValue(
      "Improve the selected text while preserving the document's intent.",
    );
    expect(screen.getByRole("combobox", { name: "톤" })).toHaveValue("executive");

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/rewrite",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(
            '"variables":{"audience":"Executive stakeholders","objective":"Improve the selected text while preserving the document\'s intent.","tone":"executive"}',
          ),
        }),
      );
    });
    expect(screen.queryByText("선택 AI 실행 전에 필수 템플릿 필드를 입력하세요.")).not.toBeInTheDocument();
  });

  it("shows selection rewrite progress while the command is running", async () => {
    const user = userEvent.setup();
    const deferredRewrite = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredRewrite.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));

    await waitFor(() => {
      expect(screen.getByTestId("mock-selection-command-running")).toHaveTextContent("Improve clarity");
    });

    await act(async () => {
      deferredRewrite.resolve(new Response(JSON.stringify({ run: createAiRun("run_rewrite"), proposal: null })));
      await deferredRewrite.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mock-selection-command-running")).not.toBeInTheDocument();
    });
  });

  it("allows five concurrent selection rewrite commands and blocks the sixth", async () => {
    const user = userEvent.setup();
    const pendingRewrite = new Promise<Response>(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingRewrite);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    const commandButton = screen.getByRole("button", { name: "Mock selection command" });
    for (let count = 0; count < 6; count += 1) {
      await user.click(commandButton);
    }

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
    const idempotencyKeys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(new Set(idempotencyKeys).size).toBe(5);
    expect(screen.getByTestId("mock-selection-command-running")).toHaveTextContent("5");
    expect(screen.getByTestId("mock-selection-command-limit")).toBeInTheDocument();
    expect(screen.getByText("AI 요청은 동시에 최대 5개까지 실행할 수 있습니다. 하나가 완료된 뒤 다시 요청하세요.")).toBeInTheDocument();
  });

  it("runs a full 문서 검토 with current unsaved draft text", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: {
            id: "run_1",
            commandType: "document_review",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          review: { summary: "One finding.", findings: [] },
          proposals: [],
          skippedProposalCount: 0,
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "stale initial body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/review",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"documentText":"fresh edited body"'),
      }),
    );
    const reviewRequest = fetchMock.mock.calls.find(([url]) => url === "/api/ai/review")?.[1] as RequestInit;
    expect(new Headers(reviewRequest.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("reuses the idempotency key when a document review is retried after a 5xx response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ review: { summary: "ok", findings: [] }, proposals: [] })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "document body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await screen.findByText("검토에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it("uses a fresh idempotency key when the serialized review body changes after a failed attempt", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ review: { summary: "ok", findings: [] }, proposals: [] })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "document body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await screen.findByText("검토에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const requests = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(requests[0].body).not.toBe(requests[1].body);
    expect(new Headers(requests[1].headers).get("Idempotency-Key")).not.toBe(
      new Headers(requests[0].headers).get("Idempotency-Key"),
    );
  });

  it("clears a retained review key after a non-allowlisted redirect response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry later" }), { status: 500 }))
      .mockResolvedValueOnce(new Response("{", { status: 302 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ review: { summary: "ok", findings: [] }, proposals: [] })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "document body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("retains a review key when a 200 response body cannot be consumed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ review: { summary: "ok", findings: [] }, proposals: [] })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "document body")}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await screen.findByText("검토에 실패했습니다. 다시 시도하세요.");
    await user.click(screen.getByRole("button", { name: "문서 검토" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it("shows review summary and skipped proposals after a document review", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          review: {
            summary: "세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.",
            findings: [
              {
                problem: "Unclear evidence",
                reason: "The source is missing.",
                targetText: "growth was good",
                replacementText: "revenue grew 8%",
              },
              {
                problem: "Duplicate target",
                reason: "The sentence appears twice.",
                targetText: "repeated",
                replacementText: "specific repeated text",
              },
              {
                problem: "Too broad",
                reason: "The target is too large.",
                targetText: "whole document",
                replacementText: "rewrite everything",
              },
            ],
          },
          proposals: [createProposal("proposal_1")],
          skippedProposalCount: 2,
        }),
      ),
    );
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good");
    const templates = [createTemplate("tpl_1", "Board review")];

    const { rerender } = render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토 요약")).toBeInTheDocument();
    expect(screen.getByText("세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.")).toBeInTheDocument();
    expect(screen.getByText("적용 가능한 제안 1개 · 제외된 제안 2개")).toBeInTheDocument();

    rerender(<DocumentShell aiRuns={[createAiRun("run_1")]} document={document} proposals={[createProposal("proposal_1")]} templates={templates} />);

    expect(screen.getByText("세 가지 이슈 중 하나만 안전하게 제안으로 만들었습니다.")).toBeInTheDocument();
  });

  it("refreshes persisted proposal statuses without clearing the current review summary", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          review: {
            summary: "검토 결과를 유지합니다.",
            findings: [
              {
                problem: "Unclear evidence",
                reason: "The source is missing.",
                targetText: "growth was good",
                replacementText: "revenue grew 8%",
              },
            ],
          },
          proposals: [createProposal("proposal_1")],
          skippedProposalCount: 0,
        }),
      ),
    );
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good");
    const templates = [createTemplate("tpl_1", "Board review")];

    const { rerender } = render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토 결과를 유지합니다.")).toBeInTheDocument();
    expect(screen.getByText("대기 중")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_1")]}
        document={document}
        proposals={[{ ...createProposal("proposal_1", "accepted"), appliedMode: "replace" }]}
        templates={templates}
      />,
    );

    expect(screen.getByText("검토 결과를 유지합니다.")).toBeInTheDocument();
    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.queryByText("대기 중")).not.toBeInTheDocument();
  });

  it("preserves an all-skipped review snapshot across same-document proposal refreshes", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          review: {
            summary: "모든 발견 사항이 본문에 안전하게 적용되지 않아 제외되었습니다.",
            findings: [
              {
                problem: "Ambiguous target",
                reason: "The target appears more than once.",
                targetText: "ambiguous",
                replacementText: "specific text",
              },
            ],
          },
          proposals: [],
          skippedProposalCount: 1,
        }),
      ),
    );
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "body");
    const templates = [createTemplate("tpl_1", "Board review")];

    const { rerender } = render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토가 완료되었고 적용 가능한 제안은 없습니다.")).toBeInTheDocument();

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_old")]}
        document={document}
        proposals={[createProposal("proposal_stale", "pending", "stale proposal target")]}
        templates={templates}
      />,
    );

    expect(screen.getByText("검토가 완료되었고 적용 가능한 제안은 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("stale proposal target")).not.toBeInTheDocument();
  });

  it("clears the previous review snapshot when a new document review fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: createAiRun("run_1"),
            review: {
              summary: "이전 검토 요약입니다.",
              findings: [
                {
                  problem: "Unclear evidence",
                  reason: "The source is missing.",
                  targetText: "growth was good",
                  replacementText: "revenue grew 8%",
                },
              ],
            },
            proposals: [createProposal("proposal_1")],
            skippedProposalCount: 0,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));
    const document = createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good");
    const templates = [createTemplate("tpl_1", "Board review")];

    render(<DocumentShell aiRuns={[]} document={document} templates={templates} />);

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("이전 검토 요약입니다.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(await screen.findByText("검토에 실패했습니다. 다시 시도하세요.")).toBeInTheDocument();
    expect(screen.queryByText("이전 검토 요약입니다.")).not.toBeInTheDocument();
  });

  it("validates cleared required template variables before review", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "대상 독자" }));
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(screen.getByText("대상 독자 필드는 필수입니다.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends template variable values with full 문서 검토 requests", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          proposals: [],
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createRequiredTemplate()]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "대상 독자" }));
    await user.type(screen.getByRole("textbox", { name: "대상 독자" }), "Board");
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/review",
      expect.objectContaining({
        body: expect.stringContaining('"variables":{"audience":"Board"}'),
      }),
    );
  });

  it("ignores variables from a previously selected template when validating and reviewing", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_1"),
          proposals: [],
          review: { findings: [], summary: "ok" },
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "body")}
        templates={[createContractTemplate(), createStrategyTemplate()]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Executive Rewrite" }));
    await user.clear(screen.getByRole("textbox", { name: "대상 독자" }));
    await user.type(screen.getByRole("textbox", { name: "대상 독자" }), "Executive leadership");
    await user.clear(screen.getByRole("textbox", { name: "문서 목표" }));
    await user.type(screen.getByRole("textbox", { name: "문서 목표" }), "Improve decision readiness.");
    await user.selectOptions(screen.getByRole("combobox", { name: "톤" }), "analytical");
    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai/review", expect.anything()));
    const requestInit = fetchMock.mock.calls.find(([url]) => url === "/api/ai/review")?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { variables: Record<string, string> };

    expect(body.variables).toEqual({
      audience: "Executive leadership",
      objective: "Improve decision readiness.",
      tone: "analytical",
    });
    expect(screen.queryByText("필수 템플릿 필드를 입력하세요.")).not.toBeInTheDocument();
  });

  it("persists proposal status changes and rolls back failed updates", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...createProposal("proposal_1"), status: "accepted" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1"), createProposal("proposal_2", "pending", "owner is unclear")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    expectProposalApplyFetch(fetchMock, "proposal_1", "replace");
    expect(screen.getByText("수락됨")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "owner is unclear 제안 거절" }));

    expect(screen.getByText("대기 중")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("hydrates truncated proposal detail before client preflight and apply", async () => {
    const user = userEvent.setup();
    const fullProposal = createProposal("proposal_1", "pending", "growth was good");
    const previewProposal = {
      ...fullProposal,
      isTruncated: true,
      targetText: "growth was",
      replacementText: "revenue",
    };
    const updatedDocument = createDocumentWithContent("doc_1", "Market Entry Memo", "revenue grew 8%");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: fullProposal })))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        createProposalApplyResponse(fullProposal, updatedDocument),
      )));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[previewProposal]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was 제안으로 교체" }));

    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/proposals/proposal_1"));
    expectProposalApplyFetch(fetchMock, "proposal_1", "replace");
    expect(screen.getByText("수락됨")).toBeInTheDocument();
  });

  it("merges the server proposal when a proposal status update conflicts", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Proposal status changed",
          proposal: { ...createProposal("proposal_1", "accepted"), appliedMode: "replace" },
        }),
        { status: 409 },
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안 거절" }));

    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.queryByText("대기 중")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("does not apply proposal text when an accept request conflicts after a newer edit", async () => {
    const user = userEvent.setup();
    const failedPatch = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(failedPatch.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited while pending");

    await act(async () => {
      failedPatch.resolve(
        new Response(
          JSON.stringify({
            error: "Proposal status changed",
            proposal: { ...createProposal("proposal_1", "rejected"), appliedMode: null },
          }),
          { status: 409 },
        ),
      );
      await failedPatch.promise;
    });

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Edited while pending");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
    expect(screen.getByText("거절됨")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("preserves a newer local draft when an accepted proposal can no longer be reconciled", async () => {
    const user = userEvent.setup();
    const acceptedPatch = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(acceptedPatch.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Document revision conflict" }), { status: 409 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      acceptedPatch.resolve(
        new Response(
          JSON.stringify({
            document: {
              id: "doc_1",
              title: "Market Entry Memo",
              contentJson: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "revenue grew 8%" }] }],
              },
              metadataJson: {},
              readiness: "draft",
              revision: 1,
            },
            proposal: { ...createProposal("proposal_1"), status: "accepted" },
          }),
        ),
      );
      await acceptedPatch.promise;
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장되지 않음");
    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");

    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/documents/doc_1");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
  });

  it("reapplies an accepted proposal to newer local edits and keeps the new server revision as its dirty base", async () => {
    const user = userEvent.setup();
    const acceptedPatch = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(acceptedPatch.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited while applying");
    await act(async () => {
      acceptedPatch.resolve(new Response(JSON.stringify({
        change: createChangeIdentity("change_1", 1),
        document: {
          ...createDocumentWithContent("doc_1", "Market Entry Memo", "revenue grew 8%"),
          revision: 1,
        },
        proposal: { ...createProposal("proposal_1"), appliedMode: "replace", status: "accepted" },
      })));
      await acceptedPatch.promise;
    });

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Edited while applying");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장되지 않음");

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      expectedRevision: 1,
      title: "Edited while applying",
    });
  });

  it("replaces accepted proposal text in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(createProposalApplyResponse(
          createProposal("proposal_1"),
          createDocumentWithContent("doc_1", "Market Entry Memo", "revenue grew 8%"),
        )),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    expectProposalApplyFetch(fetchMock, "proposal_1", "replace");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("저장됨")).toBeInTheDocument();
  });

  it("routes a single proposal revision conflict into draft recovery", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      reason: "revision_conflict",
      document: {
        ...createDocumentWithContent("doc_1", "Server title", "Server body"),
        revision: 1,
      },
    }), { status: 409 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Local title", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("다른 곳에서 문서가 변경되었습니다.");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local title");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
  });

  it("uses the revision returned by proposal application for the next draft save", async () => {
    const user = userEvent.setup();
    const appliedDocument = {
      ...createDocumentWithContent("doc_1", "Market Entry Memo", "revenue grew 8%"),
      metadataJson: {},
      readiness: "draft" as const,
      revision: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          change: createChangeIdentity("change_1", 1),
          document: appliedDocument,
          proposal: { ...createProposal("proposal_1"), appliedMode: "replace", status: "accepted" },
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: { ...appliedDocument, title: "Edited after proposal", revision: 2 } })),
      );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안으로 교체" }));
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited after proposal");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 1 });
  });

  it("replaces accepted proposal text across selected list items in the local draft", async () => {
    const user = userEvent.setup();
    const proposal = {
      ...createProposal("proposal_list", "pending", "First item.\nSecond item."),
      replacementText: "Combined replacement.",
      targetFrom: 3,
      targetTo: 30,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createProposalApplyResponse(
        proposal,
        createListDocument(["Combined replacement.", "Third item."]),
      ))),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "List review",
          plainText: "First item.\nSecond item.\nThird item.",
          revision: 0,
          contentJson: {
            type: "doc" as const,
            content: [
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
                  },
                ],
              },
            ],
          },
        }}
        proposals={[proposal]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /제안으로 교체/ }));

    expectProposalApplyFetch(fetchMock, "proposal_list", "replace");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Combined replacement.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Third item.");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("First item.");
    expect(screen.queryByText("제안 상태를 업데이트하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("inserts accepted proposal text below selected list items in the local draft", async () => {
    const user = userEvent.setup();
    const proposal = {
      ...createProposal("proposal_list", "pending", "First item.\nSecond item."),
      defaultApplyMode: "insert_below" as const,
      replacementText: "Inserted suggestion.",
      targetFrom: 3,
      targetTo: 30,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createProposalApplyResponse(
        proposal,
        createListDocument(["First item.", "Second item.", "Inserted suggestion.", "Third item."]),
        "insert_below",
      ))),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "List review",
          plainText: "First item.\nSecond item.\nThird item.",
          revision: 0,
          contentJson: {
            type: "doc" as const,
            content: [
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "First item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Second item." }] }],
                  },
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Third item." }] }],
                  },
                ],
              },
            ],
          },
        }}
        proposals={[proposal]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /제안을 아래에 추가/ }));

    expectProposalApplyFetch(fetchMock, "proposal_list", "insert_below");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("First item.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Second item.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Inserted suggestion.");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Third item.");
    expect(screen.queryByText("제안 상태를 업데이트하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("does not apply a selection proposal to another occurrence when its stored range is stale", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ proposal: { ...createProposal("proposal_stale"), status: "accepted" } })),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "Stale selection",
          plainText: "Edited text\nTarget text",
          revision: 0,
          contentJson: {
            type: "doc" as const,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Edited text" }] },
              { type: "paragraph", content: [{ type: "text", text: "Target text" }] },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_stale", "pending", "Target text"),
            replacementText: "Replacement text",
            source: "selection",
            targetFrom: 1,
            targetTo: 12,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Target text 제안으로 교체" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Target text");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("Replacement text");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("inserts accepted proposal text below the target in the local draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createProposalApplyResponse(
        createProposal("proposal_1"),
        createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good revenue grew 8%"),
        "insert_below",
      ))),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "growth was good 제안을 아래에 추가" }));

    expectProposalApplyFetch(fetchMock, "proposal_1", "insert_below");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("저장됨")).toBeInTheDocument();
  });

  it("does not roll back newer edits when bulk accept persistence fails", async () => {
    const user = userEvent.setup();
    const failedPatch = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(failedPatch.promise);

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));

    await act(async () => {
      failedPatch.resolve(new Response(JSON.stringify({ error: "Failed" }), { status: 500 }));
      await failedPatch.promise;
    });

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
  });

  it("atomically reconciles bulk acceptance onto edits made while the request is pending", async () => {
    const user = userEvent.setup();
    const acceptedBatch = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(acceptedBatch.promise);
    const proposals = [
      { ...createProposal("proposal_alpha", "pending", "alpha"), replacementText: "A" },
      { ...createProposal("proposal_beta", "pending", "beta"), replacementText: "B" },
    ];

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Bulk draft", "alpha beta")}
        proposals={proposals}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));
    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Edited during batch");
    await act(async () => {
      acceptedBatch.resolve(new Response(JSON.stringify({
        change: createChangeIdentity("change_batch", 1, "batch"),
        document: {
          ...createDocumentWithContent("doc_1", "Bulk draft", "A B"),
          revision: 1,
        },
        proposals: proposals.map((proposal) => ({ ...proposal, appliedMode: "replace", status: "accepted" })),
      })));
      await acceptedBatch.promise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/proposals/bulk-apply");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Edited during batch");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("A B");
    expect(screen.getByRole("status", { name: "문서 저장 상태" })).toHaveTextContent("저장되지 않음");
  });

  it("keeps the old revision base when accepted bulk proposals cannot be reconciled", async () => {
    const user = userEvent.setup();
    const acceptedBatch = createDeferredResponse();
    const proposal = { ...createProposal("proposal_alpha", "pending", "alpha"), replacementText: "A" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(acceptedBatch.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Document revision conflict" }), { status: 409 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Bulk draft", "alpha")}
        proposals={[proposal]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await act(async () => {
      acceptedBatch.resolve(new Response(JSON.stringify({
        change: createChangeIdentity("change_batch", 1, "batch"),
        document: {
          ...createDocumentWithContent("doc_1", "Bulk draft", "A"),
          revision: 1,
        },
        proposals: [{ ...proposal, appliedMode: "replace", status: "accepted" }],
      })));
      await acceptedBatch.promise;
    });

    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");

    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/documents/doc_1");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 0 });
  });

  it("bulk accepts range-backed proposals from the end of the document first", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/documents/doc_1") {
        const savedDraft = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ document: { ...savedDraft, id: "doc_1", revision: 2 } }));
      }
      return new Response(
        JSON.stringify({
          change: createChangeIdentity("change_batch", 1, "batch"),
          document: {
            id: "doc_1",
            title: "Range bulk accept",
            contentJson: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Alpha replacement is much longer.Beta replacement." }],
                },
              ],
            },
            metadataJson: {},
            readiness: "draft",
            revision: 1,
          },
          proposals: ["proposal_beta", "proposal_alpha"].map((proposalId) => ({
            ...createProposal(proposalId),
            appliedMode: "replace",
            status: "accepted",
          })),
        }),
      );
    });

    render(
      <DocumentShell
        aiRuns={[]}
        document={{
          id: "doc_1",
          title: "Range bulk accept",
          plainText: "Alpha.\nBeta.",
          revision: 0,
          contentJson: {
            type: "doc" as const,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Alpha." }] },
              { type: "paragraph", content: [{ type: "text", text: "Beta." }] },
            ],
          },
        }}
        proposals={[
          {
            ...createProposal("proposal_alpha", "pending", "Alpha."),
            replacementText: "Alpha replacement is much longer.",
            source: "selection",
            targetFrom: 1,
            targetTo: 7,
          },
          {
            ...createProposal("proposal_beta", "pending", "Beta."),
            replacementText: "Beta replacement.",
            source: "selection",
            targetFrom: 9,
            targetTo: 14,
          },
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/proposals/bulk-apply");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).proposals).toEqual([
      { appliedMode: "replace", id: "proposal_beta" },
      { appliedMode: "replace", id: "proposal_alpha" },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Alpha replacement is much longer.");
      expect(screen.getByTestId("mock-document-body")).toHaveTextContent("Beta replacement.");
    });
    expect(screen.queryByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).not.toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "After bulk apply");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 1 });
  });

  it("keeps every local proposal pending when atomic bulk acceptance conflicts", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Document change conflict", reason: "status_conflict" }), { status: 409 }),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "growth was good owner is unclear")}
        proposals={[
          createProposal("proposal_1", "pending", "growth was good"),
          createProposal("proposal_2", "pending", "owner is unclear"),
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good owner is unclear");
    expect(screen.getAllByText("대기 중")).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("제안 상태를 업데이트하지 못했습니다.");
  });

  it("routes a bulk proposal revision conflict into draft recovery", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      reason: "revision_conflict",
      document: {
        ...createDocumentWithContent("doc_1", "Server title", "Server body"),
        revision: 1,
      },
    }), { status: 409 }));

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Local title", "growth was good owner is unclear")}
        proposals={[
          createProposal("proposal_1", "pending", "growth was good"),
          createProposal("proposal_2", "pending", "owner is unclear"),
        ]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("다른 곳에서 문서가 변경되었습니다.");
    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local title");
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("growth was good owner is unclear");
  });

  it("does not bulk accept a current-session proposal after the draft content changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: createAiRun("run_rewrite"),
          proposal: createProposal("proposal_rewrite", "pending", "selected text"),
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "selected text in document")}
        templates={[createTemplate("tpl_1", "Rewrite template")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mock selection command" }));
    await screen.findByRole("region", { name: "선택 AI 결과" });
    await user.click(screen.getByRole("button", { name: "Mock body edit" }));
    await user.click(screen.getByRole("button", { name: "대기 중인 모든 제안 수락" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("mock-document-body")).toHaveTextContent("fresh edited body");
    expect(screen.getByTestId("mock-document-body")).not.toHaveTextContent("revenue grew 8%");
    expect(screen.getByText("선택 위치가 변경되어 제안을 적용할 수 없습니다. 다시 실행해 주세요.")).toBeInTheDocument();
  });

  it("marks the requested review proposal as the active inline suggestion", async () => {
    const user = userEvent.setup();

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "Company may use Customer Data.")}
        proposals={[createProposal("proposal_contract", "pending", "Customer Data")]}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Customer Data 제안을 본문에서 보기" }));

    expect(screen.getByTestId("mock-inline-suggestions")).toHaveTextContent(
      '"id":"proposal_contract","active":true',
    );
  });

  it("clears active proposal focus after a new 문서 검토 replaces proposals", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: createAiRun("run_new"),
          proposals: [createProposal("proposal_new", "pending", "new risk")],
        }),
      ),
    );

    render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "MSA Review", "Company may use Customer Data. new risk")}
        proposals={[createProposal("proposal_contract", "pending", "Customer Data")]}
        templates={[createTemplate("tpl_1", "Contract Review")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Customer Data 제안을 본문에서 보기" }));
    expect(screen.getByTestId("mock-inline-suggestions")).toHaveTextContent('"active":true');

    await user.click(screen.getByRole("button", { name: "문서 검토" }));

    await waitFor(() => {
      expect(screen.getByTestId("mock-inline-suggestions")).not.toHaveTextContent('"active":true');
    });
  });

  it("refreshes same-document AI runs and proposals without clobbering dirty edits", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentShell
        aiRuns={[]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        proposals={[]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "문서 제목" }));
    await user.type(screen.getByRole("textbox", { name: "문서 제목" }), "Local dirty title");

    rerender(
      <DocumentShell
        aiRuns={[createAiRun("run_1")]}
        document={createDocumentWithContent("doc_1", "Market Entry Memo", "Original body")}
        proposals={[createProposal("proposal_1")]}
        templates={[createTemplate("tpl_1", "Board review")]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "문서 제목" })).toHaveValue("Local dirty title");
    expect(screen.getAllByText("growth was good").length).toBeGreaterThan(0);
    expect(screen.getAllByText("문서 검토").length).toBeGreaterThan(0);
  });
});

describe("SelectionAiMenu", () => {
  it("prevents mouse down from clearing the editor selection", () => {
    render(<SelectionAiMenu hasSelection onCommand={() => undefined} selectedText="selected text" />);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const allowed = screen.getByRole("button", { name: "명확하게 개선" }).dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the floating toolbar outside the document text flow", () => {
    render(
      <SelectionAiMenu
        hasSelection
        left={120}
        onCommand={() => undefined}
        side="top"
        selectedText="A selected sentence for review"
        top={48}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "선택 AI 작업" });
    expect(toolbar).toHaveAttribute("data-side", "top");
    expect(toolbar).toHaveClass("absolute");
    expect(toolbar).not.toHaveClass("sticky");
    expect(toolbar).toHaveStyle({ left: "120px", top: "48px" });
    expect(screen.queryByText("A selected sentence for review")).not.toBeInTheDocument();
  });

  it("offers translation commands for selected text", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "한국어로 번역" }));
    await user.click(screen.getByRole("button", { name: "영어로 번역" }));

    expect(handleCommand).toHaveBeenNthCalledWith(
      1,
      "Translate to Korean",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.translate_ko" }),
    );
    expect(handleCommand).toHaveBeenNthCalledWith(
      2,
      "Translate to English",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.translate_en" }),
    );
  });

  it("renders plugin-provided selection commands", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(
      <SelectionAiMenu
        commands={[
          {
            ariaLabel: "법률 리스크 완화",
            command: "Mitigate legal risk",
            icon: "sparkles",
            id: "legal-risk",
            label: "리스크",
          },
        ]}
        hasSelection
        onCommand={handleCommand}
        selectedText="selected text"
      />,
    );

    await user.click(screen.getByRole("button", { name: "법률 리스크 완화" }));

    expect(handleCommand).toHaveBeenCalledWith(
      "Mitigate legal risk",
      expect.objectContaining({ defaultApplyMode: "replace", id: "legal-risk" }),
    );
    expect(screen.queryByRole("button", { name: "한국어로 번역" })).not.toBeInTheDocument();
  });

  it("offers a continue writing command for selected text", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "이어서 쓰기" }));

    expect(handleCommand).toHaveBeenCalledWith(
      "Continue writing",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.continue_writing" }),
    );
  });

  it("renders selection commands with Korean labels", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection language="ko" onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "한국어로 번역" }));
    await user.click(screen.getByRole("button", { name: "영어로 번역" }));

    expect(handleCommand).toHaveBeenNthCalledWith(
      1,
      "Translate to Korean",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.translate_ko" }),
    );
    expect(handleCommand).toHaveBeenNthCalledWith(
      2,
      "Translate to English",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.translate_en" }),
    );
  });

  it("renders continue writing with a Korean label", async () => {
    const user = userEvent.setup();
    const handleCommand = vi.fn();

    render(<SelectionAiMenu hasSelection language="ko" onCommand={handleCommand} selectedText="selected text" />);

    await user.click(screen.getByRole("button", { name: "이어서 쓰기" }));

    expect(handleCommand).toHaveBeenCalledWith(
      "Continue writing",
      expect.objectContaining({ defaultApplyMode: "insert_below", id: "ai.continue_writing" }),
    );
  });

  it("shows an in-place running status for the active command", () => {
    const handleCommand = vi.fn();

    render(
      <SelectionAiMenu
        hasSelection
        isRunning
        onCommand={handleCommand}
        runningCommand="Translate to Korean"
        selectedText="selected text"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("한국어로 번역 실행 중...");
    expect(screen.queryByRole("button", { name: "한국어로 번역" })).not.toBeInTheDocument();
  });
});
