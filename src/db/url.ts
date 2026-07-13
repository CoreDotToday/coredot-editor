import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type DatabaseEnvironment = {
  readonly [key: string]: string | undefined;
  DATABASE_AUTH_TOKEN?: string;
  DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
};

export type DatabaseCredentials = {
  authToken?: string;
  url: string;
};

function normalizeDatabaseUrl(databaseUrl: string | undefined, appRoot: string) {
  const url = databaseUrl ?? "file:./data/coredot.db";

  if (!url.startsWith("file:")) {
    return url;
  }

  const filePath = url.slice("file:".length);

  if (filePath.startsWith("//") || isAbsolute(filePath)) {
    return url;
  }

  return `file:${resolve(appRoot, filePath)}`;
}

export function resolveDatabaseUrl(databaseUrl = process.env.DATABASE_URL, appRoot = APP_ROOT) {
  return normalizeDatabaseUrl(databaseUrl, appRoot);
}

export function getDatabaseUrl() {
  return resolveDatabaseUrl();
}

export function resolveDatabaseCredentials(
  env: DatabaseEnvironment = process.env,
  appRoot = APP_ROOT,
): DatabaseCredentials {
  const authToken =
    env.DATABASE_AUTH_TOKEN?.trim() || env.TURSO_AUTH_TOKEN?.trim();
  const credentials: DatabaseCredentials = {
    url: normalizeDatabaseUrl(env.DATABASE_URL, appRoot),
  };

  if (authToken) {
    credentials.authToken = authToken;
  }

  return credentials;
}
