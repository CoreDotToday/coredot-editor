import { getSchema } from "@tiptap/core";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";
import type { ProjectProfile } from "@/features/projects/project-profile";
import { createServerSchemaExtensions } from "@/plugins/document-schema-profile";

import {
  COLLABORATION_BODY_NAME,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_METADATA_NAME,
  COLLABORATION_TITLE_NAME,
  type CollaborationDocumentIdentity,
  type CollaborationTiptapJson,
} from "./contracts";
import {
  COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS,
  CollaborationCodecError,
  createCollaborationDocumentCodec,
  createCollaborationSchemaFingerprint,
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
    expect(createCollaborationSchemaFingerprint({ projectProfile: changedProfile }))
      .not.toBe(createCollaborationSchemaFingerprint({ projectProfile: profile }));
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

    const failure = captureCodecFailure(() => codec.validate(document, getProjectProfile("default")));
    expect(failure).toEqual({ ok: false, reason: "content_schema" });
    expect(JSON.stringify(failure).length).toBeLessThan(200);
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

  it("fingerprints the numeric schema version and every ordered extension version", () => {
    expect(COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS).toEqual([
      { name: "starterKit", version: "3.27.4" },
      { name: "link", version: "3.27.4" },
      { name: "taskList", version: "3.27.4" },
      { name: "taskItem", version: "3.27.4" },
      { name: "tableKit", version: "3.27.4" },
      { name: "typography", version: "3.27.4" },
    ]);

    const projectProfile = getProjectProfile("default");
    const baseline = createCollaborationSchemaFingerprint({ projectProfile });
    const changedExtensions = COLLABORATION_SCHEMA_EXTENSION_DESCRIPTORS.map((descriptor) => (
      descriptor.name === "link" ? { ...descriptor, version: "3.27.5" } : descriptor
    ));

    expect(createCollaborationSchemaFingerprint({
      extensionDescriptors: changedExtensions,
      projectProfile,
    })).not.toBe(baseline);
    expect(createCollaborationSchemaFingerprint({
      projectProfile,
      schemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION + 1,
    })).not.toBe(baseline);
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
