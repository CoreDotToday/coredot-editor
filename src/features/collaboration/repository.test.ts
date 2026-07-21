import { describe, expect, it, vi } from "vitest";

import { createCollaborationRepository } from "./repository";

describe("CollaborationRepository raw libSQL transactions", () => {
  it("serializes write transaction acquisition across concurrent collaboration repositories", async () => {
    let active = false;
    let transactionNumber = 0;
    const rawClient = {
      transaction: vi.fn(async () => {
        if (active) throw new Error("client already has an active write transaction");
        active = true;
        transactionNumber += 1;
        const rawTransaction = createRawTransaction();
        rawTransaction.commit.mockImplementation(async () => {
          active = false;
        });
        return rawTransaction;
      }),
    };
    const firstRepository = createCollaborationRepository({ $client: rawClient } as never);
    const secondRepository = createCollaborationRepository({ $client: rawClient } as never);

    const results = await Promise.all([
      firstRepository.write(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "first";
      }),
      secondRepository.write(async () => "second"),
    ]);

    expect(results).toEqual(["first", "second"]);
    expect(transactionNumber).toBe(2);
    expect(rawClient.transaction).toHaveBeenNthCalledWith(1, "write");
    expect(rawClient.transaction).toHaveBeenNthCalledWith(2, "write");
  });

  it("does not serialize write transactions belonging to different raw clients", async () => {
    const firstTransaction = createRawTransaction();
    const secondTransaction = createRawTransaction();
    const firstRepository = createCollaborationRepository({
      $client: { transaction: vi.fn(async () => firstTransaction) },
    } as never);
    const secondRepository = createCollaborationRepository({
      $client: { transaction: vi.fn(async () => secondTransaction) },
    } as never);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = false;
    let secondEntered = false;

    const first = firstRepository.write(async () => {
      firstEntered = true;
      await firstBlocked;
      return "first";
    });
    await vi.waitFor(() => expect(firstEntered).toBe(true));
    const second = secondRepository.write(async () => {
      secondEntered = true;
      return "second";
    });
    await vi.waitFor(() => expect(secondEntered).toBe(true));
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });


  it.each([
    ["read", "read"],
    ["write", "write"],
  ] as const)("passes the exact %s mode and commits the raw transaction", async (method, mode) => {
    const rawTransaction = createRawTransaction();
    const rawClient = {
      transaction: vi.fn(async () => rawTransaction),
    };
    const databaseTransaction = vi.fn(() => Promise.reject(new Error("Drizzle transaction must not run")));
    const repository = createCollaborationRepository({
      $client: rawClient,
      transaction: databaseTransaction,
    } as never);

    const result = await repository[method](async (transactionalDatabase) => {
      expect(transactionalDatabase.$client).toBe(rawTransaction);
      return `${method}-result`;
    });

    expect(result).toBe(`${method}-result`);
    expect(rawClient.transaction).toHaveBeenCalledTimes(1);
    expect(rawClient.transaction).toHaveBeenCalledWith(mode);
    expect(rawTransaction.commit).toHaveBeenCalledTimes(1);
    expect(rawTransaction.rollback).not.toHaveBeenCalled();
    expect(rawTransaction.close).toHaveBeenCalledTimes(1);
    expect(databaseTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and closes when the callback fails", async () => {
    const rawTransaction = createRawTransaction();
    const rawClient = {
      transaction: vi.fn(async () => rawTransaction),
    };
    const repository = createCollaborationRepository({
      $client: rawClient,
    } as never);
    const failure = new Error("operation failed");

    await expect(repository.write(async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(rawTransaction.commit).not.toHaveBeenCalled();
    expect(rawTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(rawTransaction.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back without committing when a callback throws undefined", async () => {
    const rawTransaction = createRawTransaction();
    const repository = createCollaborationRepository({
      $client: { transaction: vi.fn(async () => rawTransaction) },
    } as never);

    const result = await Promise.allSettled([
      repository.write(async () => {
        throw undefined;
      }),
    ]);

    expect(result[0]?.status).toBe("rejected");
    expect(rawTransaction.commit).not.toHaveBeenCalled();
    expect(rawTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(rawTransaction.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back and closes when commit fails", async () => {
    const rawTransaction = createRawTransaction();
    rawTransaction.commit.mockRejectedValueOnce(new Error("commit failed"));
    const repository = createCollaborationRepository({
      $client: { transaction: vi.fn(async () => rawTransaction) },
    } as never);

    await expect(repository.write(async () => "result")).rejects.toThrow(
      "Collaboration transaction commit outcome is unknown",
    );

    expect(rawTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(rawTransaction.close).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous commit failure", async () => {
    const rawClient = {
      transaction: vi.fn(async () => {
        const rawTransaction = createRawTransaction();
        rawTransaction.commit.mockRejectedValue(Object.assign(new Error("commit busy"), {
          code: "SQLITE_BUSY",
        }));
        return rawTransaction;
      }),
    };
    const repository = createCollaborationRepository({ $client: rawClient } as never);

    await expect(repository.write(async () => "result")).rejects.toThrow(
      "Collaboration transaction commit outcome is unknown",
    );

    expect(rawClient.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry a close failure after a successful commit", async () => {
    const rawClient = {
      transaction: vi.fn(async () => {
        const rawTransaction = createRawTransaction();
        rawTransaction.close.mockImplementation(() => {
          throw Object.assign(new Error("close busy"), { code: "SQLITE_BUSY" });
        });
        return rawTransaction;
      }),
    };
    const repository = createCollaborationRepository({ $client: rawClient } as never);

    await expect(repository.write(async () => "result")).rejects.toThrow(
      "Collaboration transaction close failed",
    );

    expect(rawClient.transaction).toHaveBeenCalledTimes(1);
  });

  it("preserves the operation failure when rollback and close also fail", async () => {
    const operationFailure = new Error("operation failed");
    const rollbackFailure = new Error("rollback failed");
    const closeFailure = new Error("close failed");
    const rawTransaction = createRawTransaction();
    rawTransaction.rollback.mockRejectedValue(rollbackFailure);
    rawTransaction.close.mockImplementation(() => {
      throw closeFailure;
    });
    const repository = createCollaborationRepository({
      $client: { transaction: vi.fn(async () => rawTransaction) },
    } as never);

    const failure = await captureFailure(() => repository.write(async () => {
      throw operationFailure;
    }));

    expect(failure).toBeInstanceOf(AggregateError);
    expect(flattenErrors(failure)).toEqual(expect.arrayContaining([
      operationFailure,
      rollbackFailure,
      closeFailure,
    ]));
  });
});

function createRawTransaction() {
  return {
    batch: vi.fn(),
    close: vi.fn(),
    closed: false,
    commit: vi.fn(async () => undefined),
    execute: vi.fn(),
    executeMultiple: vi.fn(),
    rollback: vi.fn(async () => undefined),
  };
}

async function captureFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}

function flattenErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(flattenErrors);
}
