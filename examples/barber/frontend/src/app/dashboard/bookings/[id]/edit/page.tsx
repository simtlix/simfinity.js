'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/shared/ui';

interface BookingDetail {
  id: string;
  confirmationCode: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  totalPrice: number;
  state: string;
  notes: string;
  professional?: { id: string; name?: string };
  lines?: { service?: { id: string; name?: string }; price?: number; durationMinutes?: number }[];
}

interface Professional {
  id: string;
  name: string;
}

export default function EditBookingPage() {
  const t = useT('bookings');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();

  const bookingId = params.id as string;
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [selectedPro, setSelectedPro] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!bookingId) return;
    (async () => {
      try {
        const [result, pros] = await Promise.all([
          client.getById(
            'booking',
            bookingId,
            'id confirmationCode scheduledDate startTime endTime totalPrice state notes professional { id name } lines { service { id name } price durationMinutes }',
          ),
          client.find('professional').fields('id name').exec(),
        ]);

        const b = (result as BookingDetail) ?? null;
        setBooking(b);
        setProfessionals(Array.isArray(pros) ? (pros as Professional[]) : []);

        if (b) {
          setDate(b.scheduledDate?.slice(0, 10) ?? '');
          setStartTime(b.startTime ?? '');
          setSelectedPro(b.professional?.id ?? '');
          setNotes(b.notes ?? '');
        }
      } catch {
        setBooking(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [client, bookingId]);

  const handleSave = useCallback(async () => {
    if (!booking) return;
    setSaving(true);
    setError(null);
    try {
      await client.update('booking', booking.id, {
        scheduledDate: date,
        startTime,
        professional: { id: selectedPro },
        notes,
      });
      router.push(`/dashboard/bookings/${booking.id}/view`);
    } catch {
      setError(t('errorSaving', 'Error al guardar los cambios'));
    } finally {
      setSaving(false);
    }
  }, [client, booking, date, startTime, selectedPro, notes, router, t]);

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

  return (
    <div className="max-w-2xl space-y-8">
      <PageHeader
        title={`${t('editTitle', 'Editar Turno')} #${booking.confirmationCode || bookingId.slice(-6).toUpperCase()}`}
        breadcrumbs={[
          { label: t('bookings', 'Turnos'), href: '/dashboard/bookings' },
          { label: t('edit', 'Editar') },
        ]}
      />

      {error && (
        <div className="rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8 space-y-6">
        {/* Services (read-only) */}
        {booking.lines && booking.lines.length > 0 && (
          <div>
            <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
              {t('services', 'Servicios')}
            </label>
            <div className="space-y-2">
              {booking.lines.map((line, idx) => (
                <div key={idx} className="flex items-center justify-between bg-surface-container-high/50 rounded-lg px-4 py-3">
                  <span className="text-sm text-on-surface">{line.service?.name ?? 'Servicio'}</span>
                  <span className="text-sm font-headline italic text-primary">
                    ${(line.price ?? 0).toLocaleString('es-AR')} · {line.durationMinutes ?? 0} min
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
            {t('professional', 'Profesional')}
          </label>
          <select
            value={selectedPro}
            onChange={(e) => setSelectedPro(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
          >
            <option value="">{t('selectPlaceholder', 'Select...')}</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
              {t('date', 'Fecha')}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
              {t('time', 'Hora')}
            </label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
            {t('notes', 'Notas')}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface resize-none"
            placeholder={t('notesPlaceholder', 'Notas opcionales...')}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-4">
        <button
          onClick={() => router.push(`/dashboard/bookings/${bookingId}/view`)}
          className="px-6 py-3 text-xs uppercase tracking-widest text-on-surface/60 hover:text-on-surface transition-colors"
        >
          {t('cancel', 'Cancelar')}
        </button>
        <Button variant="gold" size="form" onClick={handleSave} disabled={saving} className="gap-2">
          {saving && <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>}
          {t('saveChanges', 'Guardar Cambios')}
        </Button>
      </div>
    </div>
  );
}
