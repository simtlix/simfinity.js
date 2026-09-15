'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { PageHeader } from '@/components/shared/page';
import { BusinessHoursEditor } from '@/components/shared/hours';
import { LocationPicker } from '@/components/shared/maps';
import {
  FormField,
  FormTextarea,
  FormSelect,
  FormSection,
  FormLayout,
  FormActions,
  FormImageUpload,
} from '@/components/shared/form';
import type { BusinessHourSlot } from '@/components/shared/hours';

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

type BarbershopForm = {
  [key: string]: unknown;
  name: string;
  slug: string;
  description: string;
  logoUrl: string;
  coverImageUrl: string;
  timezone: string;
  street: string;
  number: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  whatsapp: string;
  latitude: string;
  longitude: string;
  slotDurationMinutes: string;
  bufferMinutes: string;
  minAdvanceHours: string;
  maxAdvanceDays: string;
  cancellationPolicyHours: string;
  cancellationFeePercent: string;
};

const INITIAL: BarbershopForm = {
  name: '',
  slug: '',
  description: '',
  logoUrl: '',
  coverImageUrl: '',
  timezone: '',
  street: '',
  number: '',
  city: '',
  state: '',
  zip: '',
  country: 'AR',
  phone: '',
  email: '',
  whatsapp: '',
  latitude: '',
  longitude: '',
  slotDurationMinutes: '45',
  bufferMinutes: '10',
  minAdvanceHours: '2',
  maxAdvanceDays: '30',
  cancellationPolicyHours: '24',
  cancellationFeePercent: '0',
};

const FIELDS_QUERY =
  'id name slug description logoUrl coverImageUrl timezone latitude longitude ' +
  'address { street number city state zip country } ' +
  'contactInfo { phone email whatsapp } ' +
  'slotDurationMinutes bufferMinutes minAdvanceHours maxAdvanceDays ' +
  'cancellationPolicyHours cancellationFeePercent ' +
  'businessHours { dayOfWeek openTime closeTime isClosed breakStartTime breakEndTime }';

type ShopData = Record<string, unknown> & {
  address?: Record<string, string>;
  contactInfo?: Record<string, string>;
  businessHours?: BusinessHourSlot[];
};

