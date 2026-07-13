import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { configureLocalSqliteRuntime, gateSqliteClientUntilReady } from "./sqlite-runtime";
import { getDatabaseUrl } from "./url";

const url = getDatabaseUrl();

const rawSqliteClient = createClient({ url });
const sqliteRuntimeReady = configureLocalSqliteRuntime(rawSqliteClient, url);
export const sqliteClient = gateSqliteClientUntilReady(rawSqliteClient, sqliteRuntimeReady);
export const db = drizzle(sqliteClient, { schema });
