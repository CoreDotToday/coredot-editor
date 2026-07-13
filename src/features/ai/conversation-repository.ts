import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withSerializedDocumentWrite } from "@/db/document-write-queue";
import {
  aiProposals,
  aiRuns,
  aiWorkspaceConversations,
  aiWorkspaceMessages,
  documents,
  type AiWorkspaceConversationRecord,
  type AiWorkspaceMessageRecord,
} from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";
import type { RequestContext } from "@/features/auth/request-context";
import { decodeCollectionCursor, encodeCollectionCursor } from "@/features/pagination/collection-cursor";
import {
  CONVERSATION_LIMITS,
  isExpectedVersion,
  isValidAppendInput,
  isValidCreateInput,
  isValidKey,
  type AppendConversationInput,
  type Conversation,
  type ConversationMessage,
  type ConversationPage,
  type ConversationResult,
  type ConversationSummary,
  type ConversationStatus,
  type CreateConversationInput,
} from "./conversation-domain";

export {
  CONVERSATION_LIMITS,
  decodeConversationCursor,
  encodeConversationCursor,
  isExpectedVersion,
  isValidAppendInput,
  isValidCreateInput,
  isValidKey,
  type AppendConversationInput,
  type Conversation,
  type ConversationFailureReason,
  type ConversationMessage,
  type ConversationPage,
  type ConversationResult,
  type ConversationSummary,
  type ConversationStatus,
  type CreateConversationInput,
} from "./conversation-domain";

type ConversationDatabase = typeof db;

