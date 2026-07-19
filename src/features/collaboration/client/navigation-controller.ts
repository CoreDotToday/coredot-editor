import type { CollaborationSessionSnapshot } from "./session-store";
import { hasPendingCollaborationUpdates } from "./durability-state";

export type CollaborationNavigationEnvironment = {
  addEventListener(type: "beforeunload" | "popstate", listener: EventListener): void;
  confirm(message: string): boolean;
  history: Pick<History, "back" | "forward" | "pushState" | "replaceState" | "state">;
  href: string;
  navigation?: {
    addEventListener(
      type: "navigate" | "navigateerror" | "navigatesuccess",
      listener: EventListener,
    ): void;
    removeEventListener(
      type: "navigate" | "navigateerror" | "navigatesuccess",
      listener: EventListener,
    ): void;
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
export const COLLABORATION_NAVIGATION_RESTORE_TIMEOUT_MS = 5_000;

let nextControllerId = 0;
let activeFallbackRestorationOwner: symbol | null = null;

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
  const fallbackRestorationOwner = Symbol(controllerId);
  const protectedHref = options.environment.href;
  const originalState = options.environment.history.state;
  const baseState = withNavigationState(originalState, controllerId, "base");
  const sentinelState = withNavigationState(originalState, controllerId, "sentinel");
  let handedOff = false;
  let installed = false;
  let beforeUnloadListenerInstalled = false;
  let navigateListenerInstalled = false;
  let approvedDocumentNavigation: { signal?: AbortSignal } | null = null;
  let popStateListenerInstalled = false;
  let pendingTransition: (() => void) | null = null;
  let restoringCanceledTraversal = false;
  let restorationTimeout: ReturnType<typeof setTimeout> | null = null;
  let sentinelActive = false;
  let uninstallRequested = false;

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
      activeFallbackRestorationOwner !== null
      && activeFallbackRestorationOwner !== fallbackRestorationOwner
    ) return null;
    if (
      hasPendingCollaborationUpdates(options.getSnapshot())
      && !options.environment.confirm(options.getMessage())
    ) {
      return null;
    }
    return createPermit();
  };

  const pushSentinel = () => {
    options.environment.history.pushState(sentinelState, "", protectedHref);
    sentinelActive = true;
  };

  const clearApprovedDocumentNavigation = () => {
    approvedDocumentNavigation?.signal?.removeEventListener(
      "abort",
      clearApprovedDocumentNavigation,
    );
    approvedDocumentNavigation = null;
  };

  const handleBeforeUnload: EventListener = (event) => {
    if (
      handedOff
      || approvedDocumentNavigation !== null
      || !hasPendingCollaborationUpdates(options.getSnapshot())
    ) return;
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
    clearApprovedDocumentNavigation();
    const navigateEvent = event as Event & {
      canIntercept?: boolean;
      destination?: { sameDocument?: boolean; url?: string };
      signal?: AbortSignal;
    };
    if (
      navigateEvent.canIntercept !== true
      || !navigateEvent.destination?.url
      || navigateEvent.signal?.aborted
    ) return;
    if (
      hasPendingCollaborationUpdates(options.getSnapshot())
      && !options.environment.confirm(options.getMessage())
    ) {
      navigateEvent.preventDefault();
      return;
    }
    if (navigateEvent.destination.sameDocument !== true) {
      approvedDocumentNavigation = { signal: navigateEvent.signal };
      navigateEvent.signal?.addEventListener("abort", clearApprovedDocumentNavigation, {
        once: true,
      });
    }
    // A navigate event is only an attempt: same-document changes remain mounted,
    // while route navigations can still abort or emit navigateerror. Keep the
    // durability guard active until the owning shell actually unmounts.
  };

  const handleNavigationSettled: EventListener = () => {
    clearApprovedDocumentNavigation();
  };

  const removeInstalledListeners = () => {
    if (!installed) return;
    installed = false;
    uninstallRequested = false;
    if (beforeUnloadListenerInstalled) {
      beforeUnloadListenerInstalled = false;
      options.environment.removeEventListener("beforeunload", handleBeforeUnload);
    }
    if (navigateListenerInstalled && options.environment.navigation) {
      navigateListenerInstalled = false;
      options.environment.navigation.removeEventListener("navigate", handleNavigate);
      options.environment.navigation.removeEventListener("navigateerror", handleNavigationSettled);
      options.environment.navigation.removeEventListener("navigatesuccess", handleNavigationSettled);
    }
    clearApprovedDocumentNavigation();
    if (popStateListenerInstalled) {
      popStateListenerInstalled = false;
      options.environment.removeEventListener("popstate", handlePopState);
    }
  };

  const releaseFallbackRestoration = () => {
    if (restorationTimeout !== null) {
      clearTimeout(restorationTimeout);
      restorationTimeout = null;
    }
    restoringCanceledTraversal = false;
    if (activeFallbackRestorationOwner === fallbackRestorationOwner) {
      activeFallbackRestorationOwner = null;
    }
  };

  const completeCanceledTraversal = (forceProtectedEntry: boolean) => {
    if (!restoringCanceledTraversal) return;
    try {
      if (forceProtectedEntry) {
        options.environment.history.replaceState(baseState, "", protectedHref);
      }
      options.onRestoreProtectedRoute?.(protectedHref);
      pushSentinel();
    } finally {
      releaseFallbackRestoration();
      if (uninstallRequested) removeInstalledListeners();
    }
  };

  const startCanceledTraversalRestoration = () => {
    restoringCanceledTraversal = true;
    activeFallbackRestorationOwner = fallbackRestorationOwner;
    restorationTimeout = setTimeout(() => {
      completeCanceledTraversal(true);
    }, COLLABORATION_NAVIGATION_RESTORE_TIMEOUT_MS);
  };

  const handlePopState: EventListener = (event) => {
    if (
      activeFallbackRestorationOwner !== null
      && activeFallbackRestorationOwner !== fallbackRestorationOwner
    ) return;
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
      sentinelActive = false;
      completeCanceledTraversal(false);
      return;
    }

    if (!isProtectedBase) {
      if (
        hasPendingCollaborationUpdates(options.getSnapshot())
        && !options.environment.confirm(options.getMessage())
      ) {
        sentinelActive = false;
        startCanceledTraversalRestoration();
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
      if (installed) {
        uninstallRequested = false;
        return createUninstall();
      }
      installed = true;
      uninstallRequested = false;
      options.environment.addEventListener("beforeunload", handleBeforeUnload);
      beforeUnloadListenerInstalled = true;
      if (options.environment.navigation) {
        options.environment.navigation.addEventListener("navigate", handleNavigate);
        options.environment.navigation.addEventListener("navigateerror", handleNavigationSettled);
        options.environment.navigation.addEventListener("navigatesuccess", handleNavigationSettled);
        navigateListenerInstalled = true;
      } else {
        // The Navigation API preserves the browser's forward stack. This fallback
        // must install a same-URL sentinel and can therefore truncate that stack.
        if (activeFallbackRestorationOwner === null) {
          if (!sentinelActive) {
            options.environment.history.replaceState(baseState, "", protectedHref);
            pushSentinel();
          }
          options.environment.addEventListener("popstate", handlePopState);
          popStateListenerInstalled = true;
        }
      }
      return createUninstall();
    },
    requestTransition,
  };

  function createUninstall() {
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (restoringCanceledTraversal) {
        uninstallRequested = true;
        return;
      }
      removeInstalledListeners();
    };
  }
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
