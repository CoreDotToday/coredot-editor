import { describe, expect, it } from "vitest";
import {
  CONVERSATION_LIMITS,
  decodeConversationCursor,
  encodeConversationCursor,
  isValidAppendInput,
} from "./conversation-domain";

describe("conversation domain", () => {
  it("matches the AI selection limit while keeping an aggregate conversation budget", () => {
    expect(CONVERSATION_LIMITS.messageCharacters).toBe(100_000);
    expect(CONVERSATION_LIMITS.charactersPerConversation).toBe(1_000_000);
  });

  it("round-trips a client-safe stable list cursor and rejects malformed cursors", () => {
    const updatedAt = new Date("2026-01-02T03:04:05.678Z");
    const scope = { documentId: "doc-a", includeArchived: false, workspaceId: "workspace-a" };
    const cursor = encodeConversationCursor(updatedAt, "conversation-한글", scope);
    expect(cursor).not.toContain("workspace-a");
    expect(decodeConversationCursor(cursor, scope)).toEqual({ id: "conversation-한글", updatedAt });
    expect(decodeConversationCursor(cursor, { ...scope, documentId: "doc-b" })).toBeNull();
    expect(decodeConversationCursor(cursor, { ...scope, includeArchived: true })).toBeNull();
    expect(decodeConversationCursor("not-a-cursor", scope)).toBeNull();
    expect(decodeConversationCursor("x".repeat(513), scope)).toBeNull();
  });

  it("requires an AI run whenever a proposal link is appended", () => {
    expect(isValidAppendInput({
      content: "Answer",
      expectedVersion: 1,
      mutationKey: "proposal-only-key-0001",
      proposalId: "proposal-a",
      role: "assistant",
      status: "idle",
    })).toBe(false);
    expect(isValidAppendInput({
      aiRunId: "run-a",
      content: "Answer",
      expectedVersion: 1,
      mutationKey: "proposal-pair-key-0001",
      proposalId: "proposal-a",
      role: "assistant",
      status: "idle",
    })).toBe(true);
  });
});
