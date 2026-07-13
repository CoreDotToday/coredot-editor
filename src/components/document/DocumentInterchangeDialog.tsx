"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

type DocumentInterchangeDialogProps = {
  actionsDisabled?: boolean;
  cancelLabel: string;
  children: ReactNode;
  confirmLabel: string;
  description: string;
  onClose: () => void;
  onConfirm: () => void;
  returnFocusRef: { readonly current: HTMLElement | null };
  title: string;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function DocumentInterchangeDialog({
  actionsDisabled = false,
  cancelLabel,
  children,
  confirmLabel,
  description,
  onClose,
  onConfirm,
  returnFocusRef,
  title,
}: DocumentInterchangeDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const returnFocusElement = returnFocusRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    const backgroundElements = new Map<HTMLElement, boolean>();
    const isolateBackgroundElement = (element: HTMLElement) => {
      if (element === overlay || backgroundElements.has(element)) return;
      backgroundElements.set(element, element.hasAttribute("inert"));
      element.setAttribute("inert", "");
    };
    for (const element of document.body.children) {
      if (element instanceof HTMLElement) isolateBackgroundElement(element);
    }
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) isolateBackgroundElement(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();

    return () => {
      observer.disconnect();
      for (const [element, wasInert] of backgroundElements) {
        if (!wasInert) {
          element.removeAttribute("inert");
        }
      }
      document.body.style.overflow = previousBodyOverflow;
      returnFocusElement?.focus();
    };
  }, [returnFocusRef]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!actionsDisabled) {
        onClose();
      }
      return;
    }

    if (event.key !== "Tab") return;
    const focusableElements = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    const first = focusableElements[0];
    const last = focusableElements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/30 p-4"
      ref={overlayRef}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="text-lg font-semibold text-zinc-950" id={titleId}>
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600" id={descriptionId}>
          {description}
        </p>
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            disabled={actionsDisabled}
            onClick={onClose}
            ref={cancelRef}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            disabled={actionsDisabled}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
