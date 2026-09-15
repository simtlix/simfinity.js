'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { RequireAuth } from '@/lib/requireAuth';
import { PageHeader } from '@/components/shared/page';
import {
  FormField,
  FormTextarea,
  FormSelect,
  FormSection,
  FormLayout,
  FormActions,
  FormImageUpload,
} from '@/components/shared/form';
import { BusinessHoursEditor } from '@/components/shared/hours';
import type { BusinessHourSlot } from '@/components/shared/hours';
import { LocationPicker } from '@/components/shared/maps';
import { Button } from '@/components/shared/ui';

const PROVINCES = [
  'Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba',
  'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
  'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan',
  'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
].map((p) => ({ value: p, label: p }));

const COUNTRIES = [
  { value: 'AR', label: 'Argentina' },
  { value: 'UY', label: 'Uruguay' },
  { value: 'CL', label: 'Chile' },
  { value: 'BR', label: 'Brasil' },
];

const SLOT_DURATIONS = [15, 20, 30, 45, 60, 90].map((m) => ({
  value: String(m),
  label: `${m} min`,
}));

const BUFFER_OPTIONS = [0, 5, 10, 15, 20, 30].map((m) => ({
  value: String(m),
  label: `${m} min`,
}));

const DEFAULT_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  openTime: '09:00',
  closeTime: '18:00',
  isClosed: i === 0,
}));

type Owner = { id: string; name: string; email: string };

type FormData = {
  [key: string]: unknown;
  name: string;
  slug: string;
  description: string;
  logoUrl: string;
  coverImageUrl: string;
  street: string;
  number: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  whatsapp: string;
  slotDurationMinutes: string;
  bufferMinutes: string;
  minAdvanceHours: string;
  maxAdvanceDays: string;
  cancellationPolicyHours: string;
  cancellationFeePercent: string;
  latitude: string;
  longitude: string;
};

const INITIAL: FormData = {
  name: '',
  slug: '',
  description: '',
  logoUrl: '',
  coverImageUrl: '',
  street: '',
  number: '',
  city: '',
  state: '',
  zip: '',
  country: 'AR',
  phone: '',
  email: '',
  whatsapp: '',
  slotDurationMinutes: '45',
  bufferMinutes: '10',
  minAdvanceHours: '2',
  maxAdvanceDays: '30',
  cancellationPolicyHours: '24',
  cancellationFeePercent: '0',
  latitude: '',
  longitude: '',
};

