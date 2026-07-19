import { describe, expect, it, vi } from "vitest";

import {
  createDocumentWorkflowNotificationBus,
  type DocumentWorkflowNotificationEnvironment,
} from "./workflow-notification";

function createEnvironment(options: { broadcast?: boolean } = {}) {
  let broadcastListener: ((payload: unknown) => void) | null = null;
  let sameWindowListener: ((payload: unknown) => void) | null = null;
  const postMessage = vi.fn();
  const close = vi.fn();
  const unsubscribeBroadcast = vi.fn(() => {
    broadcastListener = null;
  });
  const unsubscribeSameWindow = vi.fn(() => {
    sameWindowListener = null;
  });
  const environment: DocumentWorkflowNotificationEnvironment = {
    emitSameWindow: vi.fn((payload) => sameWindowListener?.(payload)),
    openBroadcastChannel: options.broadcast === false
      ? () => null
      : () => ({
          close,
          postMessage,
          subscribe(listener) {
            broadcastListener = listener;
            return unsubscribeBroadcast;
          },
        }),
    subscribeSameWindow(listener) {
      sameWindowListener = listener;
      return unsubscribeSameWindow;
    },
  };
  return {
    close,
    emitBroadcast: (payload: unknown) => broadcastListener?.(payload),
    emitSameWindow: (payload: unknown) => sameWindowListener?.(payload),
    environment,
    postMessage,
    unsubscribeBroadcast,
    unsubscribeSameWindow,
  };
}

describe("document workflow notification bus", () => {
  it("publishes only a bounded document identity across tabs and the current window", () => {
    const harness = createEnvironment();
    const bus = createDocumentWorkflowNotificationBus({
      environment: harness.environment,
      onDocumentChanged: vi.fn(),
    });

    bus.publish("doc_1");

    expect(harness.postMessage).toHaveBeenCalledWith({ documentId: "doc_1", v: 1 });
    expect(harness.environment.emitSameWindow).toHaveBeenCalledWith({ documentId: "doc_1", v: 1 });
  });

  it("validates cross-tab and same-window payloads before exposing a document id", () => {
    const harness = createEnvironment();
    const onDocumentChanged = vi.fn();
    createDocumentWorkflowNotificationBus({ environment: harness.environment, onDocumentChanged });

    harness.emitBroadcast({ documentId: "doc_1", v: 1 });
    harness.emitSameWindow({ documentId: "doc_2", v: 1 });
    for (const invalid of [
      null,
      { documentId: "", v: 1 },
      { documentId: "doc secret", v: 1 },
      { documentId: "doc_1", readiness: "approved", v: 1 },
      { documentId: "doc_1", v: 2 },
      { documentId: "x".repeat(257), v: 1 },
    ]) {
      harness.emitBroadcast(invalid);
      harness.emitSameWindow(invalid);
    }

    expect(onDocumentChanged.mock.calls).toEqual([["doc_1"], ["doc_2"]]);
  });

  it("keeps same-window recovery when BroadcastChannel is unavailable", () => {
    const harness = createEnvironment({ broadcast: false });
    const onDocumentChanged = vi.fn();
    const bus = createDocumentWorkflowNotificationBus({
      environment: harness.environment,
      onDocumentChanged,
    });

    bus.publish("doc_1");

    expect(onDocumentChanged).toHaveBeenCalledWith("doc_1");
    expect(harness.postMessage).not.toHaveBeenCalled();
  });

  it("removes every listener and closes the channel exactly once", () => {
    const harness = createEnvironment();
    const onDocumentChanged = vi.fn();
    const bus = createDocumentWorkflowNotificationBus({
      environment: harness.environment,
      onDocumentChanged,
    });

    bus.destroy();
    bus.destroy();
    harness.emitBroadcast({ documentId: "doc_1", v: 1 });
    harness.emitSameWindow({ documentId: "doc_1", v: 1 });

    expect(harness.unsubscribeBroadcast).toHaveBeenCalledOnce();
    expect(harness.unsubscribeSameWindow).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(onDocumentChanged).not.toHaveBeenCalled();
    expect(() => bus.publish("doc_1")).toThrow("destroyed");
  });

  it("rejects invalid local document ids before either transport sees them", () => {
    const harness = createEnvironment();
    const bus = createDocumentWorkflowNotificationBus({
      environment: harness.environment,
      onDocumentChanged: vi.fn(),
    });

    expect(() => bus.publish("token like secret")).toThrow("Invalid workflow document id");
    expect(harness.postMessage).not.toHaveBeenCalled();
    expect(harness.environment.emitSameWindow).not.toHaveBeenCalled();
  });

  it("falls back to the same-window event when BroadcastChannel construction fails", () => {
    const onDocumentChanged = vi.fn();
    let sameWindowListener: ((payload: unknown) => void) | null = null;
    const environment: DocumentWorkflowNotificationEnvironment = {
      emitSameWindow(payload) {
        sameWindowListener?.(payload);
      },
      openBroadcastChannel() {
        throw new Error("BroadcastChannel denied");
      },
      subscribeSameWindow(listener) {
        sameWindowListener = listener;
        return () => {
          sameWindowListener = null;
        };
      },
    };

    const bus = createDocumentWorkflowNotificationBus({ environment, onDocumentChanged });
    expect(() => bus.publish("doc_1")).not.toThrow();
    expect(onDocumentChanged).toHaveBeenCalledWith("doc_1");
  });

  it("attempts every cleanup even when one transport teardown fails", () => {
    const unsubscribeBroadcast = vi.fn(() => {
      throw new Error("broadcast unsubscribe failed");
    });
    const unsubscribeSameWindow = vi.fn(() => {
      throw new Error("window unsubscribe failed");
    });
    const close = vi.fn(() => {
      throw new Error("channel close failed");
    });
    const bus = createDocumentWorkflowNotificationBus({
      environment: {
        emitSameWindow: vi.fn(),
        openBroadcastChannel: () => ({
          close,
          postMessage: vi.fn(),
          subscribe: () => unsubscribeBroadcast,
        }),
        subscribeSameWindow: () => unsubscribeSameWindow,
      },
      onDocumentChanged: vi.fn(),
    });

    expect(() => bus.destroy()).not.toThrow();
    expect(unsubscribeBroadcast).toHaveBeenCalledOnce();
    expect(unsubscribeSameWindow).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