export default function AdminBarbershopEditPage() {
  const t = useT('admin');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();
  const id = params.id as string;

  const form = useFormState(INITIAL);
  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shopName, setShopName] = useState('');

  const fetchShop = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.getById('barbershop', id, FIELDS_QUERY);
      if (result) {
        const data = result as ShopData;
        const addr = data.address ?? {};
        const contact = data.contactInfo ?? {};

        setShopName(String(data.name ?? ''));
        form.setValues({
          name: String(data.name ?? ''),
          slug: String(data.slug ?? ''),
          description: String(data.description ?? ''),
          logoUrl: String(data.logoUrl ?? ''),
          coverImageUrl: String(data.coverImageUrl ?? ''),
          timezone: String(data.timezone ?? ''),
          street: addr.street ?? '',
          number: addr.number ?? '',
          city: addr.city ?? '',
          state: addr.state ?? '',
          zip: addr.zip ?? '',
          country: addr.country ?? 'AR',
          phone: contact.phone ?? '',
          email: contact.email ?? '',
          whatsapp: contact.whatsapp ?? '',
          latitude: data.latitude != null ? String(data.latitude) : '',
          longitude: data.longitude != null ? String(data.longitude) : '',
          slotDurationMinutes: String(data.slotDurationMinutes ?? 45),
          bufferMinutes: String(data.bufferMinutes ?? 10),
          minAdvanceHours: String(data.minAdvanceHours ?? 2),
          maxAdvanceDays: String(data.maxAdvanceDays ?? 30),
          cancellationPolicyHours: String(data.cancellationPolicyHours ?? 24),
          cancellationFeePercent: String(data.cancellationFeePercent ?? 0),
        });
        if (Array.isArray(data.businessHours) && data.businessHours.length > 0) {
          setBusinessHours(data.businessHours);
        }
      }
    } catch {
      // handled by empty form
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id]);

  useEffect(() => {
    fetchShop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    if (!form.values.name.trim()) {
      form.setError('name', t('required', 'Campo obligatorio'));
      return;
    }

    setSaving(true);
    try {
      await client.update('barbershop', id, {
        name: form.values.name,
        slug: form.values.slug,
        description: form.values.description,
        logoUrl: form.values.logoUrl,
        coverImageUrl: form.values.coverImageUrl,
        timezone: form.values.timezone,
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
      });
      router.push(`/admin/barbershops/${id}/view`);
    } catch (err) {
      console.error('Save failed:', err);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="material-symbols-outlined text-primary text-4xl animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader
        title={t('editBarbershop', 'Editar Barbería')}
        subtitle={shopName}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('barbershops', 'Barberías'), href: '/admin/barbershops' },
          { label: shopName || '…', href: `/admin/barbershops/${id}/view` },
          { label: t('edit', 'Editar') },
        ]}
      />

      <FormLayout>
        <div className="space-y-8">
          {/* Basic info + images */}
          <FormSection title={t('basicInfo', 'Datos Básicos')} icon="storefront">
            <FormField
              label={t('name', 'Nombre')}
              value={form.values.name}
              onChange={(v) => form.setValue('name', v)}
              error={form.errors.name}
              required
            />
            <FormField
              label="Slug"
              value={form.values.slug}
              onChange={(v) => form.setValue('slug', v)}
            />
            <FormTextarea
              label={t('description', 'Descripción')}
              value={form.values.description}
              onChange={(v) => form.setValue('description', v)}
              rows={3}
            />
            <FormField
              label="Timezone"
              value={form.values.timezone}
              onChange={(v) => form.setValue('timezone', v)}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormImageUpload
                label={t('logo', 'Logo')}
                value={form.values.logoUrl}
                onChange={(v) => form.setValue('logoUrl', v)}
                variant="square"
                hint="SVG, PNG o JPG"
              />
              <FormImageUpload
                label={t('coverImage', 'Imagen de Portada')}
                value={form.values.coverImageUrl}
                onChange={(v) => form.setValue('coverImageUrl', v)}
                variant="wide"
                hint="1920×820px"
              />
            </div>
          </FormSection>

          {/* Address */}
          <FormSection title={t('address', 'Dirección')} icon="location_on">
            <FormField
              label={t('street', 'Calle')}
              value={form.values.street}
              onChange={(v) => form.setValue('street', v)}
              placeholder="Av. Libertador"
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
              />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <FormSelect
                label={t('stateProvince', 'Provincia')}
                value={form.values.state}
                onChange={(v) => form.setValue('state', v)}
                options={PROVINCES}
                placeholder={t('selectProvince', 'Seleccionar')}
              />
              <FormField
                label={t('zipCode', 'Código Postal')}
                value={form.values.zip}
                onChange={(v) => form.setValue('zip', v)}
              />
            </div>
            <FormSelect
              label={t('country', 'País')}
              value={form.values.country}
              onChange={(v) => form.setValue('country', v)}
              options={COUNTRIES}
            />
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

          {/* Contact */}
          <FormSection title={t('contact', 'Contacto')} icon="phone">
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

          {/* Schedule */}
          <FormSection title={t('weeklySchedule', 'Horarios de Atención')} icon="schedule">
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

          {/* Cancellation */}
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

          <FormActions
            onCancel={() => router.push(`/admin/barbershops/${id}/view`)}
            onSubmit={handleSave}
            submitLabel={t('save', 'Guardar')}
            cancelLabel={t('cancel', 'Cancelar')}
            loading={saving}
            disabled={!form.isDirty}
          />
        </div>
      </FormLayout>
    </div>
  );
}
