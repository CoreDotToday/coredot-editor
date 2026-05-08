import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:./data/coredot.db";

export const sqliteClient = createClient({ url });
export const db = drizzle(sqliteClient, { schema });