export function createConversationRepository(database: ConversationDatabase = db) {
  async function readConversation(context: RequestContext, conversationId: string) {
    const rows = await database
      .select({ conversation: aiWorkspaceConversations, message: aiWorkspaceMessages })
      .from(aiWorkspaceConversations)
      .leftJoin(aiWorkspaceMessages, and(
        eq(aiWorkspaceMessages.workspaceId, aiWorkspaceConversations.workspaceId),
        eq(aiWorkspaceMessages.conversationId, aiWorkspaceConversations.id),
        or(
          isNull(aiWorkspaceMessages.retentionExpiresAt),
          gt(aiWorkspaceMessages.retentionExpiresAt, new Date()),
        ),
      ))
      .where(and(
        eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
        eq(aiWorkspaceConversations.id, conversationId),
        or(
          isNull(aiWorkspaceConversations.retentionExpiresAt),
          gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
        ),
      ))
      .orderBy(asc(aiWorkspaceMessages.ordinal));
    return hydrateConversationRows(rows)[0] ?? null;
  }

  return {
    async get(
      context: RequestContext,
      conversationId: string,
    ): Promise<ConversationResult<Conversation>> {
      const value = await readConversation(context, conversationId);
      return value ? { ok: true, value } : { ok: false, reason: "not_found" };
    },

    async list(
      context: RequestContext,
      input: { cursor?: string; documentId: string; includeArchived?: boolean; limit?: number },
    ): Promise<ConversationResult<ConversationPage>> {
      const limit = input.limit ?? CONVERSATION_LIMITS.defaultPageSize;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LIMITS.maximumPageSize) {
        return { ok: false, reason: "invalid" };
      }
      const cursorScope = {
        collection: "conversations",
        documentId: input.documentId,
        includeArchived: input.includeArchived ?? false,
        workspaceId: context.workspaceId,
      } as const;
      const cursor = input.cursor ? decodeCollectionCursor(input.cursor, cursorScope) : null;

      const [document] = await database
        .select({ id: documents.id })
        .from(documents)
        .where(and(
          eq(documents.workspaceId, context.workspaceId),
          eq(documents.id, input.documentId),
          eq(documents.status, "draft"),
        ))
        .limit(1);
      if (!document) return { ok: false, reason: "not_found" };

      const now = new Date();
      const conversations = await database
        .select({
          archivedAt: aiWorkspaceConversations.archivedAt,
          command: aiWorkspaceConversations.command,
          createdAt: aiWorkspaceConversations.createdAt,
          documentId: aiWorkspaceConversations.documentId,
          id: aiWorkspaceConversations.id,
          latestAiRunId: aiWorkspaceConversations.latestAiRunId,
          latestProposalId: aiWorkspaceConversations.latestProposalId,
          messageCount: aiWorkspaceConversations.messageCount,
          retentionExpiresAt: aiWorkspaceConversations.retentionExpiresAt,
          status: aiWorkspaceConversations.status,
          title: aiWorkspaceConversations.title,
          updatedAt: aiWorkspaceConversations.updatedAt,
          version: aiWorkspaceConversations.version,
        })
        .from(aiWorkspaceConversations)
        .where(and(
          eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
          eq(aiWorkspaceConversations.documentId, input.documentId),
          input.includeArchived ? undefined : isNull(aiWorkspaceConversations.archivedAt),
          or(
            isNull(aiWorkspaceConversations.retentionExpiresAt),
            gt(aiWorkspaceConversations.retentionExpiresAt, now),
          ),
          cursor
            ? or(
                lt(aiWorkspaceConversations.updatedAt, cursor.timestamp),
                and(
                  eq(aiWorkspaceConversations.updatedAt, cursor.timestamp),
                  lt(aiWorkspaceConversations.id, cursor.id),
                ),
              )
            : undefined,
        ))
        .orderBy(desc(aiWorkspaceConversations.updatedAt), desc(aiWorkspaceConversations.id))
        .limit(limit + 1);
      const items = conversations.slice(0, limit).map(toConversationSummary);
      const last = items.at(-1);
      return {
        ok: true,
        value: {
          items,
          nextCursor: conversations.length > limit && last
            ? encodeCollectionCursor({ id: last.id, timestamp: last.updatedAt }, cursorScope)
            : null,
        },
      };
    },

    async create(
      context: RequestContext,
      input: CreateConversationInput,
    ): Promise<ConversationResult<Conversation>> {
      if (!isValidCreateInput(input)) return { ok: false, reason: "invalid" };
      const fingerprint = fingerprintValue({
        command: input.command,
        documentId: input.documentId,
        initialMessage: input.initialMessage,
        retentionExpiresAt: input.retentionExpiresAt?.toISOString() ?? null,
        title: input.title,
      });
      const messageFingerprint = fingerprintValue(input.initialMessage);
      const result = await withSerializedDocumentWrite(context, `conversation-create:${input.documentId}`, () =>
        retrySqliteContention(() => database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.creationKey, input.creationKey),
          ))
          .limit(1);
        if (existing) {
          return existing.creationFingerprint === fingerprint
            ? { id: existing.id, kind: "replayed" as const }
            : { kind: "conflict" as const };
        }

        const [document] = await transaction
          .select({ id: documents.id })
          .from(documents)
          .where(and(
            eq(documents.workspaceId, context.workspaceId),
            eq(documents.id, input.documentId),
            eq(documents.status, "draft"),
          ))
          .limit(1);
        if (!document) return { kind: "not_found" as const };

        const now = new Date();
        const [usage] = await transaction
          .select({ value: count() })
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.documentId, input.documentId),
            or(
              isNull(aiWorkspaceConversations.retentionExpiresAt),
              gt(aiWorkspaceConversations.retentionExpiresAt, now),
            ),
          ));
        if ((usage?.value ?? 0) >= CONVERSATION_LIMITS.conversationsPerDocument) {
          return { kind: "limit" as const };
        }

        const [created] = await transaction
          .insert(aiWorkspaceConversations)
          .values({
            workspaceId: context.workspaceId,
            documentId: input.documentId,
            createdByPrincipalId: context.principalId,
            creationKey: input.creationKey,
            creationFingerprint: fingerprint,
            title: input.title.trim(),
            command: input.command,
            status: "idle",
            version: 1,
            messageCount: 1,
            archivedAt: null,
            retentionExpiresAt: input.retentionExpiresAt ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [aiWorkspaceConversations.workspaceId, aiWorkspaceConversations.creationKey],
          })
          .returning();
        if (!created) {
          const [raced] = await transaction
            .select()
            .from(aiWorkspaceConversations)
            .where(and(
              eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
              eq(aiWorkspaceConversations.creationKey, input.creationKey),
            ))
            .limit(1);
          return raced?.creationFingerprint === fingerprint
            ? { id: raced.id, kind: "replayed" as const }
            : { kind: "conflict" as const };
        }

        await transaction.insert(aiWorkspaceMessages).values({
          workspaceId: context.workspaceId,
          conversationId: created.id,
          documentId: input.documentId,
          mutationKey: input.initialMessage.mutationKey,
          mutationFingerprint: messageFingerprint,
          ordinal: 0,
          role: input.initialMessage.role,
          content: input.initialMessage.content,
          command: input.initialMessage.command ?? null,
          scopeLabel: input.initialMessage.scopeLabel ?? null,
          retentionExpiresAt: input.retentionExpiresAt ?? null,
          createdAt: now,
        });
        return { id: created.id, kind: "created" as const };
        })),
      );
      if (result.kind === "conflict" || result.kind === "limit" || result.kind === "not_found") {
        return { ok: false, reason: result.kind };
      }
      const value = await readConversation(context, result.id);
      return value
        ? { ok: true, replayed: result.kind === "replayed", value }
        : { ok: false, reason: "not_found" };
    },

    async append(
      context: RequestContext,
      conversationId: string,
      input: AppendConversationInput,
    ): Promise<ConversationResult<Conversation>> {
      if (!isValidAppendInput(input)) return { ok: false, reason: "invalid" };
      const mutationFingerprint = fingerprintValue({
        aiRunId: input.aiRunId ?? null,
        command: input.command ?? null,
        content: input.content,
        proposalId: input.proposalId ?? null,
        role: input.role,
        scopeLabel: input.scopeLabel ?? null,
        status: input.status,
      });
      const result = await withSerializedDocumentWrite(context, `conversation:${conversationId}`, () =>
        retrySqliteContention(() => database.transaction(async (transaction) => {
        const [conversation] = await transaction
          .select()
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.id, conversationId),
            or(
              isNull(aiWorkspaceConversations.retentionExpiresAt),
              gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
            ),
          ))
          .limit(1);
        if (!conversation) return { kind: "not_found" as const };

        const [existing] = await transaction
          .select()
          .from(aiWorkspaceMessages)
          .where(and(
            eq(aiWorkspaceMessages.workspaceId, context.workspaceId),
            eq(aiWorkspaceMessages.conversationId, conversationId),
            eq(aiWorkspaceMessages.mutationKey, input.mutationKey),
          ))
          .limit(1);
        if (existing) {
          return existing.mutationFingerprint === mutationFingerprint
            ? { kind: "replayed" as const }
            : { kind: "conflict" as const };
        }

        if (conversation.messageCount >= CONVERSATION_LIMITS.messagesPerConversation) {
          return { kind: "limit" as const };
        }
        const messageContents = await transaction
          .select({ content: aiWorkspaceMessages.content })
          .from(aiWorkspaceMessages)
          .where(and(
            eq(aiWorkspaceMessages.workspaceId, context.workspaceId),
            eq(aiWorkspaceMessages.conversationId, conversationId),
          ));
        const characterCount = messageContents.reduce((total, message) => total + message.content.length, 0);
        if (characterCount + input.content.length > CONVERSATION_LIMITS.charactersPerConversation) {
          return { kind: "limit" as const };
        }

        const linked = await resolveConversationLinks(transaction, context.workspaceId, conversation.documentId, {
          aiRunId: input.aiRunId ?? null,
          proposalId: input.proposalId ?? null,
        });
        if (!linked.ok) return { kind: "not_found" as const };
        const hasLink = Boolean(input.aiRunId || input.proposalId);

        const [updated] = await transaction
          .update(aiWorkspaceConversations)
          .set({
            latestAiRunId: hasLink ? linked.aiRunId : conversation.latestAiRunId,
            latestProposalId: hasLink ? linked.proposalId : conversation.latestProposalId,
            messageCount: sql`${aiWorkspaceConversations.messageCount} + 1`,
            status: input.status,
            updatedAt: new Date(),
            version: sql`${aiWorkspaceConversations.version} + 1`,
          })
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.id, conversationId),
            eq(aiWorkspaceConversations.version, input.expectedVersion),
            lt(aiWorkspaceConversations.messageCount, CONVERSATION_LIMITS.messagesPerConversation),
            or(
              isNull(aiWorkspaceConversations.retentionExpiresAt),
              gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
            ),
          ))
          .returning({
            documentId: aiWorkspaceConversations.documentId,
            messageCount: aiWorkspaceConversations.messageCount,
            retentionExpiresAt: aiWorkspaceConversations.retentionExpiresAt,
          });
        if (!updated) {
          return conversation.messageCount >= CONVERSATION_LIMITS.messagesPerConversation
            ? { kind: "limit" as const }
            : { kind: "conflict" as const };
        }

        await transaction.insert(aiWorkspaceMessages).values({
          workspaceId: context.workspaceId,
          conversationId,
          documentId: updated.documentId,
          mutationKey: input.mutationKey,
          mutationFingerprint,
          ordinal: updated.messageCount - 1,
          role: input.role,
          content: input.content,
          command: input.command ?? null,
          scopeLabel: input.scopeLabel ?? null,
          aiRunId: linked.aiRunId,
          proposalId: linked.proposalId,
          retentionExpiresAt: updated.retentionExpiresAt,
          createdAt: new Date(),
        });
        return { kind: "updated" as const };
        })),
      );
      if (result.kind === "conflict" || result.kind === "limit" || result.kind === "not_found") {
        return { ok: false, reason: result.kind };
      }
      const value = await readConversation(context, conversationId);
      return value
        ? { ok: true, replayed: result.kind === "replayed", value }
        : { ok: false, reason: "not_found" };
    },

    async rename(
      context: RequestContext,
      conversationId: string,
      input: { expectedVersion: number; title: string },
    ): Promise<ConversationResult<Conversation>> {
      const title = input.title.trim();
      if (!title || title.length > CONVERSATION_LIMITS.titleCharacters || !isExpectedVersion(input.expectedVersion)) {
        return { ok: false, reason: "invalid" };
      }
      return mutateConversation(context, conversationId, input.expectedVersion, { title });
    },

    async archive(
      context: RequestContext,
      conversationId: string,
      input: { archived: boolean; expectedVersion: number },
    ): Promise<ConversationResult<Conversation>> {
      if (!isExpectedVersion(input.expectedVersion)) return { ok: false, reason: "invalid" };
      return mutateConversation(context, conversationId, input.expectedVersion, {
        archivedAt: input.archived ? new Date() : null,
      });
    },

    async setStatus(
      context: RequestContext,
      conversationId: string,
      input: { expectedVersion: number; status: ConversationStatus },
    ): Promise<ConversationResult<Conversation>> {
      if (!isExpectedVersion(input.expectedVersion) || !["failed", "idle"].includes(input.status)) {
        return { ok: false, reason: "invalid" };
      }
      return mutateConversation(context, conversationId, input.expectedVersion, { status: input.status });
    },

    async fork(
      context: RequestContext,
      conversationId: string,
      input: { creationKey: string; throughMessageId: string; title: string },
    ): Promise<ConversationResult<Conversation>> {
      const title = input.title.trim();
      if (!isValidKey(input.creationKey) || !input.throughMessageId || !title || title.length > CONVERSATION_LIMITS.titleCharacters) {
        return { ok: false, reason: "invalid" };
      }
      const fingerprint = fingerprintValue({ conversationId, throughMessageId: input.throughMessageId, title });
      const result = await withSerializedDocumentWrite(context, `conversation-fork:${input.creationKey}`, () =>
        retrySqliteContention(() => database.transaction(async (transaction) => {
        const [source] = await transaction
          .select()
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.id, conversationId),
            or(
              isNull(aiWorkspaceConversations.retentionExpiresAt),
              gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
            ),
          ))
          .limit(1);
        if (!source) return { kind: "not_found" as const };

        const [existing] = await transaction
          .select()
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.creationKey, input.creationKey),
          ))
          .limit(1);
        if (existing) {
          return existing.creationFingerprint === fingerprint
            ? { id: existing.id, kind: "replayed" as const }
            : { kind: "conflict" as const };
        }

        const [through] = await transaction
          .select()
          .from(aiWorkspaceMessages)
          .where(and(
            eq(aiWorkspaceMessages.workspaceId, context.workspaceId),
            eq(aiWorkspaceMessages.conversationId, conversationId),
            eq(aiWorkspaceMessages.id, input.throughMessageId),
            or(
              isNull(aiWorkspaceMessages.retentionExpiresAt),
              gt(aiWorkspaceMessages.retentionExpiresAt, new Date()),
            ),
          ))
          .limit(1);
        if (!through) return { kind: "not_found" as const };

        const [usage] = await transaction
          .select({ value: count() })
          .from(aiWorkspaceConversations)
          .where(and(
            eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
            eq(aiWorkspaceConversations.documentId, source.documentId),
            or(
              isNull(aiWorkspaceConversations.retentionExpiresAt),
              gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
            ),
          ));
        if ((usage?.value ?? 0) >= CONVERSATION_LIMITS.conversationsPerDocument) {
          return { kind: "limit" as const };
        }

        const prefix = await transaction
          .select()
          .from(aiWorkspaceMessages)
          .where(and(
            eq(aiWorkspaceMessages.workspaceId, context.workspaceId),
            eq(aiWorkspaceMessages.conversationId, conversationId),
            sql`${aiWorkspaceMessages.ordinal} <= ${through.ordinal}`,
            or(
              isNull(aiWorkspaceMessages.retentionExpiresAt),
              gt(aiWorkspaceMessages.retentionExpiresAt, new Date()),
            ),
          ))
          .orderBy(asc(aiWorkspaceMessages.ordinal));
        const lastLinked = [...prefix].reverse().find((message) => message.aiRunId || message.proposalId);
        const now = new Date();
        const [created] = await transaction
          .insert(aiWorkspaceConversations)
          .values({
            workspaceId: context.workspaceId,
            documentId: source.documentId,
            createdByPrincipalId: context.principalId,
            creationKey: input.creationKey,
            creationFingerprint: fingerprint,
            title,
            command: source.command,
            status: "idle",
            version: 1,
            messageCount: prefix.length,
            latestAiRunId: lastLinked?.aiRunId ?? null,
            latestProposalId: lastLinked?.proposalId ?? null,
            archivedAt: null,
            retentionExpiresAt: source.retentionExpiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [aiWorkspaceConversations.workspaceId, aiWorkspaceConversations.creationKey],
          })
          .returning();
        if (!created) {
          const [raced] = await transaction
            .select()
            .from(aiWorkspaceConversations)
            .where(and(
              eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
              eq(aiWorkspaceConversations.creationKey, input.creationKey),
            ))
            .limit(1);
          return raced?.creationFingerprint === fingerprint
            ? { id: raced.id, kind: "replayed" as const }
            : { kind: "conflict" as const };
        }
        await transaction.insert(aiWorkspaceMessages).values(prefix.map((message, ordinal) => ({
          workspaceId: context.workspaceId,
          conversationId: created.id,
          documentId: source.documentId,
          mutationKey: `fork:${message.id}`,
          mutationFingerprint: message.mutationFingerprint,
          ordinal,
          role: message.role,
          content: message.content,
          command: message.command,
          scopeLabel: message.scopeLabel,
          aiRunId: message.aiRunId,
          proposalId: message.proposalId,
          retentionExpiresAt: source.retentionExpiresAt,
          createdAt: message.createdAt,
        })));
        return { id: created.id, kind: "created" as const };
        })),
      );
      if (result.kind === "conflict" || result.kind === "limit" || result.kind === "not_found") {
        return { ok: false, reason: result.kind };
      }
      const value = await readConversation(context, result.id);
      return value
        ? { ok: true, replayed: result.kind === "replayed", value }
        : { ok: false, reason: "not_found" };
    },
  };

  async function mutateConversation(
    context: RequestContext,
    conversationId: string,
    expectedVersion: number,
    values: {
      archivedAt?: Date | null;
      status?: ConversationStatus;
      title?: string;
    },
  ): Promise<ConversationResult<Conversation>> {
    const [existing] = await database
      .select()
      .from(aiWorkspaceConversations)
      .where(and(
        eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
        eq(aiWorkspaceConversations.id, conversationId),
        or(
          isNull(aiWorkspaceConversations.retentionExpiresAt),
          gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
        ),
      ))
      .limit(1);
    if (!existing) return { ok: false, reason: "not_found" };
    const noChange = (values.title === undefined || values.title === existing.title) &&
      (values.status === undefined || values.status === existing.status) &&
      (values.archivedAt === undefined || Boolean(values.archivedAt) === Boolean(existing.archivedAt));
    if (noChange) {
      const value = await readConversation(context, conversationId);
      return value ? { ok: true, replayed: true, value } : { ok: false, reason: "not_found" };
    }

    const [updated] = await database
      .update(aiWorkspaceConversations)
      .set({
        ...values,
        updatedAt: new Date(),
        version: sql`${aiWorkspaceConversations.version} + 1`,
      })
      .where(and(
        eq(aiWorkspaceConversations.workspaceId, context.workspaceId),
        eq(aiWorkspaceConversations.id, conversationId),
        eq(aiWorkspaceConversations.version, expectedVersion),
        or(
          isNull(aiWorkspaceConversations.retentionExpiresAt),
          gt(aiWorkspaceConversations.retentionExpiresAt, new Date()),
        ),
      ))
      .returning({ id: aiWorkspaceConversations.id });
    if (!updated) return { ok: false, reason: "conflict" };
    const value = await readConversation(context, conversationId);
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  }
}

