import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { getDatabaseUrl } from "./url";

const url = getDatabaseUrl();

export const sqliteClient = createClient({ url });
export const db = drizzle(sqliteClient, { schema });
