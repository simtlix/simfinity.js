"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/shared/ui";

export type RejectModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  placeholder?: string;
};

export function RejectModal({
  open,
  onClose,
  onConfirm,
  title,
  placeholder = "Enter the reason…",
}: RejectModalProps) {
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
        aria-labelledby="reject-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="reject-modal-title"
          className="font-headline text-xl italic text-on-surface"
        >
          {title}
        </h2>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={placeholder}
          className="mt-6 min-h-[120px] w-full rounded-xl border border-outline-variant/20 bg-surface-container-low p-4 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
          aria-label={placeholder}
        />
        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            className="px-4 py-2 text-on-surface-variant transition-colors hover:text-on-surface"
            onClick={handleClose}
          >
            Cancel
          </button>
          <Button
            type="button"
            variant="gold"
            size="modal"
            disabled={disabled}
            onClick={() => onConfirm(trimmed)}
          >
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
