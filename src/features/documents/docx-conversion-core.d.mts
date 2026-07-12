import type { TiptapJson } from "@/db/schema";

export function docxBufferToTiptapJsonCore(buffer: Uint8Array): Promise<{
  contentJson: TiptapJson;
  warnings: string[];
}>;
export function tiptapJsonToDocxBufferCore(contentJson: TiptapJson, title?: string): Promise<Buffer>;
