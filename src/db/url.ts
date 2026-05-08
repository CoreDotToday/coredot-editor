import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveDatabaseUrl(databaseUrl = process.env.DATABASE_URL, appRoot = APP_ROOT) {
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

export function getDatabaseUrl() {
  return resolveDatabaseUrl();
}
