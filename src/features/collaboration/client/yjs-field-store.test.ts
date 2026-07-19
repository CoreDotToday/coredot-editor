import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";

import {
  createYjsFieldStore,
  YjsFieldStoreError,
} from "./yjs-field-store";

const profile = getProjectProfile("default");

describe("Yjs field store", () => {
  it("can attach before the first provider sync and publish the remote title when it arrives", () => {
    const localDocument = new Y.Doc();
    const remoteDocument = createDocument("Synced title");
    const store = createYjsFieldStore({
      document: localDocument,
      projectProfile: profile,
      writable: () => false,
    });
    const listener = vi.fn();
    store.subscribeTitle(listener);

    expect(store.getTitleSnapshot()).toBe("");
    applyMissingUpdate(remoteDocument, localDocument);

    expect(store.getTitleSnapshot()).toBe("Synced title");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exposes stable immutable snapshots from the canonical title and metadata roots", () => {
    const document = createDocument("Shared document", {
      owner: "CoreDot",
      tags: ["editor", "shared"],
    });
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });

    const firstMetadata = store.getMetadataSnapshot();

    expect(store.getTitleSnapshot()).toBe("Shared document");
    expect(firstMetadata).toEqual({ owner: "CoreDot", tags: ["editor", "shared"] });
    expect(store.getMetadataSnapshot()).toBe(firstMetadata);
    expect(Object.isFrozen(firstMetadata)).toBe(true);
    expect(Object.isFrozen(firstMetadata.tags)).toBe(true);
  });

  it("updates a title with one minimal common-prefix/common-suffix edit without replacing its root", () => {
    const document = createDocument("shared-alpha-tail");
    const title = document.getText("title");
    const deltas: Y.YTextEvent["delta"][] = [];
    title.observe((event) => deltas.push(event.delta));
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });

    expect(store.setTitle("shared-BETA-tail")).toBe(true);

    expect(document.getText("title")).toBe(title);
    expect(title.toString()).toBe("shared-BETA-tail");
    expect(deltas).toEqual([[{ retain: 7 }, { delete: 5 }, { insert: "BETA" }]]);
  });

  it("converges concurrent title edits from two peers", () => {
    const [leftDocument, rightDocument] = createPeerDocuments("Shared title");
    const left = createYjsFieldStore({ document: leftDocument, projectProfile: profile, writable: () => true });
    const right = createYjsFieldStore({ document: rightDocument, projectProfile: profile, writable: () => true });

    left.setTitle("Left shared title");
    right.setTitle("Shared title right");
    exchangeUpdates(leftDocument, rightDocument);

    expect(left.getTitleSnapshot()).toBe(right.getTitleSnapshot());
    expect(leftDocument.getText("title").toString()).toBe(rightDocument.getText("title").toString());
  });

  it("preserves different metadata keys edited concurrently", () => {
    const [leftDocument, rightDocument] = createPeerDocuments("Shared title", {
      owner: "Before",
    });
    const left = createYjsFieldStore({ document: leftDocument, projectProfile: profile, writable: () => true });
    const right = createYjsFieldStore({ document: rightDocument, projectProfile: profile, writable: () => true });

    left.setMetadataField("owner", "Left owner");
    right.setMetadataField("category", "Research");
    exchangeUpdates(leftDocument, rightDocument);

    expect(left.getMetadataSnapshot()).toEqual({ category: "Research", owner: "Left owner" });
    expect(right.getMetadataSnapshot()).toEqual(left.getMetadataSnapshot());
  });

  it("converges deterministically for concurrent writes to the same metadata key", () => {
    const [leftDocument, rightDocument] = createPeerDocuments("Shared title", {
      owner: "Before",
    });
    const left = createYjsFieldStore({ document: leftDocument, projectProfile: profile, writable: () => true });
    const right = createYjsFieldStore({ document: rightDocument, projectProfile: profile, writable: () => true });

    left.setMetadataField("owner", "Left owner");
    right.setMetadataField("owner", "Right owner");
    exchangeUpdates(leftDocument, rightDocument);

    expect(left.getMetadataSnapshot()).toEqual(right.getMetadataSnapshot());
    expect(["Left owner", "Right owner"]).toContain(left.getMetadataSnapshot().owner);
  });

  it("converges a concurrent set and delete without affecting another metadata key", () => {
    const [leftDocument, rightDocument] = createPeerDocuments("Shared title", {
      category: "Keep",
      owner: "Before",
    });
    const left = createYjsFieldStore({ document: leftDocument, projectProfile: profile, writable: () => true });
    const right = createYjsFieldStore({ document: rightDocument, projectProfile: profile, writable: () => true });

    left.setMetadataField("owner", "Updated");
    right.setMetadataField("owner", undefined);
    exchangeUpdates(leftDocument, rightDocument);

    expect(left.getMetadataSnapshot()).toEqual(right.getMetadataSnapshot());
    expect(left.getMetadataSnapshot().category).toBe("Keep");
  });

  it("normalizes one metadata field and deletes empty values without rebuilding the map", () => {
    const document = createDocument("Shared title", { category: "Keep", owner: "Before" });
    const metadata = document.getMap("metadata");
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });

    expect(store.setMetadataField("owner", "  CoreDot  ")).toBe(true);
    expect(store.getMetadataSnapshot()).toEqual({ category: "Keep", owner: "CoreDot" });
    expect(document.getMap("metadata")).toBe(metadata);

    expect(store.setMetadataField("owner", "  ")).toBe(true);
    expect(store.getMetadataSnapshot()).toEqual({ category: "Keep" });
    expect(document.getMap("metadata")).toBe(metadata);
  });

  it("clones array values on write and in every published snapshot", () => {
    const document = createDocument("Shared title");
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });
    const tags = [" first ", "second"];

    store.setMetadataField("tags", tags);
    tags.push("caller mutation");
    const snapshot = store.getMetadataSnapshot();

    expect(snapshot.tags).toEqual(["first", "second"]);
    expect(document.getMap("metadata").get("tags")).not.toBe(tags);
    expect(() => (snapshot.tags as string[]).push("snapshot mutation")).toThrow();
    expect(store.getMetadataSnapshot().tags).toEqual(["first", "second"]);
  });

  it("rejects unknown and invalid fields with bounded non-content errors", () => {
    const document = createDocument("Shared title");
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });
    const unknownValue = "must-not-appear-in-an-error";

    expect(() => store.setMetadataField("unknown", unknownValue)).toThrowError(
      expect.objectContaining({ category: "metadata_invalid" }),
    );
    expect(() => store.setMetadataField("dueDate", "2026-02-31")).toThrowError(
      expect.objectContaining({ category: "metadata_invalid" }),
    );
    expect(() => store.setMetadataField("tags", Array.from({ length: 33 }, (_, index) => `${index}`)))
      .toThrowError(expect.objectContaining({ category: "metadata_invalid" }));

    try {
      store.setMetadataField("unknown", unknownValue);
    } catch (error) {
      expect(error).toBeInstanceOf(YjsFieldStoreError);
      expect((error as Error).message).toBe("Collaborative field update is invalid");
      expect((error as Error).message).not.toContain("unknown");
      expect((error as Error).message).not.toContain(unknownValue);
    }
    expect(store.getMetadataSnapshot()).toEqual({});
  });

  it("rejects blank and oversized titles without changing the Y.Text", () => {
    const document = createDocument("Shared title");
    const store = createYjsFieldStore({ document, projectProfile: profile, writable: () => true });

    expect(() => store.setTitle("   ")).toThrowError(
      expect.objectContaining({ category: "title_invalid" }),
    );
    expect(() => store.setTitle("x".repeat(501))).toThrowError(
      expect.objectContaining({ category: "title_invalid" }),
    );
    expect(store.getTitleSnapshot()).toBe("Shared title");
  });

  it("publishes remote title and metadata updates through independent subscriptions", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title", { owner: "Before" });
    const local = createYjsFieldStore({ document: localDocument, projectProfile: profile, writable: () => true });
    const remote = createYjsFieldStore({ document: remoteDocument, projectProfile: profile, writable: () => true });
    const titleListener = vi.fn();
    const metadataListener = vi.fn();
    local.subscribeTitle(titleListener);
    local.subscribeMetadata(metadataListener);

    remote.setTitle("Remote title");
    applyMissingUpdate(remoteDocument, localDocument);

    expect(titleListener).toHaveBeenCalledTimes(1);
    expect(metadataListener).not.toHaveBeenCalled();
    expect(local.getTitleSnapshot()).toBe("Remote title");

    remote.setMetadataField("owner", "Remote owner");
    applyMissingUpdate(remoteDocument, localDocument);

    expect(titleListener).toHaveBeenCalledTimes(1);
    expect(metadataListener).toHaveBeenCalledTimes(1);
    expect(local.getMetadataSnapshot()).toEqual({ owner: "Remote owner" });
  });

  it("keeps the last valid snapshot and disables writes after an invalid remote title", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title", { owner: "Before" });
    const onInvalid = vi.fn();
    const local = createYjsFieldStore({
      document: localDocument,
      onInvalid,
      projectProfile: profile,
      writable: () => true,
    });
    const listener = vi.fn();
    local.subscribeTitle(listener);
    const remoteTitle = remoteDocument.getText("title");
    remoteTitle.delete(0, remoteTitle.length);

    expect(() => applyMissingUpdate(remoteDocument, localDocument)).not.toThrow();
    expect(local.getTitleSnapshot()).toBe("Shared title");
    expect(local.getMetadataSnapshot()).toEqual({ owner: "Before" });
    expect(listener).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(local.setTitle("Blocked title")).toBe(false);
    expect(local.setMetadataField("owner", "Blocked owner")).toBe(false);

    remoteDocument.getMap("metadata").set("unknown", "another invalid update");
    expect(() => applyMissingUpdate(remoteDocument, localDocument)).not.toThrow();
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it("keeps the last valid snapshot and disables writes after invalid remote metadata", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title", { owner: "Before" });
    const local = createYjsFieldStore({ document: localDocument, projectProfile: profile, writable: () => true });
    const listener = vi.fn();
    local.subscribeMetadata(listener);
    remoteDocument.getMap("metadata").set("unknown", "remote content");

    expect(() => applyMissingUpdate(remoteDocument, localDocument)).not.toThrow();
    expect(local.getMetadataSnapshot()).toEqual({ owner: "Before" });
    expect(listener).not.toHaveBeenCalled();
    expect(local.setTitle("Blocked title")).toBe(false);
    expect(local.setMetadataField("owner", "Blocked owner")).toBe(false);
  });

  it("isolates invalid-state callback failures from Yjs transactions", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title", { owner: "Before" });
    const onInvalid = vi.fn(() => {
      throw new Error("session failure handler failed");
    });
    const local = createYjsFieldStore({
      document: localDocument,
      onInvalid,
      projectProfile: profile,
      writable: () => true,
    });
    remoteDocument.getMap("metadata").set("unknown", "remote content");

    expect(() => applyMissingUpdate(remoteDocument, localDocument)).not.toThrow();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(local.getMetadataSnapshot()).toEqual({ owner: "Before" });
    expect(local.setTitle("Blocked title")).toBe(false);
  });

  it("isolates subscriber failures while continuing to publish a valid remote snapshot", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title");
    const local = createYjsFieldStore({ document: localDocument, projectProfile: profile, writable: () => true });
    const survivor = vi.fn();
    local.subscribeTitle(() => {
      throw new Error("consumer failure");
    });
    local.subscribeTitle(survivor);
    remoteDocument.getText("title").insert(remoteDocument.getText("title").length, " updated");

    expect(() => applyMissingUpdate(remoteDocument, localDocument)).not.toThrow();
    expect(local.getTitleSnapshot()).toBe("Shared title updated");
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it("makes read-only writes explicit no-ops and evaluates writability for each call", () => {
    const document = createDocument("Shared title", { owner: "Before" });
    let writable = false;
    const store = createYjsFieldStore({
      document,
      projectProfile: profile,
      writable: () => writable,
    });

    expect(store.setTitle("Blocked title")).toBe(false);
    expect(store.setMetadataField("owner", "Blocked owner")).toBe(false);
    expect(store.getTitleSnapshot()).toBe("Shared title");
    expect(store.getMetadataSnapshot()).toEqual({ owner: "Before" });

    writable = true;
    expect(store.setTitle("Allowed title")).toBe(true);
    expect(store.setMetadataField("owner", "Allowed owner")).toBe(true);
    expect(store.getTitleSnapshot()).toBe("Allowed title");
    expect(store.getMetadataSnapshot()).toEqual({ owner: "Allowed owner" });
  });

  it("fails closed when canonical shared roots have incompatible Yjs types", () => {
    const document = new Y.Doc();
    document.getMap("title").set("value", "wrong root");

    expect(() => createYjsFieldStore({ document, projectProfile: profile, writable: () => true }))
      .toThrowError(expect.objectContaining({
        category: "shared_type_mismatch",
        message: "Collaborative field store is unavailable",
      }));
  });

  it("rejects initially invalid field content with bounded errors", () => {
    const invalidTitle = createDocument("   ");
    const invalidMetadata = createDocument("Shared title", { unknown: "document content" });

    expect(() => createYjsFieldStore({
      document: invalidTitle,
      projectProfile: profile,
      writable: () => true,
    })).toThrowError(expect.objectContaining({
      category: "title_invalid",
      message: "Collaborative field update is invalid",
    }));
    expect(() => createYjsFieldStore({
      document: invalidMetadata,
      projectProfile: profile,
      writable: () => true,
    })).toThrowError(expect.objectContaining({
      category: "metadata_invalid",
      message: "Collaborative field update is invalid",
    }));
  });

  it("cleans up observers and listeners exactly once on idempotent destroy", () => {
    const [localDocument, remoteDocument] = createPeerDocuments("Shared title", { owner: "Before" });
    const local = createYjsFieldStore({ document: localDocument, projectProfile: profile, writable: () => true });
    const remote = createYjsFieldStore({ document: remoteDocument, projectProfile: profile, writable: () => true });
    const titleListener = vi.fn();
    const metadataListener = vi.fn();
    const unsubscribeTitle = local.subscribeTitle(titleListener);
    const unsubscribeMetadata = local.subscribeMetadata(metadataListener);

    local.destroy();
    local.destroy();
    unsubscribeTitle();
    unsubscribeMetadata();
    expect(local.setTitle("Blocked after destroy")).toBe(false);
    expect(local.setMetadataField("owner", "Blocked after destroy")).toBe(false);

    remote.setTitle("Remote after destroy");
    remote.setMetadataField("owner", "Remote after destroy");
    applyMissingUpdate(remoteDocument, localDocument);

    expect(titleListener).not.toHaveBeenCalled();
    expect(metadataListener).not.toHaveBeenCalled();
    expect(local.getTitleSnapshot()).toBe("Shared title");
    expect(local.getMetadataSnapshot()).toEqual({ owner: "Before" });
  });
});

function createDocument(titleValue: string, metadataValue: Record<string, unknown> = {}) {
  const document = new Y.Doc();
  document.transact(() => {
    document.getText("title").insert(0, titleValue);
    const metadata = document.getMap("metadata");
    for (const [key, value] of Object.entries(metadataValue)) metadata.set(key, value);
  });
  return document;
}

function createPeerDocuments(title: string, metadata: Record<string, unknown> = {}) {
  const seed = createDocument(title, metadata);
  const update = Y.encodeStateAsUpdate(seed);
  const left = new Y.Doc();
  const right = new Y.Doc();
  Y.applyUpdate(left, update);
  Y.applyUpdate(right, update);
  return [left, right] as const;
}

function exchangeUpdates(left: Y.Doc, right: Y.Doc) {
  const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right));
  const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left));
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

function applyMissingUpdate(source: Y.Doc, target: Y.Doc) {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)));
}
