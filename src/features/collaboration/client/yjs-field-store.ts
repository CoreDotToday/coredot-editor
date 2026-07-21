"use client";

import * as Y from "yjs";

import type { DocumentMetadata, DocumentMetadataValue } from "@/db/schema";
import {
  validateProjectMetadata,
  type ProjectProfile,
} from "@/features/projects/project-profile";

import {
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_MAX_LENGTH,
  COLLABORATION_TITLE_NAME,
} from "../contracts";

export type YjsFieldStoreErrorCategory =
  | "metadata_invalid"
  | "shared_type_mismatch"
  | "title_invalid";

export class YjsFieldStoreError extends Error {
  override readonly name = "YjsFieldStoreError";

  constructor(readonly category: YjsFieldStoreErrorCategory) {
    super(category === "shared_type_mismatch"
      ? "Collaborative field store is unavailable"
      : "Collaborative field update is invalid");
  }
}

export type YjsFieldStore = {
  destroy(): void;
  getMetadataSnapshot(): Readonly<DocumentMetadata>;
  getTitleSnapshot(): string;
  setMetadataField(key: string, value: DocumentMetadataValue | undefined): boolean;
  setTitle(next: string): boolean;
  subscribeMetadata(listener: () => void): () => void;
  subscribeTitle(listener: () => void): () => void;
};
type SharedRoot = Y.Doc["share"] extends Map<string, infer Root> ? Root : never;

export function createYjsFieldStore(options: {
  allowPreSyncEmptyTitle?: boolean;
  document: Y.Doc;
  onInvalid?: () => void;
  projectProfile: ProjectProfile;
  writable: () => boolean;
}): YjsFieldStore {
  const roots = acquireRoots(options.document);
  if (!roots) throw new YjsFieldStoreError("shared_type_mismatch");

  const titleListeners = new Set<() => void>();
  const metadataListeners = new Set<() => void>();
  let destroyed = false;
  let failClosed = false;
  // Production attaches only after provider sync and therefore validates
  // strictly. Isolated pre-sync consumers must explicitly opt into empty.
  let titleSnapshot = readTitle(roots.title, {
    allowPreSyncEmpty: options.allowPreSyncEmptyTitle === true,
  });
  let metadataSnapshot = readMetadata(roots.metadata, options.projectProfile);

  const failClosedStore = () => {
    if (destroyed || failClosed) return;
    failClosed = true;
    try {
      options.onInvalid?.();
    } catch {
      // Session teardown is best effort and must never escape a Yjs observer.
    }
  };

  const handleTransaction = (transaction: Y.Transaction) => {
    if (destroyed || failClosed) return;
    const titleChanged = transactionChangedRoot(transaction, roots.title);
    const metadataChanged = transactionChangedRoot(transaction, roots.metadata);
    if (!titleChanged && !metadataChanged) return;

    let nextTitle = titleSnapshot;
    let nextMetadata = metadataSnapshot;
    try {
      if (titleChanged) nextTitle = readTitle(roots.title);
      if (metadataChanged) nextMetadata = readMetadata(roots.metadata, options.projectProfile);
    } catch {
      // Invalid remote state must not escape the Yjs observer or replace the
      // last valid React snapshot. The server will close/reload this room.
      failClosedStore();
      return;
    }

    const publishTitle = titleChanged && nextTitle !== titleSnapshot;
    const publishMetadata = metadataChanged && !metadataEqual(metadataSnapshot, nextMetadata);
    titleSnapshot = nextTitle;
    metadataSnapshot = nextMetadata;
    if (publishTitle) publish(titleListeners);
    if (publishMetadata) publish(metadataListeners);
  };

  options.document.on("afterTransaction", handleTransaction);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      options.document.off("afterTransaction", handleTransaction);
      titleListeners.clear();
      metadataListeners.clear();
    },

    getMetadataSnapshot() {
      return metadataSnapshot;
    },

    getTitleSnapshot() {
      return titleSnapshot;
    },

    setMetadataField(key: string, value: DocumentMetadataValue | undefined) {
      if (destroyed || failClosed || !isWritable(options.writable)) return false;
      if (!options.projectProfile.metadataFields.some((field) => field.id === key)) {
        throw new YjsFieldStoreError("metadata_invalid");
      }

      const candidate = cloneMetadata(metadataSnapshot);
      if (value === undefined) delete candidate[key];
      else candidate[key] = cloneMetadataValue(value);
      const validation = validateProjectMetadata(
        options.projectProfile,
        candidate,
        {},
        { enforceRequired: false },
      );
      if (!validation.ok) throw new YjsFieldStoreError("metadata_invalid");

      const normalized = validation.value[key];
      const current = metadataSnapshot[key];
      if (metadataValueEqual(current, normalized)) return true;
      options.document.transact(() => {
        if (normalized === undefined) roots.metadata.delete(key);
        else roots.metadata.set(key, cloneMetadataValue(normalized));
      }, FIELD_STORE_ORIGIN);
      return true;
    },

    setTitle(next: string) {
      if (destroyed || failClosed || !isWritable(options.writable)) return false;
      validateTitle(next);
      const current = roots.title.toString();
      if (current === next) return true;

      const prefixLength = commonPrefixLength(current, next);
      const suffixLength = commonSuffixLength(current, next, prefixLength);
      options.document.transact(() => {
        const deleteLength = current.length - prefixLength - suffixLength;
        if (deleteLength > 0) roots.title.delete(prefixLength, deleteLength);
        const insertion = next.slice(prefixLength, next.length - suffixLength);
        if (insertion.length > 0) roots.title.insert(prefixLength, insertion);
      }, FIELD_STORE_ORIGIN);
      return true;
    },

    subscribeMetadata(listener: () => void) {
      if (destroyed) return NOOP;
      metadataListeners.add(listener);
      return () => {
        metadataListeners.delete(listener);
      };
    },

    subscribeTitle(listener: () => void) {
      if (destroyed) return NOOP;
      titleListeners.add(listener);
      return () => {
        titleListeners.delete(listener);
      };
    },
  };
}

