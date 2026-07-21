import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { getProjectProfile } from "@/features/projects/default-project-profiles";

import { COLLABORATION_TITLE_NAME } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import { evaluateAppendCandidate, shouldRotateAppend } from "./persistence-candidate";

const projectProfile = getProjectProfile("default");

describe("collaboration append candidate evaluation", () => {
  it("rotates only when checkpoint, tail, and candidate bytes exceed the cumulative budget", () => {
    expect(shouldRotateAppend({
      checkpointBytes: 10,
      cumulativeLimitBytes: 60,
      tailBytes: 20,
      updateBytes: 30,
    })).toBe(false);
    expect(shouldRotateAppend({
      checkpointBytes: 10,
      cumulativeLimitBytes: 59,
      tailBytes: 20,
      updateBytes: 30,
    })).toBe(true);
  });

  it("classifies a true duplicate by canonical checkpoint equality", () => {
    const codec = createCollaborationDocumentCodec(projectProfile);
    const document = bootstrap(codec);
    const duplicate = Y.encodeStateAsUpdate(document);

    const evaluation = evaluateAppendCandidate({
      checkpointBytesLimit: 10 * 1024 * 1024,
      codec,
      document,
      projectProfile,
      shouldMaterializeBeforeRotation: false,
      shouldRotate: false,
      update: duplicate,
    });

    expect(evaluation.changed).toBe(false);
    expect(evaluation.candidateCheckpoint).toEqual(evaluation.preCandidateCheckpoint);
  });

  it("classifies a pending-only dependent update as changed and preserves it", () => {
    const codec = createCollaborationDocumentCodec(projectProfile);
    const document = bootstrap(codec);
    const client = codec.loadCheckpoint(codec.encodeCheckpoint(document));
    const title = client.getText(COLLABORATION_TITLE_NAME);
    const beforeFirst = Y.encodeStateVector(client);
    title.insert(title.length, "A");
    const first = Y.encodeStateAsUpdate(client, beforeFirst);
    const beforeSecond = Y.encodeStateVector(client);
    title.insert(title.length, "B");
    const second = Y.encodeStateAsUpdate(client, beforeSecond);

    const evaluation = evaluateAppendCandidate({
      checkpointBytesLimit: 10 * 1024 * 1024,
      codec,
      document,
      projectProfile,
      shouldMaterializeBeforeRotation: false,
      shouldRotate: false,
      update: second,
    });

    expect(evaluation.changed).toBe(true);
    expect(evaluation.candidateCheckpoint).not.toEqual(evaluation.preCandidateCheckpoint);
    Y.applyUpdate(evaluation.document, first);
    expect(codec.materialize(evaluation.document).title).toBe("Legacy titleAB");
  });
});

function bootstrap(codec: ReturnType<typeof createCollaborationDocumentCodec>) {
  return codec.bootstrap({
    contentJson: {
      content: [{ content: [{ text: "Legacy body", type: "text" }], type: "paragraph" }],
      type: "doc",
    },
    metadataJson: { owner: "Legacy" },
    plainText: "Legacy body",
    title: "Legacy title",
  });
}
