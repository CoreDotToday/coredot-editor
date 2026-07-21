// @vitest-environment node

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { collaborationDocuments, documents } from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createCollaborationAuthorizationRepository } from "./authorization-repository";
import {
  createCollaborationCapabilityAuthority,
  parseCollaborationCapabilitySigningKeyRing,
} from "./capability";
import {
  createCollaborationCapabilityAuthorityTransaction,
  createCollaborationCapabilityService,
} from "./capability-service";
import { createCollaborationPersistence } from "./persistence";

const tempDirs: string[] = [];
const clients: Client[] = [];
const migrationsFolder = resolve(process.cwd(), "drizzle");
const context: RequestContext = {
  authMode: "clerk",
  principalId: "principal-a",
  requestId: "request-a",
  role: "member",
  workspaceId: "workspace-a",
};

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("collaboration capability service persistence ordering", () => {
  it("does not initialize legacy collaboration when private-key import preflight fails", async () => {
    const harness = await createHarness("signer-preflight");
    const withAuthority = vi.fn(createCollaborationCapabilityAuthorityTransaction(
      harness.persistence,
      harness.authorization,
    ));
    const malformedRing = parseCollaborationCapabilitySigningKeyRing({
      activeKid: "broken-es256",
      keys: [{
        alg: "ES256",
        kid: "broken-es256",
        privateJwk: { crv: "P-256", d: "invalid", kty: "EC", x: "invalid", y: "invalid" },
      }],
    });
    const service = createCollaborationCapabilityService({
      prepareIssue: () => createCollaborationCapabilityAuthority({
        signingKeyRing: malformedRing,
      }).prepareSigner(),
      withAuthority,
    });

    await expect(service.issue(context, { documentId: "document-a" }))
      .rejects.toMatchObject({ category: "unavailable" });
    expect(withAuthority).not.toHaveBeenCalled();
    await expect(harness.database.select().from(collaborationDocuments)).resolves.toHaveLength(0);
  });

  it("does not call a prepared signer for a real cross-Workspace document", async () => {
    const harness = await createHarness("cross-workspace-service", true);
    const preparedIssue = vi.fn(async () => "must-not-sign");
    const service = createCollaborationCapabilityService({
      prepareIssue: vi.fn(async () => preparedIssue),
      withAuthority: createCollaborationCapabilityAuthorityTransaction(
        harness.persistence,
        harness.authorization,
      ),
    });

    await expect(service.issue(context, { documentId: "document-b" }))
      .rejects.toMatchObject({ category: "not_found" });
    expect(preparedIssue).not.toHaveBeenCalled();
  });

  it("rolls back legacy initialization when the authority read fails inside the acquisition transaction", async () => {
    const harness = await createHarness("authority-read-rollback");
    const service = createCollaborationCapabilityService({
      prepareIssue: vi.fn(async () => vi.fn(async () => "must-not-sign")),
      withAuthority: createCollaborationCapabilityAuthorityTransaction(
        harness.persistence,
        {
          readCapabilityAuthorityInTransaction: vi.fn(async () => {
            throw new Error("private storage detail");
          }),
        },
      ),
    });

    await expect(service.issue(context, { documentId: "document-a" }))
      .rejects.toMatchObject({ category: "unavailable" });
    await expect(harness.database.select().from(collaborationDocuments)).resolves.toHaveLength(0);
  });

  it("rolls back legacy initialization when the prepared signer fails inside the acquisition transaction", async () => {
    const harness = await createHarness("sign-rollback");
    const privateMarker = "private-signing-detail";
    const service = createCollaborationCapabilityService({
      prepareIssue: vi.fn(async () => vi.fn(async () => {
        throw new Error(privateMarker);
      })),
      withAuthority: createCollaborationCapabilityAuthorityTransaction(
        harness.persistence,
        harness.authorization,
      ),
    });

    const failure = await captureFailure(() => service.issue(context, { documentId: "document-a" }));

    expect(failure).toMatchObject({ category: "unavailable" });
    expect(failure.message).not.toContain(privateMarker);
    await expect(harness.database.select().from(collaborationDocuments)).resolves.toHaveLength(0);
  });
});

async function captureFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}

async function createHarness(name: string, includeWorkspaceB = false) {
  const dir = await mkdtemp(join(tmpdir(), `coredot-capability-service-${name}-`));
  tempDirs.push(dir);
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  clients.push(client);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const timestamp = new Date("2026-07-19T09:00:00.000Z");
  await database.insert(documents).values({
    contentJson: { type: "doc" },
    createdAt: timestamp,
    id: "document-a",
    metadataJson: {},
    plainText: "Legacy A",
    readiness: "draft",
    revision: 0,
    status: "draft",
    title: "Document A",
    updatedAt: timestamp,
    workspaceId: "workspace-a",
  });
  if (includeWorkspaceB) {
    await database.insert(documents).values({
      contentJson: { type: "doc" },
      createdAt: timestamp,
      id: "document-b",
      metadataJson: {},
      plainText: "Legacy B",
      readiness: "draft",
      revision: 0,
      status: "draft",
      title: "Document B",
      updatedAt: timestamp,
      workspaceId: "workspace-b",
    });
  }
  return {
    authorization: createCollaborationAuthorizationRepository(database),
    database,
    persistence: createCollaborationPersistence(database),
  };
}
