"use client";

import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type ModalAccessibleName =
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-label"?: never; "aria-labelledby": string };

export type ModalSurfaceProps = ModalAccessibleName & {
  "aria-describedby"?: string;
  children: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  overlayClassName?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  role?: "alertdialog" | "dialog";
  unstyled?: boolean;
};

type ModalEntry = {
  closeOnEscape: () => boolean;
  id: symbol;
  initialFocus: () => HTMLElement | null;
  overlay: HTMLElement;
  requestClose: () => void;
  restoreCandidates: HTMLElement[];
  surface: HTMLElement;
};

type IsolationSnapshot = {
  ariaHidden: string | null;
  inert: boolean;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const DEFAULT_OVERLAY_CLASS_NAME =
  "fixed inset-0 flex items-center justify-center bg-zinc-950/30 p-4";
const DEFAULT_SURFACE_CLASS_NAME =
  "max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl";
const PORTAL_ROOT_SELECTOR = "[data-modal-surface-root]";

const modalStack: ModalEntry[] = [];
const activityListeners = new Set<() => void>();
const backgroundSnapshots = new Map<HTMLElement, IsolationSnapshot>();
let backgroundObserver: MutationObserver | null = null;
let portalLeaseCount = 0;
let portalRoot: HTMLElement | null = null;
let portalRootOwned = false;
let previousBodyOverflow = "";

export function isModalSurfaceActive() {
  return modalStack.length > 0;
}

export function subscribeToModalSurfaceActivity(listener: () => void) {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function ModalSurface(props: ModalSurfaceProps) {
  const {
    children,
    className,
    closeOnBackdrop = true,
    closeOnEscape = true,
    initialFocusRef,
    onClose,
    overlayClassName,
    returnFocusRef,
    role = "dialog",
    unstyled = false,
  } = props;
  const ariaLabel = props["aria-label"];
  const ariaLabelledBy = props["aria-labelledby"];
  const hasAriaLabel = Boolean(ariaLabel?.trim());
  const hasAriaLabelledBy = Boolean(ariaLabelledBy?.trim());
  if (hasAriaLabel === hasAriaLabelledBy) {
    throw new Error("ModalSurface requires exactly one of aria-label or aria-labelledby.");
  }

  const targetRoot = useSyncExternalStore(
    subscribeToPortalRoot,
    getPortalRootSnapshot,
    getServerPortalRootSnapshot,
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const entryRef = useRef<ModalEntry | null>(null);
  const closeOnBackdropRef = useRef(closeOnBackdrop);
  const closeOnEscapeRef = useRef(closeOnEscape);
  const initialFocusRefRef = useRef(initialFocusRef);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    closeOnBackdropRef.current = closeOnBackdrop;
    closeOnEscapeRef.current = closeOnEscape;
    initialFocusRefRef.current = initialFocusRef;
    onCloseRef.current = onClose;
  }, [closeOnBackdrop, closeOnEscape, initialFocusRef, onClose]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const surface = surfaceRef.current;
    if (!targetRoot || !overlay || !surface) return;

    const previousTop = modalStack.at(-1);
    const explicitReturnFocus = returnFocusRef?.current;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreCandidates = uniqueElements([
      explicitReturnFocus,
      activeElement,
      ...(previousTop?.restoreCandidates ?? []),
    ]);
    const entry: ModalEntry = {
      closeOnEscape: () => closeOnEscapeRef.current,
      id: Symbol("ModalSurface"),
      initialFocus: () => initialFocusRefRef.current?.current ?? null,
      overlay,
      requestClose: () => onCloseRef.current(),
      restoreCandidates,
      surface,
    };
    entryRef.current = entry;
    registerModal(entry, targetRoot);

    return () => {
      entryRef.current = null;
      unregisterModal(entry);
    };
  }, [returnFocusRef, targetRoot]);

  if (!targetRoot) return null;

  function handleBackdropMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const entry = entryRef.current;
    if (!entry || modalStack.at(-1) !== entry || !closeOnBackdropRef.current) return;
    entry.requestClose();
  }

  return createPortal(
    <div
      className={unstyled ? overlayClassName : mergeClassNames(DEFAULT_OVERLAY_CLASS_NAME, overlayClassName)}
      data-modal-surface-overlay=""
      onMouseDown={handleBackdropMouseDown}
      ref={overlayRef}
    >
      <section
        aria-describedby={props["aria-describedby"]}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-modal="true"
        className={unstyled ? className : mergeClassNames(DEFAULT_SURFACE_CLASS_NAME, className)}
        ref={surfaceRef}
        role={role}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    targetRoot,
  );
}

function acquirePortalRoot() {
  if (!portalRoot?.isConnected) {
    const existing = document.querySelector<HTMLElement>(PORTAL_ROOT_SELECTOR);
    if (existing) {
      portalRoot = existing;
      portalRootOwned = existing.hasAttribute("data-modal-surface-owned");
    } else {
      portalRoot = document.createElement("div");
      portalRoot.setAttribute("data-modal-surface-owned", "");
      portalRoot.setAttribute("data-modal-surface-root", "");
      document.body.append(portalRoot);
      portalRootOwned = true;
    }
  }
  portalLeaseCount += 1;
  return portalRoot;
}

function subscribeToPortalRoot(listener: () => void) {
  const root = acquirePortalRoot();
  listener();
  return () => {
    releasePortalRoot(root);
  };
}

