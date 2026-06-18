import { z } from "zod";
import { AI_CONTEXT_LIMITS } from "./context-limits";

export const aiProposalApplyModeSchema = z.enum(["replace", "insert_below"]);
export type AiProposalApplyModeInput = z.infer<typeof aiProposalApplyModeSchema>;

export const aiCommandPayloadSchema = z.object({
  documentId: z.string().min(1),
  templateId: z.string().min(1),
  command: z.string().min(1).max(AI_CONTEXT_LIMITS.commandMaxCharacters),
  defaultApplyMode: aiProposalApplyModeSchema.optional(),
  references: z
    .object({
      documents: z
        .array(
          z.object({
            documentId: z.string().min(1),
            titleSnapshot: z.string().optional(),
          }),
        )
        .max(AI_CONTEXT_LIMITS.maxReferenceDocuments)
        .default([]),
    })
    .default({ documents: [] }),
  variables: z.record(z.string(), z.unknown()).default({}),
  selectedText: z.string().max(AI_CONTEXT_LIMITS.selectedTextMaxCharacters).default(""),
  occurrenceIndex: z.number().int().nonnegative().optional(),
  selectionRange: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    })
    .refine((range) => range.to >= range.from)
    .optional(),
  beforeContext: z.string().max(AI_CONTEXT_LIMITS.beforeContextMaxCharacters).default(""),
  afterContext: z.string().max(AI_CONTEXT_LIMITS.afterContextMaxCharacters).default(""),
  documentText: z.string().max(AI_CONTEXT_LIMITS.documentTextMaxCharacters).default(""),
});

export type AiCommandPayload = z.infer<typeof aiCommandPayloadSchema>;

export type AiMessage = {
  role: "system" | "user";
  content: string;
};

export const reviewFindingSchema = z.object({
  problem: z.string(),
  reason: z.string(),
  targetText: z.string(),
  replacementText: z.string(),
});

export const reviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(reviewFindingSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;
