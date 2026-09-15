"use client";

import { Button } from "@/components/shared/ui";

export interface BookingConfirmationStepProps {
  confirmationCode: string;
  barbershopName: string;
  onViewBookings: () => void;
}

export function BookingConfirmationStep({
  confirmationCode,
  barbershopName,
  onViewBookings,
}: BookingConfirmationStepProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 lg:py-16 max-w-lg mx-auto">
      {/* Success icon */}
      <div className="relative mb-8">
        <div className="absolute inset-0 blur-3xl bg-primary/15 scale-[2] rounded-full" />
        <span
          className="material-symbols-outlined text-primary relative z-10"
          style={{
            fontVariationSettings: "'FILL' 1",
            fontSize: "80px",
          }}
        >
          check_circle
        </span>
      </div>

      {/* Headline */}
      <h1 className="font-headline text-5xl lg:text-6xl text-on-surface italic leading-tight mb-4">
        ¡Turno Confirmado!
      </h1>
      <p className="text-on-surface-variant text-sm leading-relaxed max-w-sm mb-10">
        Tu ritual de cuidado ha sido programado con éxito.
      </p>

      {/* Confirmation code */}
      <div className="mb-10 w-full">
        <p className="text-[10px] uppercase tracking-[0.3em] text-on-surface-variant/40 font-bold mb-3">
          Código de Reserva
        </p>
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-2xl px-8 py-5 inline-block">
          <p className="font-mono text-2xl tracking-[0.3em] text-on-surface font-bold">
            {confirmationCode}
          </p>
        </div>
      </div>

      {/* Branding */}
      <div className="flex items-center gap-3 mb-10">
        <span className="material-symbols-outlined text-primary/40 text-xl">
          content_cut
        </span>
        <div>
          <p className="font-headline italic text-on-surface text-sm">
            {barbershopName}
          </p>
          <p className="text-[9px] uppercase tracking-[0.25em] text-on-surface-variant/40">
            Premium Grooming Studio
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-sm">
        <Button
          type="button"
          variant="gold"
          size="md"
          className="flex-1 w-full sm:w-auto"
          onClick={onViewBookings}
        >
          <span className="material-symbols-outlined text-lg">event_note</span>
          Gestionar Turnos
        </Button>
      </div>
    </div>
  );
}
