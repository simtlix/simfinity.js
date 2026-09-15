'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { PageHeader } from '@/components/shared/page';
import { StatusChip } from '@/components/shared/data';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface BookingDetail {
  id: string;
  confirmationCode: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  totalPrice: number;
  paymentMethod: string;
  state: string;
  notes: string;
  cancellationReason: string;
  createdAt: string;
  client?: { id: string; name?: string; email?: string };
  professional?: { id: string; name?: string };
  barbershop?: { id: string; name?: string };
  lines?: { service?: { id: string; name?: string }; price?: number; durationMinutes?: number }[];
}

function formatCurrency(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0 })}`;
}

function InfoRow({ label, value, children }: { label: string; value?: string | React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-4 border-b border-outline-variant/5 last:border-b-0">
      <span className="text-xs uppercase tracking-widest text-on-surface/40 font-bold">{label}</span>
      <span className="text-sm text-on-surface text-right">{children ?? value ?? '—'}</span>
    </div>
  );
}

export default function ViewBookingPage() {
  const t = useT('bookings');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();

  const bookingId = params.id as string;
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const BOOKING_FIELDS = 'id confirmationCode scheduledDate startTime endTime totalPrice paymentMethod state notes cancellationReason createdAt client { id name email } professional { id name } barbershop { id name } lines { service { id name } price durationMinutes }';

  const loadBooking = async () => {
    const result = await client.getById('booking', bookingId, BOOKING_FIELDS);
    return (result as BookingDetail) ?? null;
  };

  useEffect(() => {
    if (!bookingId) return;
    (async () => {
      try {
        setBooking(await loadBooking());
      } catch {
        setBooking(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [client, bookingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAction = async (action: string) => {
    if (!booking) return;
    setActionLoading(true);
    try {
      await client.transition('booking', action, booking.id);
      setBooking(await loadBooking());
    } catch {
      /* handle error */
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="material-symbols-outlined text-primary text-4xl animate-spin">progress_activity</span>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="py-20 text-center">
        <span className="material-symbols-outlined text-on-surface-variant/30 text-5xl">event_busy</span>
        <p className="text-on-surface-variant mt-4">{t('notFound', 'Turno no encontrado')}</p>
        <button
          onClick={() => router.push('/dashboard/bookings')}
          className="mt-6 px-6 py-2 text-primary text-xs font-bold tracking-widest"
        >
          {t('backToCalendar', 'Volver al Calendario')}
        </button>
      </div>
    );
  }

  const formattedDate = booking.scheduledDate
    ? format(new Date(booking.scheduledDate), "EEEE d 'de' MMMM, yyyy", { locale: es })
    : '—';

  const totalDuration = booking.lines?.reduce((s, l) => s + (l.durationMinutes ?? 0), 0) ?? 0;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title={`${t('booking', 'Turno')} #${booking.confirmationCode || bookingId.slice(-6).toUpperCase()}`}
        breadcrumbs={[
          { label: t('bookings', 'Turnos'), href: '/dashboard/bookings' },
          { label: t('details', 'Detalle') },
        ]}
        actions={
          <div className="flex items-center gap-3">
            {booking.state === 'CONFIRMED' && (
              <>
                <button
                  onClick={() => handleAction('complete')}
                  disabled={actionLoading}
                  className="px-5 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold tracking-widest rounded-lg hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                >
                  {t('complete', 'Completar')}
                </button>
                <button
                  onClick={() => handleAction('cancelbyshop')}
                  disabled={actionLoading}
                  className="px-5 py-2 bg-red-400/10 border border-red-400/20 text-red-400 text-xs font-bold tracking-widest rounded-lg hover:bg-red-400/20 transition-colors disabled:opacity-50"
                >
                  {t('cancelBooking', 'Cancelar')}
                </button>
              </>
            )}
            <button
              onClick={() => router.push(`/dashboard/bookings/${bookingId}/edit`)}
              className="px-5 py-2 bg-primary/10 border border-primary/20 text-primary text-xs font-bold tracking-widest rounded-lg hover:bg-primary/20 transition-colors"
            >
              {t('edit', 'Editar')}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Booking Info */}
        <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8">
          <h3 className="text-[10px] uppercase tracking-[0.3em] text-primary font-bold mb-6">
            {t('bookingInfo', 'Información del Turno')}
          </h3>
          <InfoRow label={t('status', 'Estado')}>
            <StatusChip status={booking.state} />
          </InfoRow>
          <InfoRow label={t('date', 'Fecha')} value={formattedDate} />
          <InfoRow
            label={t('time', 'Horario')}
            value={`${booking.startTime ?? '—'} – ${booking.endTime ?? '—'}`}
          />
          <InfoRow label={t('duration', 'Duración')} value={`${totalDuration} min`} />
          <InfoRow label={t('total', 'Total')} value={formatCurrency(booking.totalPrice ?? 0)} />
          <InfoRow
            label={t('payment', 'Pago')}
            value={booking.paymentMethod === 'ON_SITE' ? t('paymentOnSite', 'On-site') : booking.paymentMethod}
          />
          {booking.notes && <InfoRow label={t('notes', 'Notas')} value={booking.notes} />}
          {booking.cancellationReason && (
            <InfoRow label={t('cancellationReason', 'Motivo cancelación')} value={booking.cancellationReason} />
          )}
        </div>

        {/* People Info */}
        <div className="space-y-8">
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8">
            <h3 className="text-[10px] uppercase tracking-[0.3em] text-primary font-bold mb-6">
              {t('client', 'Cliente')}
            </h3>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold">
                {(booking.client?.name ?? booking.client?.email ?? '?').slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-on-surface">{booking.client?.name || '—'}</p>
                <p className="text-xs text-on-surface/40">{booking.client?.email || ''}</p>
              </div>
            </div>
          </div>

          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8">
            <h3 className="text-[10px] uppercase tracking-[0.3em] text-primary font-bold mb-6">
              {t('professional', 'Profesional')}
            </h3>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold">
                {(booking.professional?.name ?? '?').slice(0, 2).toUpperCase()}
              </div>
              <p className="text-sm font-medium text-on-surface">{booking.professional?.name || '—'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Services */}
      {booking.lines && booking.lines.length > 0 && (
        <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8">
          <h3 className="text-[10px] uppercase tracking-[0.3em] text-primary font-bold mb-6">
            {t('services', 'Servicios')}
          </h3>
          <div className="space-y-3">
            {booking.lines.map((line, idx) => (
              <div key={idx} className="flex items-center justify-between py-3 border-b border-outline-variant/5 last:border-b-0">
                <div>
                  <p className="text-sm font-medium text-on-surface">{line.service?.name ?? 'Servicio'}</p>
                  <p className="text-xs text-on-surface/40">{line.durationMinutes ?? 0} min</p>
                </div>
                <span className="text-sm font-headline italic text-primary">{formatCurrency(line.price ?? 0)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-4">
              <span className="text-xs uppercase tracking-widest text-on-surface/40 font-bold">{t('total', 'Total')}</span>
              <span className="text-lg font-headline italic font-bold text-primary">{formatCurrency(booking.totalPrice ?? 0)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
