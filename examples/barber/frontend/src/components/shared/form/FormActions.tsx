"use client";

import { Button } from "@/components/shared/ui";

type FormActionsProps = {
  onCancel?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  disabled?: boolean;
};

export default function FormActions({
  onCancel,
  onSubmit,
  submitLabel = "Save",
  cancelLabel = "Cancel",
  loading,
  disabled,
}: FormActionsProps) {
  return (
    <div className="flex justify-end gap-4 pt-8 border-t border-outline-variant/10 mt-8">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-on-surface-variant hover:text-on-surface text-sm font-medium transition-colors px-4 py-3"
        >
          {cancelLabel}
        </button>
      )}
      {onSubmit && (
        <Button
          type="button"
          variant="gold"
          size="form"
          onClick={onSubmit}
          disabled={disabled || loading}
        >
          {loading ? "Saving…" : submitLabel}
        </Button>
      )}
    </div>
  );
}
