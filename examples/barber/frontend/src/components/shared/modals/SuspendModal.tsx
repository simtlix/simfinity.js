"use client";

import { useEffect, useState } from "react";

export type SuspendModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  userName?: string;
};

export function SuspendModal({
  open,
  onClose,
  onConfirm,
  title,
  userName,
}: SuspendModalProps) {
  const [reason, setReason] = useState("");

  const handleClose = () => {
    setReason("");
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  });

  if (!open) return null;

  const trimmed = reason.trim();
  const disabled = trimmed.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={handleClose}
    >
      <div
        className="bg-surface-container mx-4 w-full max-w-md rounded-2xl p-8 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="suspend-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-error/15 text-error"
            aria-hidden
          >
            <span className="material-symbols-outlined text-2xl">warning</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="suspend-modal-title"
              className="font-headline text-xl italic text-on-surface"
            >
              {title}
            </h2>
            {userName ? (
              <p className="mt-2 text-sm text-on-surface-variant">
                Account: <span className="text-on-surface">{userName}</span>
              </p>
            ) : null}
          </div>
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Describe why this account is being suspended…"
          className="mt-6 min-h-[120px] w-full rounded-xl border border-outline-variant/20 bg-surface-container-low p-4 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
          aria-label="Suspension reason"
        />
        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            className="px-4 py-2 text-on-surface-variant transition-colors hover:text-on-surface"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled}
            className="rounded-xl bg-error px-6 py-2 font-semibold text-on-error transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onConfirm(trimmed)}
          >
            Suspend
          </button>
        </div>
      </div>
    </div>
  );
}
