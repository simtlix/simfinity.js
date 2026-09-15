"use client";

export interface BookingReviewStepProps {
  barbershopName: string;
  services: { name: string; price: number; duration: number }[];
  professional?: string;
  date?: string;
  time?: string;
  totalPrice: number;
  notes: string;
  onNotesChange: (notes: string) => void;
}

function formatCurrency(n: number) {
  return `$${n.toLocaleString("es-AR", { minimumFractionDigits: 2 })}`;
}

export function BookingReviewStep({
  barbershopName,
  services,
  professional,
  date,
  time,
  totalPrice,
  notes,
  onNotesChange,
}: BookingReviewStepProps) {
  const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-10">
        <p className="text-[10px] uppercase tracking-[0.3em] text-primary/60 font-medium mb-2">
          Review
        </p>
        <h1 className="font-headline text-4xl lg:text-5xl text-on-surface leading-tight italic mb-3">
          El toque final{" "}
          <span className="text-primary italic">para tu excelencia.</span>
        </h1>
        <p className="text-on-surface-variant text-sm leading-relaxed max-w-lg">
          Por favor, verificá los detalles de tu cita. Estamos preparando todo
          para ofrecerte una experiencia editorial inigualable.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        {/* Left column — booking details */}
        <div className="lg:col-span-3 space-y-6">
          {/* Details card */}
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 overflow-hidden">
            <div className="px-6 py-4 border-b border-outline-variant/10">
              <h3 className="text-[10px] uppercase tracking-[0.2em] text-on-surface/40 font-bold">
                Detalles de la Reserva
              </h3>
            </div>

            <div className="divide-y divide-outline-variant/5">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center justify-between px-6 py-4">
                  <div>
                    <p className="text-sm font-medium text-on-surface">{svc.name}</p>
                    <p className="text-xs text-on-surface-variant/50 mt-0.5">
                      {svc.duration} minutos de dedicación premium
                    </p>
                  </div>
                  <p className="font-headline italic text-primary text-lg">
                    {formatCurrency(svc.price)}
                  </p>
                </div>
              ))}
            </div>

            <div className="px-6 py-4 border-t border-outline-variant/10 space-y-3">
              {professional && (
                <DetailRow
                  icon="badge"
                  label="Tu Profesional"
                  value={professional}
                />
              )}
              {date && (
                <DetailRow icon="calendar_today" label="Fecha" value={date} />
              )}
              {time && (
                <DetailRow icon="schedule" label="Hora" value={time} />
              )}
              {totalDuration > 0 && (
                <DetailRow
                  icon="timer"
                  label="Duración estimada"
                  value={`${totalDuration} min`}
                />
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-6">
            <h3 className="text-[10px] uppercase tracking-[0.2em] text-on-surface/40 font-bold mb-3">
              Notas Adicionales (Opcional)
            </h3>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              rows={3}
              placeholder="Indicá preferencias de estilo o requerimientos especiales..."
              className="w-full bg-surface-container-high/40 text-on-surface text-sm rounded-xl px-4 py-3 border border-outline-variant/10 focus:border-primary/40 focus:outline-none resize-none placeholder:text-on-surface-variant/30 transition-colors"
            />
          </div>
        </div>

        {/* Right column — total */}
        <div className="lg:col-span-2">
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-6 sticky top-8">
            <p className="text-[10px] uppercase tracking-[0.2em] text-on-surface/40 font-bold mb-1">
              {barbershopName}
            </p>
            <div className="h-px bg-outline-variant/10 my-4" />

            <p className="text-[10px] uppercase tracking-[0.2em] text-on-surface/40 font-bold mb-2">
              Total Final
            </p>
            <p className="font-headline italic text-4xl text-on-surface">
              {formatCurrency(totalPrice)}
            </p>

            <div className="h-px bg-outline-variant/10 my-4" />

            <div className="space-y-2">
              {services.map((svc) => (
                <div key={svc.name} className="flex justify-between text-xs text-on-surface-variant">
                  <span>{svc.name}</span>
                  <span>{formatCurrency(svc.price)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="material-symbols-outlined text-primary/60 text-lg">
        {icon}
      </span>
      <div>
        <p className="text-[10px] uppercase tracking-[0.15em] text-on-surface-variant/40">
          {label}
        </p>
        <p className="text-sm text-on-surface">{value}</p>
      </div>
    </div>
  );
}
