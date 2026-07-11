import { assertProductionAuthConfigured } from "../src/features/auth/production-auth-config.mjs";

const env = process.argv.includes("--production")
  ? { ...process.env, NODE_ENV: "production" }
  : process.env;

assertProductionAuthConfigured(env);
