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

export type CollaborationSessionConfiguration = {
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
        const store = dependencies.createStore();
        store.markFatal();
        installResources(dependencies.createDocument(), store, null);
        return;
      }
      if (!active) return;

      const document = dependencies.createDocument();
      const store = dependencies.createStore();
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
          const response = await dependencies.fetch(
            `/api/documents/${encodeURIComponent(configuration.documentId)}/collaboration-capability`,
            {
              cache: "no-store",
              method: "POST",
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new Error("Collaboration capability unavailable");
          return await response.json() as CollaborationCapability;
        } finally {
          requestControllers.delete(controller);
        }
      };

      const session = dependencies.createSession({
        document,
        issueCapability,
        room: configuration.room,
        store,
        url: configuration.websocketUrl,
      });
      installResources(document, store, session, requestControllers);
    })();

    return () => {
      active = false;
      if (ownedResources) destroyResources(ownedResources);
    };
  }, [
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

function createConfigurationIdentity(configuration: CollaborationSessionConfiguration) {
  return JSON.stringify([
    configuration.documentId,
    configuration.room,
    configuration.schemaFingerprint,
    configuration.websocketUrl,
    configuration.projectProfile,
  ]);
}

function destroyResources(resources: CollaborationSessionResources) {
  resources.abortRequests();
  resources.session?.destroy();
  resources.document.destroy();
}
