import { describe, expect, it, vi } from "vitest";

import type { CollaborationSessionSnapshot } from "./session-store";
import {
  createCollaborationNavigationController,
  type CollaborationNavigationEnvironment,
} from "./navigation-controller";

describe("collaboration navigation controller", () => {
  it("keeps an own transition pending until the user confirms and explicitly continues", () => {
    const snapshot = pendingSnapshot();
    const environment = createEnvironment({ confirm: false });
    const onHandoff = vi.fn();
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: () => snapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff,
    });

    expect(controller.requestTransition()).toBeNull();
    expect(environment.confirm).toHaveBeenCalledWith("Pending collaboration update");
    expect(onHandoff).not.toHaveBeenCalled();

    environment.confirm.mockReturnValue(true);
    const permit = controller.requestTransition();
    const transition = vi.fn();
    expect(permit).not.toBeNull();
    expect(onHandoff).not.toHaveBeenCalled();

    permit?.continue(transition);
    permit?.continue(transition);
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledOnce();
  });

  it("removes its sentinel before continuing an own router transition", () => {
    const environment = createEnvironment({ confirm: true });
    const transition = vi.fn();
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: pendingSnapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff: vi.fn(),
    });
    controller.install();
    const baseState = environment.replacedStates[0];

    controller.requestTransition()?.continue(transition);
    expect(environment.history.back).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();

    environment.dispatch("popstate", new PopStateEvent("popstate", { state: baseState }));
    expect(transition).toHaveBeenCalledOnce();
  });

  it("continues an acknowledged own transition exactly once without prompting", () => {
    const environment = createEnvironment({ confirm: false });
    const transition = vi.fn();
    const controller = createCollaborationNavigationController({
      environment,
      getMessage: () => "Pending collaboration update",
      getSnapshot: acknowledgedSnapshot,
      onHandoff: vi.fn(),
    });
    controller.install();
    const baseState = environment.replacedStates[0];

    const permit = controller.requestTransition();
    permit?.continue(transition);
    permit?.continue(transition);
    expect(controller.requestTransition()).toBeNull();
    environment.dispatch("popstate", new PopStateEvent("popstate", { state: baseState }));
    environment.dispatch("popstate", new PopStateEvent("popstate", { state: null }));

    expect(environment.confirm).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledOnce();
  });

  it("uses a same-URL sentinel so canceled Back remains on the current document", () => {
    const environment = createEnvironment({ confirm: false });
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: pendingSnapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff: vi.fn(),
    });
    const uninstall = controller.install();
    const baseState = environment.replacedStates[0];

    expect(environment.replacedUrls).toEqual([environment.href]);
    expect(environment.pushedUrls).toEqual([environment.href]);

    environment.dispatch("popstate", new PopStateEvent("popstate", { state: baseState }));

    expect(environment.confirm).toHaveBeenCalledOnce();
    expect(environment.history.back).not.toHaveBeenCalled();
    expect(environment.pushedUrls).toEqual([environment.href, environment.href]);
    expect(environment.href).toBe("https://editor.example.test/documents/current");

    uninstall();
    environment.dispatch("popstate", new PopStateEvent("popstate", { state: baseState }));
    expect(environment.confirm).toHaveBeenCalledOnce();
  });

  it("hands off and continues the captured history traversal after confirmation", () => {
    const environment = createEnvironment({ confirm: true });
    const onHandoff = vi.fn();
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: pendingSnapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff,
    });
    controller.install();
    const baseState = environment.replacedStates[0];

    environment.dispatch("popstate", new PopStateEvent("popstate", { state: baseState }));

    expect(onHandoff).toHaveBeenCalledOnce();
    expect(environment.history.back).toHaveBeenCalledOnce();

    environment.dispatch("popstate", new PopStateEvent("popstate", { state: null }));
    expect(environment.confirm).toHaveBeenCalledOnce();
    expect(environment.history.back).toHaveBeenCalledOnce();
  });

  it("allows an acknowledged Back traversal without prompting", () => {
    const environment = createEnvironment({ confirm: false });
    const onHandoff = vi.fn();
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: acknowledgedSnapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff,
    });
    controller.install();

    environment.dispatch("popstate", new PopStateEvent("popstate", {
      state: environment.replacedStates[0],
    }));

    expect(environment.confirm).not.toHaveBeenCalled();
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(environment.history.back).toHaveBeenCalledOnce();
  });

  it("uses the native beforeunload warning only while durability is pending", () => {
    let snapshot = pendingSnapshot();
    const environment = createEnvironment({ confirm: true });
    const controller = createCollaborationNavigationController({
      environment,
      getSnapshot: () => snapshot,
      getMessage: () => "Pending collaboration update",
      onHandoff: vi.fn(),
    });
    controller.install();

    const pendingUnload = new Event("beforeunload", { cancelable: true });
    environment.dispatch("beforeunload", pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);

    snapshot = acknowledgedSnapshot();
    const acknowledgedUnload = new Event("beforeunload", { cancelable: true });
    environment.dispatch("beforeunload", acknowledgedUnload);
    expect(acknowledgedUnload.defaultPrevented).toBe(false);
  });
});

function createEnvironment(options: { confirm: boolean }) {
  const listeners = new Map<string, Set<EventListener>>();
  const pushedStates: unknown[] = [];
  const pushedUrls: string[] = [];
  const replacedStates: unknown[] = [];
  const replacedUrls: string[] = [];
  let state: unknown = { route: "current" };
  const history = {
    back: vi.fn(),
    get state() {
      return state;
    },
    pushState(nextState: unknown, _unused: string, url?: string | URL | null) {
      state = nextState;
      pushedStates.push(nextState);
      pushedUrls.push(String(url));
    },
    replaceState(nextState: unknown, _unused: string, url?: string | URL | null) {
      state = nextState;
      replacedStates.push(nextState);
      replacedUrls.push(String(url));
    },
  };
  const environment = {
    addEventListener(type: string, listener: EventListener) {
      const entries = listeners.get(type) ?? new Set<EventListener>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    confirm: vi.fn(() => options.confirm),
    dispatch(type: string, event: Event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    history,
    href: "https://editor.example.test/documents/current",
    pushedStates,
    pushedUrls,
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    replacedStates,
    replacedUrls,
  } satisfies CollaborationNavigationEnvironment & {
    dispatch(type: string, event: Event): void;
    pushedStates: unknown[];
    pushedUrls: string[];
    replacedStates: unknown[];
    replacedUrls: string[];
  };
  return environment;
}

function pendingSnapshot(): CollaborationSessionSnapshot {
  return {
    ...acknowledgedSnapshot(),
    pendingDurableAcknowledgementChecksums: ["a".repeat(64)],
    status: "storage_delayed",
  };
}

function acknowledgedSnapshot(): CollaborationSessionSnapshot {
  return {
    hasCompletedInitialSync: true,
    pendingDurableAcknowledgementChecksums: [],
    pendingLocalChecksums: [],
    pendingLocalUpdateCount: 0,
    permission: "write",
    status: "synced",
    transportSynced: true,
    writable: true,
  };
}
