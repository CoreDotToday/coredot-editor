import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { configureLocalSqliteRuntime, gateSqliteClientUntilReady } from "./sqlite-runtime";
import { resolveDatabaseCredentials } from "./url";

const databaseCredentials = resolveDatabaseCredentials();

const rawSqliteClient = createClient(databaseCredentials);
const sqliteRuntimeReady = configureLocalSqliteRuntime(
  rawSqliteClient,
  databaseCredentials.url,
);
export const sqliteClient = gateSqliteClientUntilReady(rawSqliteClient, sqliteRuntimeReady);
export const db = drizzle(sqliteClient, { schema });
