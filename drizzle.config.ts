import { defineConfig } from "drizzle-kit";
import { resolveDatabaseCredentials } from "./src/db/url";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: resolveDatabaseCredentials(),
});
