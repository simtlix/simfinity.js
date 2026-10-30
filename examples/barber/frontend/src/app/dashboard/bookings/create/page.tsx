'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { BOOKING_ERRORS, bookingErrorCode } from '@/lib/bookingErrors';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/shared/ui';
import { format } from 'date-fns';

interface Service {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
  barbershop?: { id: string } | null;
}

interface Professional {
  id: string;
  name: string;
  barbershop?: { id: string } | null;
}

interface Barbershop {
  id: string;
  name: string;
}

export default function CreateBookingPage() {
  const t = useT('bookings');
  const tBooking = useT('booking');
  const router = useRouter();
  const client = useSimfinityClient();

  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [barbershops, setBarbershops] = useState<Barbershop[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedService, setSelectedService] = useState('');
  const [selectedPro, setSelectedPro] = useState('');
  const [selectedShop, setSelectedShop] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [startTime, setStartTime] = useState('10:00');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [svcs, pros, shops] = await Promise.all([
          client.find<Service>('service').fields('id name price durationMinutes barbershop { id }').exec(),
          client.find<Professional>('professional').fields('id name barbershop { id }').exec(),
          client.find<Barbershop>('barbershop').fields('id name').exec(),
        ]);
        setServices(svcs ?? []);
        setProfessionals(pros ?? []);
        const shopList = shops ?? [];
        setBarbershops(shopList);
        if (shopList.length === 1) setSelectedShop(shopList[0].id);
      } catch {
        /* empty */
      } finally {
        setLoading(false);
      }
    })();
  }, [client]);

  // The API books only the selected shop's services and professionals, so offer only those.
  const shopServices = useMemo(() => services.filter((s) => s.barbershop?.id === selectedShop), [services, selectedShop]);
  const shopProfessionals = useMemo(() => professionals.filter((p) => p.barbershop?.id === selectedShop), [professionals, selectedShop]);
  const selectShop = useCallback((shopId: string) => {
    setSelectedShop(shopId);
    setSelectedService((current) => (services.some((s) => s.id === current && s.barbershop?.id === shopId) ? current : ''));
    setSelectedPro((current) => (professionals.some((p) => p.id === current && p.barbershop?.id === shopId) ? current : ''));
  }, [services, professionals]);

  const handleSubmit = useCallback(async () => {
    if (!selectedShop || !selectedService || !selectedPro || !date || !startTime) return;
    setSaving(true);
    setError(null);
    try {
      const svc = services.find((s) => s.id === selectedService);
      await client.add('booking', {
        barbershop: { id: selectedShop },
        professional: { id: selectedPro },
        scheduledDate: date,
        startTime,
        notes,
        lines: [
          {
            service: { id: selectedService },
            price: svc?.price ?? 0,
            durationMinutes: svc?.durationMinutes ?? 30,
          },
        ],
      });
      router.push('/dashboard/bookings');
    } catch (failure) {
      // Explain the rejections the booking page explains too, such as a service the API refuses.
      const message = BOOKING_ERRORS[bookingErrorCode(failure)];
      setError(message ? tBooking(message.key, message.fallback) : t('errorSaving', 'Error al guardar el turno'));
    } finally {
      setSaving(false);
    }
  }, [client, selectedShop, selectedService, selectedPro, date, startTime, notes, services, router, t, tBooking]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="material-symbols-outlined text-primary text-4xl animate-spin">progress_activity</span>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-8">
      <PageHeader
        title={t('createTitle', 'Nuevo Turno')}
        subtitle={t('createSubtitle', 'Crear una nueva reserva desde el calendario')}
        breadcrumbs={[
          { label: t('bookings', 'Turnos'), href: '/dashboard/bookings' },
          { label: t('create', 'Nuevo') },
        ]}
      />

      {error && (
        <div className="rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8 space-y-6">
        {barbershops.length > 1 && (
          <div>
            <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
              {t('barbershop', 'Barbería')}
            </label>
            <select
              value={selectedShop}
              onChange={(e) => selectShop(e.target.value)}
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
            >
              <option value="">{t('selectPlaceholder', 'Select...')}</option>
              {barbershops.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
            {t('service', 'Servicio')}
          </label>
          <select
            value={selectedService}
            onChange={(e) => setSelectedService(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
          >
            <option value="">{t('selectService', 'Select service...')}</option>
            {shopServices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — ${s.price} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-widest text-on-surface/40 font-bold mb-2">
            {t('professional', 'Profesional')}
          </label>
          <select
            value={selectedPro}
            onChange={(e) => setSelectedPro(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-3 text-sm text-on-surface"
          >
            <option value="">{t('selectProfessional', 'Select professional...')}</option>
            {shopProfessionals.map((p) => (
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
          onClick={() => router.push('/dashboard/bookings')}
          className="px-6 py-3 text-xs uppercase tracking-widest text-on-surface/60 hover:text-on-surface transition-colors"
        >
          {t('cancel', 'Cancelar')}
        </button>
        <Button
          variant="gold"
          size="form"
          onClick={handleSubmit}
          disabled={saving || !selectedService || !selectedPro || !selectedShop}
          className="gap-2"
        >
          {saving && <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>}
          {t('save', 'Crear Turno')}
        </Button>
      </div>
    </div>
  );
}