async function resolveConversationLinks(
  transaction: Parameters<Parameters<ConversationDatabase["transaction"]>[0]>[0],
  workspaceId: string,
  documentId: string,
  input: { aiRunId: string | null; proposalId: string | null },
): Promise<{ aiRunId: string | null; ok: true; proposalId: string | null } | { ok: false }> {
  let proposalRunId: string | null = null;
  if (input.proposalId) {
    const [proposal] = await transaction
      .select({ aiRunId: aiProposals.aiRunId })
      .from(aiProposals)
      .where(and(
        eq(aiProposals.workspaceId, workspaceId),
        eq(aiProposals.documentId, documentId),
        eq(aiProposals.id, input.proposalId),
      ))
      .limit(1);
    if (!proposal) return { ok: false };
    proposalRunId = proposal.aiRunId;
    if (input.aiRunId && input.aiRunId !== proposalRunId) return { ok: false };
  }
  const aiRunId = input.aiRunId ?? proposalRunId;
  if (aiRunId) {
    const [run] = await transaction
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(and(
        eq(aiRuns.workspaceId, workspaceId),
        eq(aiRuns.documentId, documentId),
        eq(aiRuns.id, aiRunId),
      ))
      .limit(1);
    if (!run) return { ok: false };
  }
  return { aiRunId, ok: true, proposalId: input.proposalId };
}