function getPortalRootSnapshot() {
  return portalRoot?.isConnected ? portalRoot : null;
}

function getServerPortalRootSnapshot() {
  return null;
}

function releasePortalRoot(root: HTMLElement) {
  portalLeaseCount = Math.max(0, portalLeaseCount - 1);
  removePortalRootIfUnused(root);
}

function removePortalRootIfUnused(root = portalRoot) {
  if (!root || portalLeaseCount > 0 || modalStack.length > 0) return;
  if (portalRootOwned) root.remove();
  if (portalRoot === root) {
    portalRoot = null;
    portalRootOwned = false;
  }
}

function registerModal(entry: ModalEntry, root: HTMLElement) {
  const wasActive = isModalSurfaceActive();
  if (!wasActive) startGlobalModalEffects(root);
  modalStack.push(entry);
  syncModalLayers();
  if (!wasActive) notifyActivityListeners();
  focusInitialTarget(entry);
}

function unregisterModal(entry: ModalEntry) {
  const index = modalStack.indexOf(entry);
  if (index < 0) return;
  const wasTopmost = index === modalStack.length - 1;
  modalStack.splice(index, 1);
  syncModalLayers();
  if (!isModalSurfaceActive()) {
    stopGlobalModalEffects();
    notifyActivityListeners();
  }
  if (wasTopmost) restoreFocus(entry);
  removePortalRootIfUnused();
}

function startGlobalModalEffects(root: HTMLElement) {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  for (const element of document.body.children) {
    if (element instanceof HTMLElement && element !== root) isolateBackgroundElement(element);
  }
  backgroundObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node !== portalRoot) isolateBackgroundElement(node);
      }
    }
  });
  backgroundObserver.observe(document.body, { childList: true });
  document.addEventListener("keydown", handleGlobalKeyDown, true);
}

function stopGlobalModalEffects() {
  document.removeEventListener("keydown", handleGlobalKeyDown, true);
  backgroundObserver?.disconnect();
  backgroundObserver = null;
  for (const [element, snapshot] of backgroundSnapshots) {
    if (!snapshot.inert) element.removeAttribute("inert");
    if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", snapshot.ariaHidden);
  }
  backgroundSnapshots.clear();
  document.body.style.overflow = previousBodyOverflow;
}

function isolateBackgroundElement(element: HTMLElement) {
  if (backgroundSnapshots.has(element)) return;
  backgroundSnapshots.set(element, {
    ariaHidden: element.getAttribute("aria-hidden"),
    inert: element.hasAttribute("inert"),
  });
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function syncModalLayers() {
  const topIndex = modalStack.length - 1;
  for (const [index, entry] of modalStack.entries()) {
    entry.overlay.style.zIndex = String(70 + index);
    if (index === topIndex) {
      entry.overlay.removeAttribute("inert");
      entry.overlay.removeAttribute("aria-hidden");
    } else {
      entry.overlay.setAttribute("inert", "");
      entry.overlay.setAttribute("aria-hidden", "true");
    }
  }
}

function handleGlobalKeyDown(event: KeyboardEvent) {
  const topmost = modalStack.at(-1);
  if (!topmost) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (topmost.closeOnEscape()) topmost.requestClose();
    return;
  }

  if (event.key !== "Tab") return;
  const focusableElements = getFocusableElements(topmost.surface);
  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    event.stopImmediatePropagation();
    topmost.surface.focus();
    return;
  }

  const activeElement = document.activeElement;
  const isInside = activeElement instanceof Node && topmost.surface.contains(activeElement);
  const shouldWrapBackward = event.shiftKey && (!isInside || activeElement === first || activeElement === topmost.surface);
  const shouldWrapForward = !event.shiftKey && (!isInside || activeElement === last || activeElement === topmost.surface);
  if (!shouldWrapBackward && !shouldWrapForward) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  (shouldWrapBackward ? last : first).focus();
}

function focusInitialTarget(entry: ModalEntry) {
  const preferred = entry.initialFocus();
  if (preferred && entry.surface.contains(preferred) && canReceiveProgrammaticFocus(preferred)) {
    preferred.focus();
    return;
  }
  const first = getFocusableElements(entry.surface)[0];
  (first ?? entry.surface).focus();
}

function restoreFocus(entry: ModalEntry) {
  for (const candidate of entry.restoreCandidates) {
    if (!canReceiveProgrammaticFocus(candidate)) continue;
    candidate.focus();
    if (document.activeElement === candidate) return;
  }
  const nextTopmost = modalStack.at(-1);
  if (nextTopmost) focusInitialTarget(nextTopmost);
}

function getFocusableElements(surface: HTMLElement) {
  return [...surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(canReceiveProgrammaticFocus);
}

function canReceiveProgrammaticFocus(element: HTMLElement) {
  if (!element.isConnected) return false;
  if (element.matches(":disabled")) return false;
  if (element.closest("[inert], [aria-hidden='true']")) return false;
  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden) return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function uniqueElements(elements: Array<HTMLElement | null | undefined>) {
  return elements.filter((element, index): element is HTMLElement =>
    Boolean(element) && elements.indexOf(element) === index
  );
}

function notifyActivityListeners() {
  for (const listener of activityListeners) listener();
}

function mergeClassNames(defaultClassName: string, additionalClassName?: string) {
  return additionalClassName ? `${defaultClassName} ${additionalClassName}` : defaultClassName;
}
