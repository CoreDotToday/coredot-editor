import { z } from "zod";

export const aiCommandPayloadSchema = z.object({
  documentId: z.string().min(1),
  templateId: z.string().min(1),
  command: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({}),
  selectedText: z.string().default(""),
  occurrenceIndex: z.number().int().nonnegative().optional(),
  selectionRange: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    })
    .refine((range) => range.to >= range.from)
    .optional(),
  beforeContext: z.string().default(""),
  afterContext: z.string().default(""),
  documentText: z.string().default(""),
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
