import { defaultDocumentSchemaProfileRuntime } from "./document-schema-profile-runtime.mjs";

/**
 * Build-time schema selection seam. Replace this value with another
 * server-safe profile to change both the browser editor and DOCX worker.
 */
export const appDocumentSchemaProfileRuntime = defaultDocumentSchemaProfileRuntime;
