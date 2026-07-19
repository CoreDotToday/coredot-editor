import type { CollaborationSessionSnapshot } from "./session-store";
import { hasPendingCollaborationUpdates } from "./durability-state";

export type CollaborationNavigationEnvironment = {
  addEventListener(type: "beforeunload" | "popstate", listener: EventListener): void;
  confirm(message: string): boolean;
  history: Pick<History, "back" | "pushState" | "replaceState" | "state">;
  href: string;
  removeEventListener(type: "beforeunload" | "popstate", listener: EventListener): void;
};

export type CollaborationNavigationPermit = {
  continue(transition: () => void): void;
};

export type CollaborationNavigationController = {
  install(): () => void;
  requestTransition(): CollaborationNavigationPermit | null;
};

const NAVIGATION_STATE_KEY = "__coredotCollaborationNavigation";
let nextControllerId = 0;

export function createBrowserCollaborationNavigationEnvironment(): CollaborationNavigationEnvironment {
  return {
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    confirm: (message) => window.confirm(message),
    history: window.history,
    href: window.location.href,
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  };
}

export function createCollaborationNavigationController(options: {
  environment: CollaborationNavigationEnvironment;
  getSnapshot(): CollaborationSessionSnapshot;
  getMessage(): string;
  onHandoff(): void;
}): CollaborationNavigationController {
  const controllerId = `collaboration-navigation-${++nextControllerId}`;
  const originalState = options.environment.history.state;
  const baseState = withNavigationState(originalState, controllerId, "base");
  const sentinelState = withNavigationState(originalState, controllerId, "sentinel");
  let handedOff = false;
  let installed = false;
  let pendingTransition: (() => void) | null = null;
  let sentinelActive = false;

  const createPermit = (): CollaborationNavigationPermit => {
    let continued = false;
    return {
      continue(transition) {
        if (continued) return;
        continued = true;
        handedOff = true;
        options.onHandoff();
        if (installed && sentinelActive) {
          pendingTransition = transition;
          options.environment.history.back();
          return;
        }
        transition();
      },
    };
  };

  const requestTransition = (): CollaborationNavigationPermit | null => {
    if (handedOff) return null;
    if (
      hasPendingCollaborationUpdates(options.getSnapshot())
      && !options.environment.confirm(options.getMessage())
    ) {
      return null;
    }
    return createPermit();
  };

  const pushSentinel = () => {
    options.environment.history.pushState(sentinelState, "", options.environment.href);
    sentinelActive = true;
  };

  const handleBeforeUnload: EventListener = (event) => {
    if (handedOff || !hasPendingCollaborationUpdates(options.getSnapshot())) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };

  const handlePopState: EventListener = (event) => {
    if (pendingTransition) {
      sentinelActive = false;
      const transition = pendingTransition;
      pendingTransition = null;
      transition();
      return;
    }
    if (handedOff || !isOwnBaseState((event as PopStateEvent).state, controllerId)) return;
    sentinelActive = false;
    const permit = requestTransition();
    if (!permit) {
      pushSentinel();
      return;
    }
    permit.continue(() => options.environment.history.back());
  };

  return {
    install() {
      if (installed) return () => undefined;
      installed = true;
      if (!sentinelActive) {
        options.environment.history.replaceState(baseState, "", options.environment.href);
        pushSentinel();
      }
      options.environment.addEventListener("beforeunload", handleBeforeUnload);
      options.environment.addEventListener("popstate", handlePopState);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        installed = false;
        options.environment.removeEventListener("beforeunload", handleBeforeUnload);
        options.environment.removeEventListener("popstate", handlePopState);
      };
    },
    requestTransition,
  };
}

function withNavigationState(
  current: unknown,
  controllerId: string,
  kind: "base" | "sentinel",
) {
  const state = isRecord(current) ? { ...current } : {};
  return {
    ...state,
    [NAVIGATION_STATE_KEY]: { controllerId, kind },
  };
}

function isOwnBaseState(state: unknown, controllerId: string) {
  if (!isRecord(state)) return false;
  const navigation = state[NAVIGATION_STATE_KEY];
  return isRecord(navigation)
    && navigation.controllerId === controllerId
    && navigation.kind === "base";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