function hydrateConversationRows(rows: Array<{
  conversation: typeof aiWorkspaceConversations.$inferSelect;
  message: AiWorkspaceMessageRecord | null;
}>): Conversation[] {
  const records = new Map<string, typeof aiWorkspaceConversations.$inferSelect>();
  const messagesByConversation = new Map<string, AiWorkspaceMessageRecord[]>();
  for (const row of rows) {
    records.set(row.conversation.id, row.conversation);
    if (!row.message) continue;
    const grouped = messagesByConversation.get(row.conversation.id) ?? [];
    grouped.push(row.message);
    messagesByConversation.set(row.conversation.id, grouped);
  }
  return Array.from(records.values(), (record) => ({
    archived: record.archivedAt !== null,
    command: record.command,
    createdAt: record.createdAt,
    documentId: record.documentId,
    id: record.id,
    latestAiRunId: record.latestAiRunId,
    latestProposalId: record.latestProposalId,
    messageCount: (messagesByConversation.get(record.id) ?? []).length,
    messages: (messagesByConversation.get(record.id) ?? []).map(toConversationMessage),
    retentionExpiresAt: record.retentionExpiresAt,
    status: record.status,
    title: record.title,
    updatedAt: record.updatedAt,
    version: record.version,
  }));
}

function toConversationSummary(
  record: Pick<AiWorkspaceConversationRecord,
    | "archivedAt"
    | "command"
    | "createdAt"
    | "documentId"
    | "id"
    | "latestAiRunId"
    | "latestProposalId"
    | "messageCount"
    | "retentionExpiresAt"
    | "status"
    | "title"
    | "updatedAt"
    | "version"
  >,
): ConversationSummary {
  return {
    archived: record.archivedAt !== null,
    command: record.command,
    createdAt: record.createdAt,
    documentId: record.documentId,
    id: record.id,
    latestAiRunId: record.latestAiRunId,
    latestProposalId: record.latestProposalId,
    messageCount: record.messageCount,
    retentionExpiresAt: record.retentionExpiresAt,
    status: record.status,
    title: record.title,
    updatedAt: record.updatedAt,
    version: record.version,
  };
}

function toConversationMessage(record: AiWorkspaceMessageRecord): ConversationMessage {
  return {
    aiRunId: record.aiRunId,
    command: record.command,
    content: record.content,
    createdAt: record.createdAt,
    id: record.id,
    proposalId: record.proposalId,
    role: record.role,
    scopeLabel: record.scopeLabel,
  };
}

function fingerprintValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const defaultConversationRepository = createConversationRepository();

export const listConversations = defaultConversationRepository.list;
export const getConversationById = defaultConversationRepository.get;
export const createConversation = defaultConversationRepository.create;
export const appendConversationMessage = defaultConversationRepository.append;
export const renameConversation = defaultConversationRepository.rename;
export const archiveConversation = defaultConversationRepository.archive;
export const setConversationStatus = defaultConversationRepository.setStatus;
export const forkConversation = defaultConversationRepository.fork;
