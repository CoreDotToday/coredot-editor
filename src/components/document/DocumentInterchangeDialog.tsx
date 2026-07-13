"use client";

import { useId, useRef, type ReactNode } from "react";
import { ModalSurface } from "@/components/ui/ModalSurface";

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
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      closeOnBackdrop={!actionsDisabled}
      closeOnEscape={!actionsDisabled}
      initialFocusRef={cancelRef}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
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
    </ModalSurface>
  );
}
