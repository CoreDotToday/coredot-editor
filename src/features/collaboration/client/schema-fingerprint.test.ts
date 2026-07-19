import { describe, expect, it } from "vitest";

import { createCollaborationDocumentCodec } from "../document-codec";
import { defaultProjectProfiles } from "@/features/projects/default-project-profiles";

import { createBrowserCollaborationSchemaFingerprint } from "./schema-fingerprint";

describe("browser collaboration schema fingerprint", () => {
  it.each(defaultProjectProfiles)("matches the server codec for $id", async (profile) => {
    await expect(createBrowserCollaborationSchemaFingerprint(profile)).resolves.toBe(
      createCollaborationDocumentCodec(profile).fingerprint(),
    );
  });
});
