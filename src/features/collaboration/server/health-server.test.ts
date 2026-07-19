// @vitest-environment node

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCollaborationHealthController } from "./health-server";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
});

describe("collaboration sidecar health", () => {
  it("keeps liveness up while readiness reflects every bounded dependency", async () => {
    const database = vi.fn(async () => true);
    const migration = vi.fn(async () => true);
    const workers = vi.fn(async () => true);
    const fixture = await listenHealth({ database, migration, workers });

    await expect(fetch(`${fixture.url}/live`).then(responseShape))
      .resolves.toEqual({ body: { status: "live" }, status: 200 });
    await expect(fetch(`${fixture.url}/ready`).then(responseShape))
      .resolves.toEqual({ body: { status: "ready" }, status: 200 });
    expect(database).toHaveBeenCalledOnce();
    expect(migration).toHaveBeenCalledOnce();
    expect(workers).toHaveBeenCalledOnce();
  });

  it("becomes not-ready before drain while remaining live", async () => {
    const fixture = await listenHealth({
      database: async () => true,
      migration: async () => true,
      workers: async () => true,
    });

    fixture.controller.beginDrain();

    expect((await fetch(`${fixture.url}/ready`)).status).toBe(503);
    expect((await fetch(`${fixture.url}/live`)).status).toBe(200);
  });

  it("rechecks draining after an in-flight readiness probe resolves", async () => {
    const probe = deferred<boolean>();
    const database = vi.fn(() => probe.promise);
    const fixture = await listenHealth({
      database,
      migration: async () => true,
      workers: async () => true,
    });

    const readiness = fetch(`${fixture.url}/ready`);
    await vi.waitFor(() => expect(database).toHaveBeenCalledOnce());
    fixture.controller.beginDrain();
    probe.resolve(true);

    expect((await readiness).status).toBe(503);
  });

  it("fails readiness closed for false, rejection, or a timed-out probe without details", async () => {
    const fixture = await listenHealth({
      database: async () => new Promise<boolean>(() => undefined),
      migration: async () => {
        throw new Error("migration secret");
      },
      workers: async () => false,
    }, 10);

    const response = await fetch(`${fixture.url}/ready`).then(responseShape);

    expect(response).toEqual({ body: { status: "not_ready" }, status: 503 });
    expect(JSON.stringify(response)).not.toContain("migration secret");
  });
});

async function listenHealth(
  checks: Parameters<typeof createCollaborationHealthController>[0]["checks"],
  checkTimeoutMs?: number,
) {
  const controller = createCollaborationHealthController({ checks, checkTimeoutMs });
  const server = createServer(async (request, response) => {
    if (!await controller.handle(request, response)) {
      response.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { controller, url: `http://127.0.0.1:${address.port}` };
}

async function responseShape(response: Response) {
  return { body: await response.json(), status: response.status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
