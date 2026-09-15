"use client";

import { StatusChip } from "@/components/shared/data";

interface BookingCardProps {
  confirmationCode: string;
  barbershopName: string;
  serviceName: string;
  professionalName?: string;
  date: string;
  time: string;
  status: string;
  onCancel?: () => void;
  onReschedule?: () => void;
  onView?: () => void;
}

export function BookingCard({
  confirmationCode,
  barbershopName,
  serviceName,
  professionalName,
  date,
  time,
  status,
  onCancel,
  onReschedule,
  onView,
}: BookingCardProps) {
  const isCancellable = !["CANCELLED", "COMPLETED"].includes(status.toUpperCase());

  return (
    <div className="bg-surface-container-low rounded-2xl p-6 border border-outline-variant/10">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-on-surface-variant font-mono tracking-wider">
          #{confirmationCode}
        </span>
        <StatusChip status={status} />
      </div>

      <p className="font-semibold text-on-surface">{serviceName}</p>
      <p className="text-sm text-on-surface-variant mt-0.5">{barbershopName}</p>

      {professionalName && (
        <p className="text-sm text-on-surface-variant mt-1">
          <span className="material-symbols-outlined text-sm align-middle mr-1">
            person
          </span>
          {professionalName}
        </p>
      )}

      <div className="flex items-center gap-4 mt-3 text-sm text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-sm">calendar_today</span>
          {date}
        </span>
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-sm">schedule</span>
          {time}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-5">
        {onView && (
          <button
            type="button"
            onClick={onView}
            className="text-sm text-primary hover:text-primary/80 transition-colors cursor-pointer"
          >
            Ver detalle
          </button>
        )}
        {onReschedule && isCancellable && (
          <button
            type="button"
            onClick={onReschedule}
            className="text-sm text-primary hover:text-primary/80 transition-colors cursor-pointer"
          >
            Reprogramar
          </button>
        )}
        {onCancel && isCancellable && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-error hover:text-error/80 transition-colors cursor-pointer"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
