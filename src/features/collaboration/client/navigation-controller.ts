import type { CollaborationSessionSnapshot } from "./session-store";
import { hasPendingCollaborationUpdates } from "./durability-state";

export type CollaborationNavigationEnvironment = {
  addEventListener(type: "beforeunload" | "popstate", listener: EventListener): void;
  confirm(message: string): boolean;
  history: Pick<History, "back" | "forward" | "pushState" | "replaceState" | "state">;
  href: string;
  navigation?: {
    addEventListener(type: "navigate", listener: EventListener): void;
    removeEventListener(type: "navigate", listener: EventListener): void;
  };
  removeEventListener(type: "beforeunload" | "popstate", listener: EventListener): void;
};

export type CollaborationNavigationTarget = Readonly<{
  href: string;
  state: unknown;
}>;

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
  const navigation = (window as Window & {
    navigation?: CollaborationNavigationEnvironment["navigation"];
  }).navigation;
  return {
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    confirm: (message) => window.confirm(message),
    history: window.history,
    get href() {
      return window.location.href;
    },
    navigation: navigation
      && typeof navigation.addEventListener === "function"
      && typeof navigation.removeEventListener === "function"
      ? navigation
      : undefined,
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  };
}

export function createCollaborationNavigationController(options: {
  environment: CollaborationNavigationEnvironment;
  getSnapshot(): CollaborationSessionSnapshot;
  getMessage(): string;
  onHandoff(target?: CollaborationNavigationTarget): void;
  onRestoreProtectedRoute?(href: string): void;
}): CollaborationNavigationController {
  const controllerId = `collaboration-navigation-${++nextControllerId}`;
  const protectedHref = options.environment.href;
  const originalState = options.environment.history.state;
  const baseState = withNavigationState(originalState, controllerId, "base");
  const sentinelState = withNavigationState(originalState, controllerId, "sentinel");
  let handedOff = false;
  let installed = false;
  let pendingTransition: (() => void) | null = null;
  let restoringCanceledTraversal = false;
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

  const approveForeignTarget = (state: unknown) => {
    handedOff = true;
    sentinelActive = false;
    options.onHandoff(Object.freeze({ href: options.environment.href, state }));
  };

  const handleNavigate: EventListener = (event) => {
    if (handedOff) return;
    const navigateEvent = event as Event & {
      canIntercept?: boolean;
      destination?: { url?: string };
    };
    if (navigateEvent.canIntercept !== true || !navigateEvent.destination?.url) return;
    if (
      hasPendingCollaborationUpdates(options.getSnapshot())
      && !options.environment.confirm(options.getMessage())
    ) {
      navigateEvent.preventDefault();
      return;
    }
    handedOff = true;
    options.onHandoff(Object.freeze({ href: navigateEvent.destination.url, state: undefined }));
  };

  const handlePopState: EventListener = (event) => {
    const state = (event as PopStateEvent).state;
    if (pendingTransition) {
      sentinelActive = false;
      const transition = pendingTransition;
      pendingTransition = null;
      transition();
      return;
    }
    if (handedOff) return;

    const isProtectedBase = isOwnBaseState(state, controllerId)
      && options.environment.href === protectedHref;
    if (restoringCanceledTraversal) {
      if (!isProtectedBase) {
        options.environment.history.forward();
        return;
      }
      restoringCanceledTraversal = false;
      sentinelActive = false;
      options.onRestoreProtectedRoute?.(protectedHref);
      pushSentinel();
      return;
    }

    if (!isProtectedBase) {
      if (
        hasPendingCollaborationUpdates(options.getSnapshot())
        && !options.environment.confirm(options.getMessage())
      ) {
        sentinelActive = false;
        restoringCanceledTraversal = true;
        options.environment.history.forward();
        return;
      }
      approveForeignTarget(state);
      return;
    }

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
      options.environment.addEventListener("beforeunload", handleBeforeUnload);
      if (options.environment.navigation) {
        options.environment.navigation.addEventListener("navigate", handleNavigate);
      } else {
        // The Navigation API preserves the browser's forward stack. This fallback
        // must install a same-URL sentinel and can therefore truncate that stack.
        if (!sentinelActive) {
          options.environment.history.replaceState(baseState, "", protectedHref);
          pushSentinel();
        }
        options.environment.addEventListener("popstate", handlePopState);
      }
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        installed = false;
        options.environment.removeEventListener("beforeunload", handleBeforeUnload);
        if (options.environment.navigation) {
          options.environment.navigation.removeEventListener("navigate", handleNavigate);
        } else {
          options.environment.removeEventListener("popstate", handlePopState);
        }
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
