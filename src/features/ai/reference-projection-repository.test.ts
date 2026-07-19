import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";

import { createAiReferenceProjectionRepository } from "./reference-projection-repository";

const scope = { workspaceId: "workspace_a" };

describe("AI reference projection repository", () => {
  it("queries document text and current collaboration projection diagnostics in one fenced read", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.executeMultiple(`
        CREATE TABLE documents (
          id text NOT NULL,
          workspace_id text NOT NULL,
          title text NOT NULL,
          plain_text text NOT NULL,
          status text NOT NULL,
          PRIMARY KEY (workspace_id, id)
        );
        CREATE TABLE collaboration_documents (
          workspace_id text NOT NULL,
          document_id text NOT NULL,
          generation integer NOT NULL,
          is_current integer NOT NULL,
          head_seq integer NOT NULL,
          projected_seq integer NOT NULL,
          PRIMARY KEY (workspace_id, document_id, generation)
        );
        INSERT INTO documents VALUES ('doc_a', 'workspace_a', 'A title', 'A', 'draft');
        INSERT INTO documents VALUES ('doc_b', 'workspace_a', 'B title', 'B', 'draft');
        INSERT INTO documents VALUES ('doc_other', 'workspace_b', 'Other', 'Other', 'draft');
        INSERT INTO collaboration_documents VALUES ('workspace_a', 'doc_b', 3, 1, 12, 10);
        INSERT INTO collaboration_documents VALUES ('workspace_a', 'doc_b', 2, 0, 7, 7);
        INSERT INTO collaboration_documents VALUES ('workspace_b', 'doc_other', 9, 1, 30, 30);
      `);
      const database = drizzle(client, { schema });
      const repository = createAiReferenceProjectionRepository(database);

      const result = await repository(scope, ["doc_a", "doc_b", "doc_a", "doc_other"]);

      expect(result).toEqual([{
        generation: null,
        headSeq: null,
        id: "doc_a",
        plainText: "A",
        projectedSeq: null,
        title: "A title",
      }, {
        generation: 3,
        headSeq: 12,
        id: "doc_b",
        plainText: "B",
        projectedSeq: 10,
        title: "B title",
      }]);
    } finally {
      client.close();
    }
  });

  it("returns no rows without accessing the database for an empty id set", async () => {
    const select = vi.fn();
    const repository = createAiReferenceProjectionRepository({ select } as never);

    await expect(repository(scope, [])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
