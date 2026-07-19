import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";

export const COLLABORATION_SERVER_ARTIFACT =
  "src/features/collaboration/server/.generated/server.mjs";

const standaloneServerOnlyMarker: Plugin = {
  name: "standalone-server-only-marker",
  setup(builder) {
    builder.onResolve({ filter: /^server-only$/ }, () => ({
      namespace: "standalone-server-only-marker",
      path: "server-only",
    }));
    builder.onLoad(
      { filter: /.*/, namespace: "standalone-server-only-marker" },
      () => ({ contents: "export {};", loader: "js" }),
    );
  },
};

export async function buildCollaborationServer(options: {
  outfile?: string;
  root?: string;
} = {}) {
  const root = options.root ?? process.cwd();
  const outfile = options.outfile ?? resolve(root, COLLABORATION_SERVER_ARTIFACT);
  await rm(outfile, { force: true });
  await rm(`${outfile}.map`, { force: true });
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    bundle: true,
    entryPoints: [resolve(root, "src/features/collaboration/server/main.ts")],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    outfile,
    packages: "external",
    platform: "node",
    plugins: [standaloneServerOnlyMarker],
    sourcemap: "linked",
    sourcesContent: false,
    target: "node22",
  });
  return outfile;
}

async function main() {
  const outfile = await buildCollaborationServer();
  console.log(JSON.stringify({ artifact: outfile, status: "built", target: "node22" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error("scripts/collaboration/build-server.ts: build failed");
    process.exitCode = 1;
  });
}
