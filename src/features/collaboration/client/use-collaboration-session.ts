"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";

import type { ProjectProfile } from "@/features/projects/project-profile";

import {
  createHocuspocusProviderAdapter,
  type CollaborationCapability,
  type CollaborationSession,
} from "./hocuspocus-provider-adapter";
import {
  createCollaborationSessionStore,
  type CollaborationSessionSnapshot,
} from "./session-store";
import { createBrowserCollaborationSchemaFingerprint } from "./schema-fingerprint";
import { deferCollaborationResourceCleanup } from "./deferred-resource-cleanup";

export type CollaborationSessionConfiguration = {
  currentPrincipalId: string;
  documentId: string;
  projectProfile: ProjectProfile;
  room: string;
  schemaFingerprint: string;
  websocketUrl: string | null;
};

export type CollaborationSessionHookDependencies = {
  createDocument(): Y.Doc;
  createSession: typeof createHocuspocusProviderAdapter;
  createStore: typeof createCollaborationSessionStore;
  fetch: typeof globalThis.fetch;
  fingerprintSchema(projectProfile: ProjectProfile): Promise<string>;
};

const defaultDependencies: CollaborationSessionHookDependencies = {
  createDocument: () => new Y.Doc(),
  createSession: createHocuspocusProviderAdapter,
  createStore: createCollaborationSessionStore,
  fetch: (...args) => globalThis.fetch(...args),
  fingerprintSchema: createBrowserCollaborationSchemaFingerprint,
};

type CollaborationSessionResources = {
  abortRequests(): void;
  document: Y.Doc;
  identity: string;
  session: CollaborationSession | null;
  store: ReturnType<typeof createCollaborationSessionStore>;
};

// This store has no external resources. It supplies a stable pre-commit
// snapshot until the effect-owned Y.Doc/provider pair is installed.
const pendingSessionStore = createCollaborationSessionStore();

export function useCollaborationSession(
  configuration: CollaborationSessionConfiguration,
  dependencies: CollaborationSessionHookDependencies = defaultDependencies,
): {
  session: CollaborationSession | null;
  snapshot: CollaborationSessionSnapshot;
} {
  const identity = createConfigurationIdentity(configuration);
  const [resources, setResources] = useState<CollaborationSessionResources | null>(null);

  useEffect(() => {
    let active = true;
    let ownedResources: CollaborationSessionResources | null = null;

    const installResources = (
      document: Y.Doc,
      store: ReturnType<typeof createCollaborationSessionStore>,
      session: CollaborationSession | null,
      requestControllers: Set<AbortController> = new Set(),
    ) => {
      const nextResources: CollaborationSessionResources = {
        abortRequests() {
          for (const controller of requestControllers) controller.abort();
          requestControllers.clear();
        },
        document,
        identity,
        session,
        store,
      };
      if (!active) {
        destroyResources(nextResources);
        return;
      }
      ownedResources = nextResources;
      setResources(nextResources);
      void session?.connect().catch(() => undefined);
    };

    void (async () => {
      let browserFingerprint: string;
      try {
        browserFingerprint = await dependencies.fingerprintSchema(configuration.projectProfile);
      } catch {
        if (!active) return;
        installResources(dependencies.createDocument(), createFatalStore(dependencies), null);
        return;
      }
      if (!active) return;

      const document = dependencies.createDocument();
      let store: ReturnType<typeof createCollaborationSessionStore>;
      try {
        store = dependencies.createStore();
      } catch {
        installResources(document, createFatalStore(), null);
        return;
      }
      if (browserFingerprint !== configuration.schemaFingerprint) {
        store.markSchemaIncompatible();
        installResources(document, store, null);
        return;
      }
      if (!configuration.websocketUrl) {
        store.markFatal();
        installResources(document, store, null);
        return;
      }

      const requestControllers = new Set<AbortController>();
      const issueCapability = async (): Promise<CollaborationCapability> => {
        const controller = new AbortController();
        requestControllers.add(controller);
        try {
          for (let attempt = 1; ; attempt += 1) {
            const response = await dependencies.fetch(
              `/api/documents/${encodeURIComponent(configuration.documentId)}/collaboration-capability`,
              {
                cache: "no-store",
                method: "POST",
                signal: controller.signal,
              },
            );
            if (response.ok) return await response.json() as CollaborationCapability;
            // The issuer answers transient persistence contention with a
            // retryable 503 + Retry-After; honor it a bounded number of times
            // so one busy write does not degrade the session permanently.
            if (response.status !== 503 || attempt >= CAPABILITY_ISSUE_ATTEMPTS) {
              throw new Error("Collaboration capability unavailable");
            }
            await abortableDelay(readRetryAfterMs(response), controller.signal);
          }
        } finally {
          requestControllers.delete(controller);
        }
      };

      let session: CollaborationSession;
      try {
        session = dependencies.createSession({
          document,
          issueCapability,
          room: configuration.room,
          store,
          url: configuration.websocketUrl,
        });
      } catch {
        store.markFatal();
        installResources(document, store, null, requestControllers);
        return;
      }
      installResources(document, store, session, requestControllers);
    })();

    return () => {
      active = false;
      const resourcesToDestroy = ownedResources;
      if (resourcesToDestroy) {
        deferCollaborationResourceCleanup({
          cleanup: () => destroyResources(resourcesToDestroy),
          onTimeout: () => console.warn("Collaboration cleanup timed out"),
          store: resourcesToDestroy.store,
        });
      }
    };
  }, [
    configuration.currentPrincipalId,
    configuration.documentId,
    configuration.projectProfile,
    configuration.room,
    configuration.schemaFingerprint,
    configuration.websocketUrl,
    dependencies,
    identity,
  ]);

  const activeResources = resources?.identity === identity ? resources : null;
  const activeStore = activeResources?.store ?? pendingSessionStore;

  const snapshot = useSyncExternalStore(
    activeStore.subscribe,
    activeStore.getSnapshot,
    activeStore.getSnapshot,
  );

  return { session: activeResources?.session ?? null, snapshot };
}

function createFatalStore(
  dependencies?: Pick<CollaborationSessionHookDependencies, "createStore">,
) {
  let store: ReturnType<typeof createCollaborationSessionStore>;
  try {
    store = dependencies?.createStore() ?? createCollaborationSessionStore();
  } catch {
    store = createCollaborationSessionStore();
  }
  store.markFatal();
  return store;
}

const CAPABILITY_ISSUE_ATTEMPTS = 3;
const DEFAULT_CAPABILITY_RETRY_DELAY_MS = 300;
const MAX_CAPABILITY_RETRY_DELAY_MS = 2000;

function readRetryAfterMs(response: Response) {
  const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0) {
    return DEFAULT_CAPABILITY_RETRY_DELAY_MS;
  }
  return Math.min(retryAfterSeconds * 1000, MAX_CAPABILITY_RETRY_DELAY_MS);
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Collaboration capability request aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Collaboration capability request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createConfigurationIdentity(configuration: CollaborationSessionConfiguration) {
  return JSON.stringify([
    configuration.currentPrincipalId,
    configuration.documentId,
    configuration.room,
    configuration.schemaFingerprint,
    configuration.websocketUrl,
    configuration.projectProfile,
  ]);
}

function destroyResources(resources: CollaborationSessionResources) {
  try {
    resources.abortRequests();
  } catch {
    // Cleanup remains best-effort across independent resources.
  }
  try {
    resources.session?.destroy();
  } catch {
    // The Y.Doc must still be released if provider teardown fails.
  }
  try {
    resources.document.destroy();
  } catch {
    // React effect cleanup must not surface teardown-only failures.
  }
}
