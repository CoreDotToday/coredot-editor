import type { WorkspaceScope } from "@/features/auth/request-context";

const documentWriteTails = new Map<string, Promise<void>>();

/** Serialize same-process writes for one workspace document; SQLite retry handles cross-process contention. */
export async function withSerializedDocumentWrite<T>(
  scope: WorkspaceScope,
  documentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${scope.workspaceId}\u0000${documentId}`;
  const previous = documentWriteTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  documentWriteTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (documentWriteTails.get(key) === tail) {
      documentWriteTails.delete(key);
    }
  }
}
