const WORKFLOW_BROADCAST_CHANNEL = "coredot-document-workflow-v1";
const WORKFLOW_SAME_WINDOW_EVENT = "coredot:document-workflow-changed:v1";
const MAX_DOCUMENT_ID_LENGTH = 256;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9._~:/-]+$/;

type DocumentWorkflowNotification = Readonly<{
  documentId: string;
  v: 1;
}>;

export type DocumentWorkflowNotificationBroadcastChannel = {
  close(): void;
  postMessage(payload: DocumentWorkflowNotification): void;
  subscribe(listener: (payload: unknown) => void): () => void;
};

export type DocumentWorkflowNotificationEnvironment = {
  emitSameWindow(payload: DocumentWorkflowNotification): void;
  openBroadcastChannel(name: string): DocumentWorkflowNotificationBroadcastChannel | null;
  subscribeSameWindow(listener: (payload: unknown) => void): () => void;
};

export function createDocumentWorkflowNotificationBus(options: {
  environment?: DocumentWorkflowNotificationEnvironment;
  onDocumentChanged(documentId: string): void;
}) {
  const environment = options.environment ?? createBrowserDocumentWorkflowNotificationEnvironment();
  let channel: DocumentWorkflowNotificationBroadcastChannel | null = null;
  try {
    channel = environment.openBroadcastChannel(WORKFLOW_BROADCAST_CHANNEL);
  } catch {
    channel = null;
  }
  let destroyed = false;
  const receive = (payload: unknown) => {
    const notification = parseNotification(payload);
    if (!notification || destroyed) return;
    options.onDocumentChanged(notification.documentId);
  };
  let unsubscribeBroadcast: () => void = () => undefined;
  try {
    unsubscribeBroadcast = channel?.subscribe(receive) ?? unsubscribeBroadcast;
  } catch {
    // Same-window delivery and recovery polling remain available.
  }
  let unsubscribeSameWindow: () => void = () => undefined;
  try {
    unsubscribeSameWindow = environment.subscribeSameWindow(receive);
  } catch {
    // Cross-tab delivery and recovery polling remain available.
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of [unsubscribeBroadcast, unsubscribeSameWindow, () => channel?.close()]) {
        try {
          cleanup();
        } catch {
          // Cleanup is best effort and each resource is attempted independently.
        }
      }
    },

    publish(documentId: string) {
      if (destroyed) throw new Error("Document workflow notification bus is destroyed");
      if (!isValidDocumentId(documentId)) throw new Error("Invalid workflow document id");
      const notification: DocumentWorkflowNotification = { documentId, v: 1 };
      try {
        channel?.postMessage(notification);
      } catch {
        // Same-window delivery and recovery polling remain available.
      }
      try {
        environment.emitSameWindow(notification);
      } catch {
        // Cross-tab delivery and recovery polling remain available.
      }
    },
  };
}

export type DocumentWorkflowNotificationBus = ReturnType<
  typeof createDocumentWorkflowNotificationBus
>;

export function createBrowserDocumentWorkflowNotificationEnvironment(): DocumentWorkflowNotificationEnvironment {
  return {
    emitSameWindow(payload) {
      if (typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent(WORKFLOW_SAME_WINDOW_EVENT, { detail: payload }));
    },

    openBroadcastChannel(name) {
      if (typeof BroadcastChannel === "undefined") return null;
      const channel = new BroadcastChannel(name);
      return {
        close() {
          channel.close();
        },
        postMessage(payload) {
          channel.postMessage(payload);
        },
        subscribe(listener) {
          const handleMessage = (event: MessageEvent<unknown>) => listener(event.data);
          channel.addEventListener("message", handleMessage);
          return () => channel.removeEventListener("message", handleMessage);
        },
      };
    },

    subscribeSameWindow(listener) {
      if (typeof window === "undefined") return () => undefined;
      const handleEvent = (event: Event) => {
        if (event instanceof CustomEvent) listener(event.detail);
      };
      window.addEventListener(WORKFLOW_SAME_WINDOW_EVENT, handleEvent);
      return () => window.removeEventListener(WORKFLOW_SAME_WINDOW_EVENT, handleEvent);
    },
  };
}

function parseNotification(value: unknown): DocumentWorkflowNotification | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("documentId") || !keys.includes("v")) return null;
  if (value.v !== 1 || !isValidDocumentId(value.documentId)) return null;
  return { documentId: value.documentId, v: 1 };
}

function isValidDocumentId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DOCUMENT_ID_LENGTH &&
    DOCUMENT_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
