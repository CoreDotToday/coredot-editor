// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCollaborationServer,
  COLLABORATION_SERVER_ARTIFACT,
} from "./build-server";
import { smokeCollaborationServer } from "./smoke-server";

describe("collaboration server startup smoke", () => {
  it("starts the built artifact on an injected Node and exits cleanly after health checks", async () => {
    const root = process.cwd();
    const artifactPath = resolve(root, COLLABORATION_SERVER_ARTIFACT);
    await buildCollaborationServer({ outfile: artifactPath, root });

    await expect(smokeCollaborationServer({
      artifactPath,
      nodeExecutable: process.execPath,
      root,
      timeouts: {
        requestMs: 3_000,
        shutdownMs: 10_000,
        startupMs: 15_000,
      },
    })).resolves.toEqual({
      exitCode: 0,
      exitSignal: null,
      liveStatus: 200,
      readyStatus: 200,
    });
  }, 30_000);

  it("honors the injected Node executable without downloading a runtime", async () => {
    await expect(smokeCollaborationServer({
      artifactPath: resolve(process.cwd(), COLLABORATION_SERVER_ARTIFACT),
      nodeExecutable: resolve(process.cwd(), "missing-injected-node"),
      root: process.cwd(),
      timeouts: {
        requestMs: 100,
        shutdownMs: 100,
        startupMs: 100,
      },
    })).rejects.toThrow("Collaboration startup smoke failed");
  });
});
