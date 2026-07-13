import { retrySqliteContention } from "./sqlite-contention";

const SQLITE_OPERATION_METHODS = new Set(["batch", "execute", "executeMultiple", "migrate", "sync", "transaction"]);

type SqliteRuntimeClient = {
  execute(statement: string): Promise<unknown>;
};

export async function configureLocalSqliteRuntime(client: SqliteRuntimeClient, databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) {
    return;
  }

  await retrySqliteContention(() => client.execute("PRAGMA journal_mode = WAL"));
  await retrySqliteContention(() => client.execute("PRAGMA busy_timeout = 250"));
}

/** Gate every asynchronous database operation without requiring top-level await in CJS entry points. */
export function gateSqliteClientUntilReady<TClient extends object>(client: TClient, ready: Promise<unknown>): TClient {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;

      const method = value as (...args: unknown[]) => unknown;
      if (!SQLITE_OPERATION_METHODS.has(String(property))) {
        return method.bind(target);
      }

      return async (...args: unknown[]) => {
        await ready;
        return method.apply(target, args);
      };
    },
  });
}
