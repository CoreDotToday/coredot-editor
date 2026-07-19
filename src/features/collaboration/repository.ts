import { db } from "@/db/client";
import { retrySqliteContention } from "@/db/sqlite-contention";

export type CollaborationDatabase = typeof db;
export type CollaborationTransaction = Parameters<
  Parameters<CollaborationDatabase["transaction"]>[0]
>[0];

export function createCollaborationRepository(database: CollaborationDatabase = db) {
  return {
    database,
    read<T>(operation: (transaction: CollaborationTransaction) => Promise<T>) {
      return retrySqliteContention(() => database.transaction(operation));
    },
    write<T>(operation: (transaction: CollaborationTransaction) => Promise<T>) {
      return retrySqliteContention(() => database.transaction(operation, { behavior: "immediate" }));
    },
  };
}