const FIELD_STORE_ORIGIN = Symbol("collaboration-field-store");
const NOOP = () => undefined;

function acquireRoots(document: Y.Doc): {
  metadata: Y.Map<unknown>;
  title: Y.Text;
} | undefined {
  const existingMetadata = document.share.get(COLLABORATION_METADATA_NAME);
  const existingTitle = document.share.get(COLLABORATION_TITLE_NAME);
  if (
    !isCompatibleRoot(existingMetadata, Y.Map)
    || !isCompatibleRoot(existingTitle, Y.Text)
  ) {
    return undefined;
  }
  try {
    return {
      metadata: document.getMap(COLLABORATION_METADATA_NAME),
      title: document.getText(COLLABORATION_TITLE_NAME),
    };
  } catch {
    return undefined;
  }
}

function isCompatibleRoot(
  root: SharedRoot | undefined,
  expectedConstructor: typeof Y.Map | typeof Y.Text,
) {
  return !root || root.constructor === Y.AbstractType || root.constructor === expectedConstructor;
}

function transactionChangedRoot(transaction: Y.Transaction, root: object) {
  for (const changedRoot of transaction.changedParentTypes.keys()) {
    if (changedRoot === root) return true;
  }
  return false;
}

function readTitle(title: Y.Text, options: { allowPreSyncEmpty?: boolean } = {}) {
  let value: string;
  try {
    value = title.toString();
  } catch {
    throw new YjsFieldStoreError("shared_type_mismatch");
  }
  if (!(options.allowPreSyncEmpty && value.length === 0)) validateTitle(value);
  return value;
}

function validateTitle(title: unknown): asserts title is string {
  if (
    typeof title !== "string"
    || title.trim().length === 0
    || title.length > COLLABORATION_TITLE_MAX_LENGTH
    || hasUnpairedSurrogate(title)
  ) {
    throw new YjsFieldStoreError("title_invalid");
  }
}

function readMetadata(metadata: Y.Map<unknown>, profile: ProjectProfile): Readonly<DocumentMetadata> {
  const candidate: DocumentMetadata = {};
  try {
    for (const [key, value] of metadata.entries()) {
      if (!isMetadataValue(value)) throw new YjsFieldStoreError("metadata_invalid");
      candidate[key] = cloneMetadataValue(value);
    }
  } catch (error) {
    if (error instanceof YjsFieldStoreError) throw error;
    throw new YjsFieldStoreError("shared_type_mismatch");
  }

  const validation = validateProjectMetadata(profile, candidate, {}, { enforceRequired: false });
  if (!validation.ok) throw new YjsFieldStoreError("metadata_invalid");
  return freezeMetadata(validation.value);
}

function isMetadataValue(value: unknown): value is DocumentMetadataValue {
  return value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "string"
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function freezeMetadata(metadata: DocumentMetadata): Readonly<DocumentMetadata> {
  const snapshot: DocumentMetadata = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value !== undefined) {
      if (Array.isArray(value)) {
        const clone = [...value];
        Object.freeze(clone);
        snapshot[key] = clone;
      } else {
        snapshot[key] = value;
      }
    }
  }
  return Object.freeze(snapshot);
}

function cloneMetadata(metadata: Readonly<DocumentMetadata>): DocumentMetadata {
  const clone: DocumentMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    clone[key] = cloneMetadataValue(value);
  }
  return clone;
}

function cloneMetadataValue(value: DocumentMetadataValue): DocumentMetadataValue {
  return Array.isArray(value) ? [...value] : value;
}

function metadataEqual(left: Readonly<DocumentMetadata>, right: Readonly<DocumentMetadata>) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry?.[0] === key && metadataValueEqual(value, rightEntry[1]);
    });
}

function metadataValueEqual(
  left: DocumentMetadataValue | undefined,
  right: DocumentMetadataValue | undefined,
) {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((item, index) => item === right[index])
    : left === right;
}

function commonPrefixLength(left: string, right: string) {
  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const maximum = Math.min(leftCodePoints.length, rightCodePoints.length);
  let codeUnitLength = 0;
  for (let index = 0; index < maximum; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) break;
    codeUnitLength += leftCodePoints[index]!.length;
  }
  return codeUnitLength;
}

function commonSuffixLength(left: string, right: string, prefixLength: number) {
  const leftCodePoints = Array.from(left.slice(prefixLength));
  const rightCodePoints = Array.from(right.slice(prefixLength));
  const maximum = Math.min(leftCodePoints.length, rightCodePoints.length);
  let codeUnitLength = 0;
  for (let offset = 1; offset <= maximum; offset += 1) {
    const leftCodePoint = leftCodePoints.at(-offset);
    if (leftCodePoint !== rightCodePoints.at(-offset)) break;
    codeUnitLength += leftCodePoint!.length;
  }
  return codeUnitLength;
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isWritable(writable: () => boolean) {
  try {
    return writable() === true;
  } catch {
    return false;
  }
}

function publish(listeners: ReadonlySet<() => void>) {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A consumer must not break Yjs transaction cleanup or other listeners.
    }
  }
}
