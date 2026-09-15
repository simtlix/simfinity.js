"use client";

interface BookingSummaryService {
  name: string;
  price: number;
  duration: number;
}

interface BookingSummaryCardProps {
  barbershopName: string;
  services: BookingSummaryService[];
  professional?: string;
  date?: string;
  time?: string;
  totalPrice: number;
  labelTitle?: string;
  labelBarbershop?: string;
  labelProfessional?: string;
  labelDate?: string;
  labelTime?: string;
  labelDuration?: string;
  labelTotal?: string;
}

export function BookingSummaryCard({
  barbershopName,
  services,
  professional,
  date,
  time,
  totalPrice,
  labelTitle = "Resumen del Turno",
  labelBarbershop = "Barbería",
  labelProfessional = "Profesional",
  labelDate = "Fecha",
  labelTime = "Hora",
  labelDuration = "Duración estimada",
  labelTotal = "Total",
}: BookingSummaryCardProps) {
  const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);

  return (
    <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant/10">
      <h3 className="font-headline italic text-xl text-on-surface mb-6">
        {labelTitle}
      </h3>

      <div className="space-y-3">
        {services.map((service) => (
          <div key={service.name} className="flex items-center justify-between">
            <span className="text-on-surface text-sm">{service.name}</span>
            <span className="text-on-surface-variant text-sm">
              ${service.price.toLocaleString("es-AR")}
            </span>
          </div>
        ))}
      </div>

      <div className="h-px bg-outline-variant/10 my-5" />

      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-on-surface-variant">{labelBarbershop}</span>
          <span className="text-on-surface">{barbershopName}</span>
        </div>

        {professional && (
          <div className="flex items-center justify-between">
            <span className="text-on-surface-variant">{labelProfessional}</span>
            <span className="text-on-surface">{professional}</span>
          </div>
        )}

        {date && (
          <div className="flex items-center justify-between">
            <span className="text-on-surface-variant">{labelDate}</span>
            <span className="text-on-surface">{date}</span>
          </div>
        )}

        {time && (
          <div className="flex items-center justify-between">
            <span className="text-on-surface-variant">{labelTime}</span>
            <span className="text-on-surface">{time}</span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-on-surface-variant">{labelDuration}</span>
          <span className="text-on-surface">{totalDuration} min</span>
        </div>
      </div>

      <div className="h-px bg-outline-variant/10 my-5" />

      <div className="flex items-center justify-between">
        <span className="text-on-surface font-semibold">{labelTotal}</span>
        <span className="text-primary font-bold text-xl">
          ${totalPrice.toLocaleString("es-AR")}
        </span>
      </div>
    </div>
  );
}
