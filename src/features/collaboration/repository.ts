import type { Client, Transaction, TransactionMode } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { retrySqliteContention } from "@/db/sqlite-contention";

export type CollaborationDatabase = typeof db;
export type CollaborationTransaction = CollaborationDatabase;

export function createCollaborationRepository(database: CollaborationDatabase = db) {
  return {
    database,
    read<T>(operation: (transaction: CollaborationTransaction) => Promise<T>) {
      return runRawTransaction(database, "read", operation);
    },
    write<T>(operation: (transaction: CollaborationTransaction) => Promise<T>) {
      return runRawTransaction(database, "write", operation);
    },
  };
}

function runRawTransaction<T>(
  database: CollaborationDatabase,
  mode: TransactionMode,
  operation: (transaction: CollaborationTransaction) => Promise<T>,
) {
  return retrySqliteContention(async () => {
    const rawTransaction = await database.$client.transaction(mode);
    let failure: unknown;
    let failed = false;
    let result: T | undefined;
    try {
      const transaction = (
        drizzle(rawTransaction as unknown as Client, { schema })
      ) as unknown as CollaborationTransaction;
      result = await operation(transaction);
    } catch (error) {
      failed = true;
      failure = await rollbackAfterFailure(rawTransaction, error);
    }

    if (!failed) {
      try {
        await rawTransaction.commit();
      } catch (commitError) {
        failed = true;
        const commitFailure = new AggregateError(
          [commitError],
          "Collaboration transaction commit outcome is unknown",
        );
        failure = await rollbackAfterFailure(rawTransaction, commitFailure);
      }
    }

    try {
      rawTransaction.close();
    } catch (closeError) {
      const hadFailure = failed;
      failed = true;
      failure = new AggregateError(
        hadFailure ? [failure, closeError] : [closeError],
        "Collaboration transaction close failed",
      );
    }

    if (failed) throw failure;
    return result as T;
  });
}

async function rollbackAfterFailure(rawTransaction: Transaction, operationError: unknown) {
  if (rawTransaction.closed) return operationError;
  try {
    await rawTransaction.rollback();
    return operationError;
  } catch (rollbackError) {
    return new AggregateError(
      [operationError, rollbackError],
      "Collaboration transaction rollback failed",
    );
  }
}
