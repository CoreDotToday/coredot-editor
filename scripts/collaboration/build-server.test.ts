// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCollaborationServer } from "./build-server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("collaboration server artifact", () => {
  it("bundles the production entry point as a Node 22 ESM artifact", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "coredot-collaboration-build-"));
    temporaryDirectories.push(directory);
    const outfile = resolve(directory, "server.mjs");

    await expect(buildCollaborationServer({ outfile, root: process.cwd() })).resolves.toBe(outfile);

    const artifact = await readFile(outfile, "utf8");
    expect(artifact).toContain("Collaboration sidecar failed to start");
    expect(artifact).toContain("createCollaborationSidecar");
    expect(artifact).not.toMatch(/(?:import|require\()[^\n]*["']server-only["']/);
  });
});
