import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getSchema } from "@tiptap/core";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";
import type { ProjectProfile } from "@/features/projects/project-profile";
import { RESOURCE_LIMITS } from "@/features/security/resource-policy";
import { createServerSchemaExtensions } from "@/plugins/document-schema-profile";
import type { DocumentSchemaProfile } from "@/plugins/document-schema-profile";

import {
  COLLABORATION_BODY_NAME,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_NAME,
  type CollaborationDocumentIdentity,
  type CollaborationTiptapJson,
} from "./contracts";
import {
  CollaborationCodecError,
  createCollaborationDocumentCodec,
} from "./document-codec";
import { createCollaborationRoomName, parseCollaborationRoomName } from "./room-name";

const contentJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Alpha beta" }],
    },
  ],
} satisfies CollaborationTiptapJson;

const snapshot = {
  contentJson,
  metadataJson: { owner: "  Ada  ", tags: [" one ", "two"] },
  plainText: "Alpha beta",
  title: "Shared document",
};

describe("collaboration room names", () => {
  it("round-trips percent-encoded identifiers and a positive safe generation", () => {
    const roomName = createCollaborationRoomName({
      documentId: "doc/with:delimiters 한글",
      generation: 12,
      workspaceId: "clerk:org/team one",
    });

    expect(roomName).toBe(
      "collab:v1:clerk%3Aorg%2Fteam%20one:doc%2Fwith%3Adelimiters%20%ED%95%9C%EA%B8%80:g12",
    );
    expect(parseCollaborationRoomName(roomName)).toEqual({
      documentId: "doc/with:delimiters 한글",
      generation: 12,
      workspaceId: "clerk:org/team one",
    });
  });

  it.each([
    "collab:v2:workspace:document:g1",
    "collab:v1:workspace:document:g0",
    "collab:v1:workspace:document:g01",
    "collab:v1:workspace:document:g9007199254740992",
    "collab:v1:%77orkspace:document:g1",
    "collab:v1:workspace:doc%2fpart:g1",
    "collab:v1:workspace:document:g1:tampered",
    "collab:v1::document:g1",
    "collab:v1:%ZZ:document:g1",
  ])("rejects malformed, noncanonical, or tampered room names: %s", (roomName) => {
    expect(() => parseCollaborationRoomName(roomName)).toThrowError("Invalid collaboration room name");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid generations at creation: %s",
    (generation) => {
      expect(() => createCollaborationRoomName({ documentId: "doc", generation, workspaceId: "ws" }))
        .toThrowError("Invalid collaboration room generation");
    },
  );

  it.each([
    { documentId: "x".repeat(257), workspaceId: "ws" },
    { documentId: "doc\ncontrol", workspaceId: "ws" },
    { documentId: "doc", workspaceId: "\u0000workspace" },
  ])("rejects oversized or control-character identifiers before encoding", (identity) => {
    expect(() => createCollaborationRoomName({ ...identity, generation: 1 }))
      .toThrowError("Invalid collaboration room name");
  });

  it.each([
    `collab:v1:${"w".repeat(3073)}:document:g1`,
    "collab:v1:workspace:doc%00control:g1",
    `collab:v1:workspace:${"%F0%9F%98%80".repeat(129)}:g1`,
  ])("rejects encoded and decoded room identifier resource abuse", (roomName) => {
    expect(() => parseCollaborationRoomName(roomName)).toThrowError("Invalid collaboration room name");
  });
});

describe("CollaborationDocumentCodec", () => {
  it("uses a numeric collaboration document schema version distinct from the layout id", () => {
    const identity: CollaborationDocumentIdentity = {
      generation: 1,
      schemaFingerprint: "a".repeat(64),
      schemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    };

    expect(COLLABORATION_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(identity.schemaVersion).toBeTypeOf("number");
  });

  it("bootstraps the canonical Yjs layout and materializes normalized SQL fields", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);

    expect(document.getXmlFragment(COLLABORATION_BODY_NAME).length).toBeGreaterThan(0);
    expect(document.getText(COLLABORATION_TITLE_NAME).toString()).toBe("Shared document");
    expect(Object.fromEntries(document.getMap(COLLABORATION_METADATA_NAME))).toEqual({
      owner: "Ada",
      tags: ["one", "two"],
    });
    expect(codec.materialize(document)).toEqual({
      contentJson,
      metadataJson: { owner: "Ada", tags: ["one", "two"] },
      plainText: "Alpha beta",
      title: "Shared document",
    });
  });

  it("does not mutate valid collaborative state while materializing it", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const beforeBody = document.getXmlFragment(COLLABORATION_BODY_NAME).toString();
    const beforeState = Y.encodeStateAsUpdate(document);
    const beforeStateVector = Y.encodeStateVector(document);

    expect(codec.materialize(document)).toMatchObject({ plainText: "Alpha beta" });
    expect(document.getXmlFragment(COLLABORATION_BODY_NAME).toString()).toBe(beforeBody);
    expect(Y.encodeStateAsUpdate(document)).toEqual(beforeState);
    expect(Y.encodeStateVector(document)).toEqual(beforeStateVector);
  });

  it("round-trips checkpoints into fresh documents and applies tail updates idempotently", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const stateVector = Y.encodeStateVector(document);
    const checkpoint = codec.encodeCheckpoint(document);
    const restored = codec.loadCheckpoint(checkpoint);

    expect(restored).not.toBe(document);
    expect(codec.materialize(restored)).toEqual(codec.materialize(document));

    document.transact(() => {
      document.getText(COLLABORATION_TITLE_NAME).insert(snapshot.title.length, " updated");
      document.getMap(COLLABORATION_METADATA_NAME).set("category", "plan");
    });
    const tail = Y.encodeStateAsUpdate(document, stateVector);
    Y.applyUpdate(restored, tail);
    Y.applyUpdate(restored, tail);

    expect(codec.materialize(restored)).toMatchObject({
      metadataJson: { category: "plan", owner: "Ada", tags: ["one", "two"] },
      title: "Shared document updated",
    });
    expect(Y.encodeStateAsUpdate(restored)).toEqual(Y.encodeStateAsUpdate(document));
  });

  it("merges non-overlapping concurrent metadata edits from a common checkpoint", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const initial = codec.bootstrap({ ...snapshot, metadataJson: {} });
    const checkpoint = codec.encodeCheckpoint(initial);
    const checkpointState = Y.encodeStateVector(initial);
    const clientA = codec.loadCheckpoint(checkpoint);
    const clientB = codec.loadCheckpoint(checkpoint);

    clientA.getMap(COLLABORATION_METADATA_NAME).set("owner", "Ada");
    clientB.getMap(COLLABORATION_METADATA_NAME).set("category", "research");

    const merged = codec.loadCheckpoint(checkpoint);
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(clientA, checkpointState));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(clientB, checkpointState));

    expect(codec.materialize(merged).metadataJson).toEqual({
      category: "research",
      owner: "Ada",
    });
  });

  it("returns normalized validation output without enforcing draft-required metadata", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    document.getMap(COLLABORATION_METADATA_NAME).set("owner", "  Grace  ");

    expect(codec.validate(document, getProjectProfile("default"))).toEqual({
      contentJson,
      metadataJson: { owner: "Grace", tags: ["one", "two"] },
      plainText: "Alpha beta",
      title: "Shared document",
    });
  });

  it("rejects validation with a profile different from the fingerprint profile", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);

    const failure = captureCodecFailure(() => {
      codec.validate(document, getProjectProfile("legal-review"));
    });
    expect(failure).toEqual({ ok: false, reason: "profile_mismatch" });
    expect(JSON.stringify(failure)).not.toContain("legal-review");
  });

  it("rejects a same-id profile whose collaborative metadata rules changed", () => {
    const profile = cloneProjectProfile(getProjectProfile("default"));
    const changedProfile: ProjectProfile = {
      ...cloneProjectProfile(profile),
      metadataFields: profile.metadataFields.map((field) => (
        field.id === "owner" ? { ...field, required: !field.required } : field
      )),
    };
    const codec = createCollaborationDocumentCodec(profile);
    const document = codec.bootstrap(snapshot);

    expect(captureCodecFailure(() => codec.validate(document, changedProfile))).toEqual({
      ok: false,
      reason: "profile_mismatch",
    });
    expect(createCollaborationDocumentCodec(changedProfile).fingerprint()).not.toBe(codec.fingerprint());
  });

  it("keeps validation bound to a frozen metadata contract after caller mutation", () => {
    const mutableProfile = cloneProjectProfile(getProjectProfile("default"));
    const codec = createCollaborationDocumentCodec(mutableProfile);
    const document = codec.bootstrap(snapshot);
    const ownerField = mutableProfile.metadataFields.find((field) => field.id === "owner");
    if (!ownerField) throw new Error("Expected owner field");

    ownerField.maxLength = 1;

    expect(codec.materialize(document).metadataJson.owner).toBe("Ada");
    expect(captureCodecFailure(() => codec.validate(document, mutableProfile))).toEqual({
      ok: false,
      reason: "profile_mismatch",
    });
  });

  it("captures only the Project Profile fields consumed by collaboration validation", () => {
    const base = getProjectProfile("default");
    const profile = Object.defineProperties({} as ProjectProfile, {
      defaultTemplateIds: { enumerable: true, get: () => { throw new Error("unused-default-templates"); } },
      id: { enumerable: true, value: base.id },
      labels: { enumerable: true, get: () => { throw new Error("unused-labels"); } },
      metadataFields: { enumerable: true, value: base.metadataFields },
      readiness: { enumerable: true, get: () => { throw new Error("unused-readiness"); } },
    });

    expect(() => createCollaborationDocumentCodec(profile)).not.toThrow();
  });

  it.each([
    { expected: "title_blank", title: "   " },
    { expected: "title_too_long", title: "x".repeat(501) },
  ] as const)("rejects an invalid title with the bounded reason $expected", ({ expected, title }) => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    replaceTitle(document, title);

    expect(captureCodecFailure(() => codec.validate(document, getProjectProfile("default"))))
      .toEqual({ ok: false, reason: expected });
  });

  it("checks collaborative title length before allocating its string", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    replaceTitle(document, "x".repeat(501));
    const title = document.getText(COLLABORATION_TITLE_NAME);
    Object.defineProperty(title, "toString", {
      configurable: true,
      value: () => {
        throw new Error("title-toString-should-not-run");
      },
    });

    let failure;
    try {
      failure = captureCodecFailure(() => codec.materialize(document));
    } finally {
      Reflect.deleteProperty(title, "toString");
    }
    expect(failure).toEqual({ ok: false, reason: "title_too_long" });
  });

  it("preflights metadata count, keys, and values before cloning", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const tooMany = codec.bootstrap({ ...snapshot, metadataJson: {} });
    const tooManyMetadata = tooMany.getMap(COLLABORATION_METADATA_NAME);
    for (let index = 0; index < 257; index += 1) tooManyMetadata.set(`field-${index}`, "x");
    expect(captureCodecFailure(() => codec.materialize(tooMany))).toEqual({
      ok: false,
      reason: "metadata_structure",
    });

    const badKey = codec.bootstrap({ ...snapshot, metadataJson: {} });
    badKey.getMap(COLLABORATION_METADATA_NAME).set(`owner-${"x".repeat(129)}`, "Ada");
    expect(captureCodecFailure(() => codec.materialize(badKey))).toEqual({
      ok: false,
      reason: "metadata_structure",
    });

    const oversizedValue = codec.bootstrap({ ...snapshot, metadataJson: {} });
    oversizedValue.getMap(COLLABORATION_METADATA_NAME).set("owner", "x".repeat(8_193));
    expect(captureCodecFailure(() => codec.materialize(oversizedValue))).toEqual({
      ok: false,
      reason: "metadata_structure",
    });

    const oversizedArray = codec.bootstrap({ ...snapshot, metadataJson: {} });
    oversizedArray.getMap(COLLABORATION_METADATA_NAME).set("tags", Array.from({ length: 129 }, () => "x"));
    expect(captureCodecFailure(() => codec.materialize(oversizedArray))).toEqual({
      ok: false,
      reason: "metadata_structure",
    });

    const guardedArray = codec.bootstrap({ ...snapshot, metadataJson: {} });
    const guardedMetadata = guardedArray.getMap(COLLABORATION_METADATA_NAME);
    guardedMetadata.set("tags", Array.from({ length: 129 }, () => "x"));
    const arrayThatMustNotBeScanned = guardedMetadata.get("tags");
    if (!Array.isArray(arrayThatMustNotBeScanned)) throw new Error("Expected tags array");
    Object.defineProperty(arrayThatMustNotBeScanned, 0, {
      get: () => { throw new Error("oversized-array-item-should-not-be-read"); },
    });
    expect(captureCodecFailure(() => codec.materialize(guardedArray))).toEqual({
      ok: false,
      reason: "metadata_structure",
    });
  });

  it("preflights collaborative body depth before ProseMirror conversion", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
    body.delete(0, body.length);
    const root = new Y.XmlElement("paragraph");
    let current = root;
    for (let depth = 0; depth < RESOURCE_LIMITS.documentDepth + 1; depth += 1) {
      const child = new Y.XmlElement("paragraph");
      current.insert(0, [child]);
      current = child;
    }
    body.insert(0, [root]);

    expect(captureCodecFailure(() => codec.materialize(document))).toEqual({
      limit: "documentDepth",
      ok: false,
      reason: "content_resource",
    });
  });

  it("preflights collaborative XML attribute bytes before conversion", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const paragraph = document.getXmlFragment(COLLABORATION_BODY_NAME).get(0);
    if (!(paragraph instanceof Y.XmlElement)) throw new Error("Expected paragraph element");
    paragraph.setAttribute("oversized", "x".repeat(8_193));

    expect(captureCodecFailure(() => codec.materialize(document))).toEqual({
      limit: "documentJsonBytes",
      ok: false,
      reason: "content_resource",
    });
  });

  it("accounts for pending body nodes before expanding a broad branch", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
    const pendingLeaf = body.get(0);
    if (!(pendingLeaf instanceof Y.XmlElement)) throw new Error("Expected paragraph element");
    const broadBranch = new Y.XmlElement("paragraph");
    Object.defineProperty(broadBranch, "length", {
      configurable: true,
      get: () => 50_000,
    });
    Object.defineProperty(broadBranch, "toArray", {
      configurable: true,
      value: () => {
        throw new Error("broad-branch-must-not-be-expanded");
      },
    });
    Object.defineProperty(body, "toArray", {
      configurable: true,
      value: () => [
        ...Array.from({ length: 50_001 }, () => pendingLeaf),
        broadBranch,
      ],
    });

    expect(captureCodecFailure(() => codec.materialize(document))).toEqual({
      limit: "documentNodes",
      ok: false,
      reason: "content_resource",
    });
  });

  it("bounds checkpoint bytes before invoking Yjs update decoding", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const checkpoint = new Uint8Array(RESOURCE_LIMITS.documentJsonBytes + 1);

    expect(captureCodecFailure(() => codec.loadCheckpoint(checkpoint))).toEqual({
      ok: false,
      reason: "checkpoint_invalid",
    });
  });

  it("rejects untracked documents before validation state cloning", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const tracked = codec.bootstrap(snapshot);
    const untracked = new Y.Doc();
    Y.applyUpdate(untracked, codec.encodeCheckpoint(tracked));

    expect(captureCodecFailure(() => codec.materialize(untracked))).toEqual({
      ok: false,
      reason: "checkpoint_budget",
    });
  });

  it("rejects unexpected shared roots before checkpointing or validation cloning", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    document.getMap("unpreflighted-private-root").set("secret", "must-not-be-cloned");

    expect(captureCodecFailure(() => codec.encodeCheckpoint(document))).toEqual({
      ok: false,
      reason: "shared_type_mismatch",
    });
    expect(captureCodecFailure(() => codec.materialize(document))).toEqual({
      ok: false,
      reason: "shared_type_mismatch",
    });
    expect(captureCodecFailure(() => codec.loadCheckpoint(Y.encodeStateAsUpdate(document)))).toEqual({
      ok: false,
      reason: "shared_type_mismatch",
    });
  });

  it("rejects history-heavy documents before invoking full-state encoding", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const title = document.getText(COLLABORATION_TITLE_NAME);
    const tombstoneChunk = "x".repeat(320 * 1024);
    for (let index = 0; index < 40; index += 1) {
      title.insert(title.length, tombstoneChunk);
      title.delete(title.length - tombstoneChunk.length, tombstoneChunk.length);
    }

    expect(captureCodecFailure(() => codec.encodeCheckpoint(document))).toEqual({
      ok: false,
      reason: "checkpoint_budget",
    });
    expect(captureCodecFailure(() => codec.materialize(document))).toEqual({
      ok: false,
      reason: "checkpoint_budget",
    });
  });

  it("normalizes truncated and malformed checkpoint updates", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const checkpoint = codec.encodeCheckpoint(codec.bootstrap(snapshot));
    const corruptCheckpoints = [
      checkpoint.slice(0, checkpoint.length - 1),
      Uint8Array.of(0, 1, 255, 2, 128),
    ];

    for (const corrupt of corruptCheckpoints) {
      expect(captureCodecFailure(() => codec.loadCheckpoint(corrupt))).toEqual({
        ok: false,
        reason: "checkpoint_invalid",
      });
    }
  });

  it("normalizes wrong shared root types during checkpoint load and materialization", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const wrongCheckpointDocument = new Y.Doc();
    wrongCheckpointDocument.getText(COLLABORATION_BODY_NAME).insert(0, "secret");
    expect(captureCodecFailure(() => (
      codec.loadCheckpoint(Y.encodeStateAsUpdate(wrongCheckpointDocument))
    ))).toEqual({ ok: false, reason: "shared_type_mismatch" });

    const wrongMaterializationDocument = new Y.Doc();
    wrongMaterializationDocument.getText(COLLABORATION_TITLE_NAME).insert(0, "Title");
    wrongMaterializationDocument.getText(COLLABORATION_METADATA_NAME).insert(0, "secret");
    wrongMaterializationDocument.getXmlFragment(COLLABORATION_BODY_NAME);
    expect(captureCodecFailure(() => codec.materialize(wrongMaterializationDocument))).toEqual({
      ok: false,
      reason: "shared_type_mismatch",
    });
  });

  it("rejects structurally unsafe and unknown metadata without returning raw values", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const unsafe = codec.bootstrap(snapshot);
    unsafe.getMap(COLLABORATION_METADATA_NAME).set("owner", { secret: "do-not-return" });

    expect(captureCodecFailure(() => codec.validate(unsafe, getProjectProfile("default")))).toEqual({
      fieldId: "owner",
      ok: false,
      reason: "metadata_structure",
    });
    expect(JSON.stringify(captureCodecFailure(() => codec.validate(unsafe, getProjectProfile("default")))))
      .not.toContain("do-not-return");

    const unknown = codec.bootstrap(snapshot);
    unknown.getMap(COLLABORATION_METADATA_NAME).set("privateNotes", "do-not-return");
    expect(captureCodecFailure(() => codec.validate(unknown, getProjectProfile("default")))).toEqual({
      fieldId: "privateNotes",
      metadataReason: "unknown_field",
      ok: false,
      reason: "metadata_invalid",
    });
    expect(JSON.stringify(captureCodecFailure(() => codec.validate(unknown, getProjectProfile("default")))))
      .not.toContain("do-not-return");
  });

  it("converts malformed collaborative body state into a stable typed validation failure", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const document = codec.bootstrap(snapshot);
    const body = document.getXmlFragment(COLLABORATION_BODY_NAME);
    body.delete(0, body.length);
    body.insert(0, [new Y.XmlElement("not-in-the-schema")]);

    const bodyBefore = body.toString();
    const stateBefore = Y.encodeStateAsUpdate(document);
    const stateVectorBefore = Y.encodeStateVector(document);

    for (const operation of [
      () => codec.validate(document, getProjectProfile("default")),
      () => codec.materialize(document),
    ]) {
      const failure = captureCodecFailure(operation);
      expect(failure).toEqual({ ok: false, reason: "content_schema" });
      expect(JSON.stringify(failure).length).toBeLessThan(200);
      expect(body.toString()).toBe(bodyBefore);
      expect(Y.encodeStateAsUpdate(document)).toEqual(stateBefore);
      expect(Y.encodeStateVector(document)).toEqual(stateVectorBefore);
    }
  });

  it("enforces the shared Tiptap resource policy before schema import", () => {
    const codec = createCollaborationDocumentCodec(getProjectProfile("default"));
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    const unsafeContent = {
      content: [{ attrs: { nested }, type: "paragraph" }],
      type: "doc",
    } satisfies CollaborationTiptapJson;

    let thrown: unknown;
    try {
      codec.bootstrap({ ...snapshot, contentJson: unsafeContent });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CollaborationCodecError);
    expect(thrown).toMatchObject({
      failure: { limit: "documentDepth", ok: false, reason: "content_resource" },
      message: "Collaboration document is invalid",
    });
    expect(JSON.stringify(thrown)).not.toContain("Alpha beta");
  });

  it("produces a deterministic, profile-specific SHA-256 schema fingerprint", () => {
    const defaultCodec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const sameCodec = createCollaborationDocumentCodec(getProjectProfile("default"));
    const legalCodec = createCollaborationDocumentCodec(getProjectProfile("legal-review"));

    expect(defaultCodec.fingerprint()).toMatch(/^[a-f0-9]{64}$/);
    expect(defaultCodec.fingerprint()).toBe(sameCodec.fingerprint());
    expect(defaultCodec.fingerprint()).not.toBe(legalCodec.fingerprint());

    const extensionNames = createServerSchemaExtensions().map((extension) => extension.name);
    expect(extensionNames).toEqual(["starterKit", "link", "taskList", "taskItem", "tableKit", "typography"]);
    expect(getSchema(createServerSchemaExtensions()).topNodeType.name).toBe("doc");
  });

  it("keeps the default schema fingerprint golden and distinguishes active schema profile ids", () => {
    const projectProfile = getProjectProfile("default");
    expect(createCollaborationDocumentCodec(projectProfile).fingerprint()).toBe(
      "935a25eabb51fbd27d86dc2fcbe3dd5f3e3b518ed1c25a73a0f45e1d57b7f738",
    );
    const extensions = () => createServerSchemaExtensions();
    const profileA: DocumentSchemaProfile = { extensions, id: "test.same-schema.a" };
    const profileB: DocumentSchemaProfile = { extensions, id: "test.same-schema.b" };

    expect(createCollaborationDocumentCodec(projectProfile, { schemaProfile: profileA }).fingerprint())
      .not.toBe(createCollaborationDocumentCodec(projectProfile, { schemaProfile: profileB }).fingerprint());
  });

  it("captures the active schema profile contract once at codec creation", () => {
    const projectProfile = getProjectProfile("default");
    const schemaProfile: DocumentSchemaProfile = {
      extensions: () => createServerSchemaExtensions(),
      id: "test.mutable-schema.v1",
    };
    const codec = createCollaborationDocumentCodec(projectProfile, { schemaProfile });
    const document = codec.bootstrap(snapshot);
    const fingerprint = codec.fingerprint();

    schemaProfile.id = "test.mutated-after-creation";

    expect(codec.fingerprint()).toBe(fingerprint);
    expect(codec.validate(document, projectProfile).plainText).toBe("Alpha beta");
  });

  it("keeps fingerprint construction internals private", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/collaboration/document-codec.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/export (const|function|type) Collaboration(SchemaExtension|MetadataField|ProjectProfile)/);
    expect(source).not.toContain("export function createCollaborationSchemaFingerprint");
  });

  it("binds the fingerprint to the immutable collaboration schema package descriptor", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/collaboration/document-codec.ts"),
      "utf8",
    );

    expect(source).toContain('from "./schema-package-versions"');
    expect(source).toContain("COLLABORATION_SCHEMA_PACKAGE_VERSIONS");
    expect(source).not.toContain("const TIPTAP_SCHEMA_VERSION");
    expect(createCollaborationDocumentCodec(getProjectProfile("default")).fingerprint()).not.toBe(
      "f78e27098a0889b4ec22c1e0d0ef0f55625c192808e8f9ab8849d89e6b15de99",
    );
  });
});

function replaceTitle(document: Y.Doc, title: string) {
  const sharedTitle = document.getText(COLLABORATION_TITLE_NAME);
  sharedTitle.delete(0, sharedTitle.length);
  sharedTitle.insert(0, title);
}

function captureCodecFailure(operation: () => unknown) {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof CollaborationCodecError)) {
    throw new Error("Expected CollaborationCodecError");
  }
  expect(thrown.message).toBe("Collaboration document is invalid");
  return thrown.failure;
}

function cloneProjectProfile(profile: ProjectProfile): ProjectProfile {
  return structuredClone(profile);
}