export default function AdminBarbershopCreatePage() {
  const t = useT('admin');
  const router = useRouter();
  const client = useSimfinityClient();

  const [step, setStep] = useState<'owner' | 'form'>('owner');
  const [owners, setOwners] = useState<Owner[]>([]);
  const [loadingOwners, setLoadingOwners] = useState(true);
  const [selectedOwnerId, setSelectedOwnerId] = useState('');

  const form = useFormState(INITIAL);
  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadOwners() {
      try {
        const results = await client
          .find('user')
          .where('role', 'EQ', 'OWNER')
          .fields('id name email')
          .sort('name', 'ASC')
          .page(1, 100)
          .exec();
        if (!cancelled) setOwners(results as Owner[]);
      } catch {
        if (!cancelled) setOwners([]);
      }
      if (!cancelled) setLoadingOwners(false);
    }

    loadOwners();
    return () => { cancelled = true; };
  }, [client]);

  function autoSlug(name: string) {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  const validate = (): boolean => {
    let valid = true;
    form.clearErrors();

    if (!form.values.name.trim()) {
      form.setError('name', t('required', 'Campo obligatorio'));
      valid = false;
    }
    if (!form.values.slug.trim()) {
      form.setError('slug', t('required', 'Campo obligatorio'));
      valid = false;
    }
    if (!form.values.street.trim()) {
      form.setError('street', t('required', 'Campo obligatorio'));
      valid = false;
    }
    if (!form.values.city.trim()) {
      form.setError('city', t('required', 'Campo obligatorio'));
      valid = false;
    }
    return valid;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    setSaveError('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const payload = {
        name: form.values.name,
        slug: form.values.slug,
        description: form.values.description,
        logoUrl: form.values.logoUrl,
        coverImageUrl: form.values.coverImageUrl,
        address: {
          street: form.values.street,
          number: form.values.number,
          city: form.values.city,
          state: form.values.state,
          zip: form.values.zip,
          country: form.values.country,
        },
        contactInfo: {
          phone: form.values.phone,
          email: form.values.email,
          whatsapp: form.values.whatsapp,
        },
        timezone,
        ...(form.values.latitude ? { latitude: Number(form.values.latitude) } : {}),
        ...(form.values.longitude ? { longitude: Number(form.values.longitude) } : {}),
        slotDurationMinutes: Number(form.values.slotDurationMinutes),
        bufferMinutes: Number(form.values.bufferMinutes),
        minAdvanceHours: Number(form.values.minAdvanceHours),
        maxAdvanceDays: Number(form.values.maxAdvanceDays),
        cancellationPolicyHours: Number(form.values.cancellationPolicyHours),
        cancellationFeePercent: Number(form.values.cancellationFeePercent),
        businessHours: businessHours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime,
          closeTime: h.closeTime,
          isClosed: h.isClosed,
          breakStartTime: h.breakStartTime,
          breakEndTime: h.breakEndTime,
        })),
        owner: { id: selectedOwnerId },
      };
      const result = (await client.add('barbershop', payload)) as { id: string };
      await client.transition('barbershop', 'submitforreview', result.id);
      router.push('/admin/barbershops');
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t('saveError', 'Error al crear la barbería'),
      );
    }
    setSaving(false);
  };

  return (
    <RequireAuth role="PLATFORM_ADMIN">
      <div className="max-w-4xl space-y-8">
        <PageHeader
          title={t('createBarbershop', 'Crear Barbería')}
          breadcrumbs={[
            { label: t('administration', 'Administración'), href: '/admin' },
            { label: t('barbershops', 'Barberías'), href: '/admin/barbershops' },
            { label: t('new', 'Nueva') },
          ]}
        />

        {step === 'owner' && (
          <FormLayout>
            <div className="space-y-8">
              <FormSection title={t('selectOwner', 'Seleccionar Dueño')} icon="person_search">
                {loadingOwners ? (
                  <div className="flex items-center gap-3 py-8 justify-center text-on-surface-variant/60">
                    <span className="material-symbols-outlined animate-spin">progress_activity</span>
                    <span className="text-sm">{t('loadingOwners', 'Cargando dueños...')}</span>
                  </div>
                ) : owners.length === 0 ? (
                  <div className="py-8 text-center">
                    <span className="material-symbols-outlined text-4xl text-on-surface-variant/30 mb-2 block">
                      person_off
                    </span>
                    <p className="text-sm text-on-surface-variant/60">
                      {t('noOwners', 'No hay usuarios con rol OWNER registrados.')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <label className="block text-xs uppercase tracking-widest text-on-surface-variant/70 font-bold">
                      {t('owner', 'Dueño')}
                    </label>
                    <select
                      value={selectedOwnerId}
                      onChange={(e) => setSelectedOwnerId(e.target.value)}
                      className="w-full bg-surface-container-high border border-outline-variant/20 rounded-xl py-3 px-4 text-sm text-on-surface focus:ring-2 focus:ring-primary-container/20 transition-all"
                    >
                      <option value="">{t('selectOwnerPlaceholder', '— Seleccionar dueño —')}</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} ({o.email})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </FormSection>

              <div className="flex justify-end pt-4">
                <Button
                  type="button"
                  variant="gold"
                  size="form"
                  disabled={!selectedOwnerId}
                  onClick={() => setStep('form')}
                  className="gap-2 text-on-primary"
                >
                  {t('continue', 'Continuar')}
                  <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </Button>
              </div>
            </div>
          </FormLayout>
        )}

        {step === 'form' && (
          <FormLayout>
            <div className="space-y-8">
              {/* Owner badge */}
              <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-container-high border border-outline-variant/10">
                <span className="material-symbols-outlined text-primary">person</span>
                <div className="flex-1">
                  <p className="text-xs uppercase tracking-widest text-on-surface-variant/60 font-bold">
                    {t('owner', 'Dueño')}
                  </p>
                  <p className="text-sm font-medium text-on-surface">
                    {owners.find((o) => o.id === selectedOwnerId)?.name ?? selectedOwnerId}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setStep('owner')}
                  className="text-xs text-primary hover:underline font-semibold"
                >
                  {t('change', 'Cambiar')}
                </button>
              </div>

              {/* Basic info */}
              <FormSection title={t('basicInfo', 'Datos Básicos')} icon="storefront">
                <FormField
                  label={t('shopName', 'Nombre del Negocio')}
                  value={form.values.name}
                  onChange={(v) => {
                    form.setValue('name', v);
                    if (!form.values.slug || form.values.slug === autoSlug(form.values.name)) {
                      form.setValue('slug', autoSlug(v));
                    }
                  }}
                  placeholder={t('shopNamePlaceholder', 'Ej. The Heritage Cut & Shave')}
                  error={form.errors.name}
                  required
                />
                <FormField
                  label={t('slug', 'URL Slug')}
                  value={form.values.slug}
                  onChange={(v) => form.setValue('slug', v)}
                  placeholder="mi-barberia"
                  error={form.errors.slug}
                  required
                />
                <FormTextarea
                  label={t('description', 'Descripción')}
                  value={form.values.description}
                  onChange={(v) => form.setValue('description', v)}
                  placeholder={t('descPlaceholder', 'Una breve reseña sobre la barbería...')}
                  rows={3}
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormImageUpload
                    label={t('logo', 'Logo')}
                    value={form.values.logoUrl}
                    onChange={(v) => form.setValue('logoUrl', v)}
                    variant="square"
                    hint={t('logoHint', 'SVG, PNG o JPG (cuadrado)')}
                  />
                  <FormImageUpload
                    label={t('coverImage', 'Imagen de Portada')}
                    value={form.values.coverImageUrl}
                    onChange={(v) => form.setValue('coverImageUrl', v)}
                    variant="wide"
                    hint={t('coverHint', '1920×820px recomendado')}
                  />
                </div>
              </FormSection>

              {/* Address */}
              <FormSection title={t('studioAddress', 'Dirección')} icon="location_on">
                <FormField
                  label={t('street', 'Calle')}
                  value={form.values.street}
                  onChange={(v) => form.setValue('street', v)}
                  placeholder={t('streetPlaceholder', 'Av. Libertador')}
                  error={form.errors.street}
                  required
                />
                <div className="grid grid-cols-2 gap-6">
                  <FormField
                    label={t('streetNumber', 'Número')}
                    value={form.values.number}
                    onChange={(v) => form.setValue('number', v)}
                    placeholder="1450"
                  />
                  <FormField
                    label={t('city', 'Ciudad')}
                    value={form.values.city}
                    onChange={(v) => form.setValue('city', v)}
                    placeholder={t('cityPlaceholder', 'Ciudad')}
                    error={form.errors.city}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <FormSelect
                    label={t('province', 'Provincia')}
                    value={form.values.state}
                    onChange={(v) => form.setValue('state', v)}
                    options={PROVINCES}
                    placeholder={t('selectProvince', 'Seleccionar provincia')}
                  />
                  <FormField
                    label={t('zip', 'Código Postal')}
                    value={form.values.zip}
                    onChange={(v) => form.setValue('zip', v)}
                    placeholder="C1425"
                  />
                </div>
                <FormSelect
                  label={t('country', 'País')}
                  value={form.values.country}
                  onChange={(v) => form.setValue('country', v)}
                  options={COUNTRIES}
                />
              </FormSection>

              {/* Contact */}
              <FormSection title={t('directContact', 'Contacto')} icon="call">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    label={t('phone', 'Teléfono')}
                    value={form.values.phone}
                    onChange={(v) => form.setValue('phone', v)}
                    type="tel"
                    placeholder="+54 11 0000 0000"
                  />
                  <FormField
                    label="Email"
                    value={form.values.email}
                    onChange={(v) => form.setValue('email', v)}
                    type="email"
                    placeholder="info@barberia.com"
                  />
                  <FormField
                    label="WhatsApp"
                    value={form.values.whatsapp}
                    onChange={(v) => form.setValue('whatsapp', v)}
                    type="tel"
                    placeholder="+54 9 11 0000 0000"
                  />
                </div>
              </FormSection>

              {/* Coordinates */}
              <FormSection title={t('coordinates', 'Coordenadas')} icon="my_location">
                <LocationPicker
                  value={
                    form.values.latitude && form.values.longitude
                      ? [Number(form.values.latitude), Number(form.values.longitude)]
                      : null
                  }
                  onChange={(lat, lng) => {
                    form.setValue('latitude', String(lat));
                    form.setValue('longitude', String(lng));
                  }}
                />
              </FormSection>

              {/* Schedule */}
              <FormSection title={t('weeklyAvailability', 'Disponibilidad Semanal')} icon="schedule">
                <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} />
              </FormSection>

              {/* Booking protocol */}
              <FormSection title={t('bookingProtocol', 'Protocolo de Reserva')} icon="event_available">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormSelect
                    label={t('slotDuration', 'Duración de Slots')}
                    value={form.values.slotDurationMinutes}
                    onChange={(v) => form.setValue('slotDurationMinutes', v)}
                    options={SLOT_DURATIONS}
                  />
                  <FormSelect
                    label={t('buffer', 'Buffer entre turnos')}
                    value={form.values.bufferMinutes}
                    onChange={(v) => form.setValue('bufferMinutes', v)}
                    options={BUFFER_OPTIONS}
                  />
                  <FormField
                    label={t('minAdvance', 'Anticipación mínima (horas)')}
                    value={form.values.minAdvanceHours}
                    onChange={(v) => form.setValue('minAdvanceHours', v)}
                    type="number"
                  />
                  <FormField
                    label={t('maxAdvance', 'Anticipación máxima (días)')}
                    value={form.values.maxAdvanceDays}
                    onChange={(v) => form.setValue('maxAdvanceDays', v)}
                    type="number"
                  />
                </div>
              </FormSection>

              {/* Cancellation policy */}
              <FormSection title={t('cancellation', 'Política de Cancelación')} icon="event_busy">
                <div className="grid grid-cols-2 gap-6">
                  <FormField
                    label={t('cancellationHours', 'Horas límite para cancelar')}
                    value={form.values.cancellationPolicyHours}
                    onChange={(v) => form.setValue('cancellationPolicyHours', v)}
                    type="number"
                  />
                  <FormField
                    label={t('cancellationFee', 'Cargo por cancelación (%)')}
                    value={form.values.cancellationFeePercent}
                    onChange={(v) => form.setValue('cancellationFeePercent', v)}
                    type="number"
                  />
                </div>
              </FormSection>

              {saveError && (
                <div className="p-4 rounded-xl border border-error/20 bg-error/5 text-error text-sm">
                  {saveError}
                </div>
              )}

              <FormActions
                onCancel={() => router.push('/admin/barbershops')}
                onSubmit={handleSave}
                submitLabel={t('createBarbershop', 'Crear Barbería')}
                cancelLabel={t('cancel', 'Cancelar')}
                loading={saving}
              />
            </div>
          </FormLayout>
        )}
      </div>
    </RequireAuth>
  );
}
