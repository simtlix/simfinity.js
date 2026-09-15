"use client";

import { useEffect } from "react";

import { Button } from "@/components/shared/ui";

export type ConfirmModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
};

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="bg-surface-container mx-4 w-full max-w-md rounded-2xl p-8 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-modal-title"
          className="font-headline text-xl italic text-on-surface"
        >
          {title}
        </h2>
        <p className="mt-3 text-sm text-on-surface-variant">{message}</p>
        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            className="px-4 py-2 text-on-surface-variant transition-colors hover:text-on-surface"
            onClick={onClose}
          >
            {cancelLabel}
          </button>
          <Button
            type="button"
            variant={variant === "danger" ? "destructive" : "gold"}
            size="modal"
            onClick={() => {
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
