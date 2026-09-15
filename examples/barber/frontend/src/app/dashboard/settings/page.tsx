'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { useBarbershop } from '@/lib/barbershopContext';
import { PageHeader } from '@/components/shared/page';
import { BusinessHoursEditor } from '@/components/shared/hours';
import { LocationPicker } from '@/components/shared/maps';
import {
  FormField,
  FormTextarea,
  FormImageUpload,
  FormSelect,
  FormSection,
} from '@/components/shared/form';
import type { BusinessHourSlot } from '@/components/shared/hours';
import { Button } from '@/components/shared/ui';
import { cn } from '@/lib/cn';

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

type SettingsForm = {
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
  latitude: string;
  longitude: string;
  slotDurationMinutes: string;
  bufferMinutes: string;
  minAdvanceHours: string;
  maxAdvanceDays: string;
  cancellationPolicyHours: string;
  cancellationFeePercent: string;
};

const INITIAL: SettingsForm = {
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
  latitude: '',
  longitude: '',
  slotDurationMinutes: '45',
  bufferMinutes: '10',
  minAdvanceHours: '2',
  maxAdvanceDays: '30',
  cancellationPolicyHours: '24',
  cancellationFeePercent: '0',
};

const DEFAULT_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  openTime: '09:00',
  closeTime: '18:00',
  isClosed: i === 6,
}));

const FIELDS_QUERY =
  'id name slug description logoUrl coverImageUrl latitude longitude ' +
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

type ServiceCategory = { id: string; name: string };

export default function OwnerSettingsPage() {
  const client = useSimfinityClient();
  const t = useT('dashboard');
  const { selectedBarbershop } = useBarbershop();

  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const [categories, setCategories] = useState<ServiceCategory[]>([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [categorySaving, setCategorySaving] = useState(false);
  const newCategoryRef = useRef<HTMLInputElement>(null);

  const { values, setValue, setValues, errors, isDirty } = useFormState<SettingsForm>(INITIAL);

  const fetchBarbershop = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      const result = await client.getById('barbershop', selectedBarbershop.id, FIELDS_QUERY);
      if (result) {
        const shop = result as ShopData;
        const addr = shop.address ?? {};
        const contact = shop.contactInfo ?? {};
        setValues({
          name: String(shop.name ?? ''),
          slug: String(shop.slug ?? ''),
          description: String(shop.description ?? ''),
          logoUrl: String(shop.logoUrl ?? ''),
          coverImageUrl: String(shop.coverImageUrl ?? ''),
          street: addr.street ?? '',
          number: addr.number ?? '',
          city: addr.city ?? '',
          state: addr.state ?? '',
          zip: addr.zip ?? '',
          country: addr.country ?? 'AR',
          phone: contact.phone ?? '',
          email: contact.email ?? '',
          whatsapp: contact.whatsapp ?? '',
          latitude: shop.latitude != null ? String(shop.latitude) : '',
          longitude: shop.longitude != null ? String(shop.longitude) : '',
          slotDurationMinutes: String(shop.slotDurationMinutes ?? 45),
          bufferMinutes: String(shop.bufferMinutes ?? 10),
          minAdvanceHours: String(shop.minAdvanceHours ?? 2),
          maxAdvanceDays: String(shop.maxAdvanceDays ?? 30),
          cancellationPolicyHours: String(shop.cancellationPolicyHours ?? 24),
          cancellationFeePercent: String(shop.cancellationFeePercent ?? 0),
        });
        if (Array.isArray(shop.businessHours) && shop.businessHours.length > 0) {
          setBusinessHours(shop.businessHours);
        }
      }
    } catch {
      // keep defaults
    } finally {
      setLoading(false);
    }
  }, [client, selectedBarbershop?.id, setValues]);

  const fetchCategories = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    try {
      const result = await client
        .find('serviceCategory')
        .fields('id name')
        .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
        .exec();
      setCategories((result as ServiceCategory[]) ?? []);
    } catch {
      setCategories([]);
    }
  }, [client, selectedBarbershop?.id]);

  useEffect(() => {
    fetchBarbershop();
    fetchCategories();
  }, [fetchBarbershop, fetchCategories]);

  async function handleAddCategory() {
    if (!newCategoryName.trim() || !selectedBarbershop?.id) return;
    setCategorySaving(true);
    try {
      await client.add('serviceCategory', {
        name: newCategoryName.trim(),
        barbershop: { id: selectedBarbershop.id },
      });
      setNewCategoryName('');
      await fetchCategories();
    } catch {
      /* ignore */
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleUpdateCategory(catId: string) {
    if (!editingCategoryName.trim()) return;
    setCategorySaving(true);
    try {
      await client.update('serviceCategory', catId, {
        name: editingCategoryName.trim(),
      });
      setEditingCategoryId(null);
      setEditingCategoryName('');
      await fetchCategories();
    } catch {
      /* ignore */
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleDeleteCategory(catId: string) {
    setCategorySaving(true);
    try {
      await client.delete('serviceCategory', catId);
      await fetchCategories();
    } catch {
      /* ignore */
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleSave() {
    if (!selectedBarbershop?.id) return;
    setSaving(true);
    setSaveMessage('');
    try {
      await client.update('barbershop', selectedBarbershop.id, {
        name: values.name,
        slug: values.slug,
        description: values.description,
        logoUrl: values.logoUrl,
        coverImageUrl: values.coverImageUrl,
        address: {
          street: values.street,
          number: values.number,
          city: values.city,
          state: values.state,
          zip: values.zip,
          country: values.country,
        },
        contactInfo: {
          phone: values.phone,
          email: values.email,
          whatsapp: values.whatsapp,
        },
        ...(values.latitude ? { latitude: Number(values.latitude) } : {}),
        ...(values.longitude ? { longitude: Number(values.longitude) } : {}),
        slotDurationMinutes: Number(values.slotDurationMinutes),
        bufferMinutes: Number(values.bufferMinutes),
        minAdvanceHours: Number(values.minAdvanceHours),
        maxAdvanceDays: Number(values.maxAdvanceDays),
        cancellationPolicyHours: Number(values.cancellationPolicyHours),
        cancellationFeePercent: Number(values.cancellationFeePercent),
        businessHours: businessHours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime,
          closeTime: h.closeTime,
          isClosed: h.isClosed,
          breakStartTime: h.breakStartTime,
          breakEndTime: h.breakEndTime,
        })),
      });
      setSaveMessage(t('saveSuccess', 'Cambios guardados correctamente'));
      setTimeout(() => setSaveMessage(''), 4000);
    } catch (err) {
      setSaveMessage(
        err instanceof Error ? err.message : t('saveError', 'Error al guardar los cambios'),
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    fetchBarbershop();
    setSaveMessage('');
  }

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
    <div className="max-w-6xl space-y-12">
      <PageHeader
        title={t('settingsTitle', 'Configuración de Barbería')}
        subtitle={t('settingsSubtitle', 'Gestiona la información, horarios y políticas de tu establecimiento.')}
      />

      {/* General Info */}
      <section className="space-y-8">
        <SectionDivider label={t('generalInfo', 'Información General')} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          <div className="md:col-span-1">
            <FormImageUpload
              label={t('logo', 'Logotipo Principal')}
              value={values.logoUrl}
              onChange={(v) => setValue('logoUrl', v)}
              variant="square"
              hint="SVG / PNG"
            />
          </div>
          <div className="md:col-span-2 space-y-6">
            <FormField
              label={t('shopName', 'Nombre del Establecimiento')}
              value={values.name}
              onChange={(v) => setValue('name', v)}
              error={errors.name}
              required
            />
            <FormTextarea
              label={t('editorialDescription', 'Descripción Editorial')}
              value={values.description}
              onChange={(v) => setValue('description', v)}
              rows={4}
            />
          </div>
        </div>
      </section>

      {/* Location & Schedule side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Location */}
        <section className="space-y-8">
          <SectionDivider label={t('strategicLocation', 'Ubicación Estratégica')} />
          <FormField
            label={t('street', 'Calle')}
            value={values.street}
            onChange={(v) => setValue('street', v)}
            placeholder="Av. Libertador"
          />
          <div className="grid grid-cols-2 gap-6">
            <FormField
              label={t('streetNumber', 'Número')}
              value={values.number}
              onChange={(v) => setValue('number', v)}
              placeholder="1450"
            />
            <FormField
              label={t('city', 'Ciudad')}
              value={values.city}
              onChange={(v) => setValue('city', v)}
            />
          </div>
          <div className="grid grid-cols-2 gap-6">
            <FormSelect
              label={t('province', 'Provincia')}
              value={values.state}
              onChange={(v) => setValue('state', v)}
              options={PROVINCES}
              placeholder={t('selectProvince', 'Seleccionar')}
            />
            <FormSelect
              label={t('country', 'País')}
              value={values.country}
              onChange={(v) => setValue('country', v)}
              options={COUNTRIES}
            />
          </div>
          <FormField
            label={t('zip', 'Código Postal')}
            value={values.zip}
            onChange={(v) => setValue('zip', v)}
            placeholder="C1425"
          />
          <LocationPicker
            value={
              values.latitude && values.longitude
                ? [Number(values.latitude), Number(values.longitude)]
                : null
            }
            onChange={(lat, lng) => {
              setValue('latitude', String(lat));
              setValue('longitude', String(lng));
            }}
          />
        </section>

        {/* Schedule */}
        <section className="space-y-8">
          <SectionDivider label={t('weeklySchedule', 'Cronograma Semanal')} />
          <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} />
        </section>
      </div>

      {/* Booking & Cancellation */}
      <div className="grid grid-cols-12 gap-10">
        <div className="col-span-12 lg:col-span-6 space-y-8">
          <SectionDivider label={t('bookingProtocol', 'Protocolo de Reserva')} />
          <div className="grid grid-cols-2 gap-6">
            <FormSection title={t('slotDuration', 'Duración de Slots')} icon="timer">
              <FormSelect
                label={t('minutes', 'Minutos')}
                value={values.slotDurationMinutes}
                onChange={(v) => setValue('slotDurationMinutes', v)}
                options={SLOT_DURATIONS}
              />
            </FormSection>
            <FormSection title={t('buffer', 'Buffer entre Turnos')} icon="hourglass_empty">
              <FormSelect
                label={t('minutes', 'Minutos')}
                value={values.bufferMinutes}
                onChange={(v) => setValue('bufferMinutes', v)}
                options={BUFFER_OPTIONS}
              />
            </FormSection>
          </div>
          <div className="grid grid-cols-2 gap-6">
            <FormField
              label={t('minAdvance', 'Anticipación mínima (horas)')}
              value={values.minAdvanceHours}
              onChange={(v) => setValue('minAdvanceHours', v)}
              type="number"
            />
            <FormField
              label={t('maxAdvance', 'Anticipación máxima (días)')}
              value={values.maxAdvanceDays}
              onChange={(v) => setValue('maxAdvanceDays', v)}
              type="number"
            />
          </div>
        </div>

        <div className="col-span-12 lg:col-span-6 space-y-8">
          <SectionDivider label={t('cancellationPolicy', 'Política de Cancelación')} />
          <div className="grid grid-cols-2 gap-6">
            <FormSection title={t('cancellationLimit', 'Cancelación Límite')} icon="event_busy">
              <FormField
                label={t('hours', 'Horas')}
                value={values.cancellationPolicyHours}
                onChange={(v) => setValue('cancellationPolicyHours', v)}
                type="number"
              />
            </FormSection>
            <FormSection title={t('cancellationFee', 'Cargo (%)')} icon="payments">
              <FormField
                label={t('percent', '%')}
                value={values.cancellationFeePercent}
                onChange={(v) => setValue('cancellationFeePercent', v)}
                type="number"
              />
            </FormSection>
          </div>
        </div>
      </div>

      {/* Contact */}
      <section className="space-y-8">
        <SectionDivider label={t('contact', 'Contacto')} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FormField
            label={t('phone', 'Teléfono')}
            value={values.phone}
            onChange={(v) => setValue('phone', v)}
            type="tel"
            placeholder="+54 11 0000 0000"
          />
          <FormField
            label="Email"
            value={values.email}
            onChange={(v) => setValue('email', v)}
            type="email"
            placeholder="info@barberia.com"
          />
          <FormField
            label="WhatsApp"
            value={values.whatsapp}
            onChange={(v) => setValue('whatsapp', v)}
            type="tel"
            placeholder="+54 9 11 0000 0000"
          />
        </div>
      </section>

      {/* Service Categories */}
      <section className="space-y-8">
        <SectionDivider label={t('serviceCategories', 'Categorías de Servicio')} />

        <div className="space-y-3">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className="flex items-center gap-3 bg-surface-container-low/50 rounded-xl px-4 py-3 group"
            >
              {editingCategoryId === cat.id ? (
                <>
                  <input
                    value={editingCategoryName}
                    onChange={(e) => setEditingCategoryName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpdateCategory(cat.id)}
                    className="flex-1 bg-transparent border-b border-primary/30 text-sm text-on-surface focus:outline-none focus:border-primary py-1"
                    autoFocus
                  />
                  <button
                    onClick={() => handleUpdateCategory(cat.id)}
                    disabled={categorySaving}
                    className="text-primary text-xs font-bold tracking-wider hover:underline disabled:opacity-50"
                  >
                    {t('categorySave', 'Guardar')}
                  </button>
                  <button
                    onClick={() => { setEditingCategoryId(null); setEditingCategoryName(''); }}
                    className="text-on-surface/40 text-xs hover:text-on-surface"
                  >
                    {t('categoryCancel', 'Cancelar')}
                  </button>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-primary/40 text-sm">label</span>
                  <span className="flex-1 text-sm text-on-surface">{cat.name}</span>
                  <button
                    onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                    className="opacity-0 group-hover:opacity-100 text-on-surface/40 hover:text-primary transition-opacity"
                    title={t('categoryEdit', 'Editar')}
                  >
                    <span className="material-symbols-outlined text-sm">edit</span>
                  </button>
                  <button
                    onClick={() => handleDeleteCategory(cat.id)}
                    disabled={categorySaving}
                    className="opacity-0 group-hover:opacity-100 text-on-surface/40 hover:text-error transition-opacity disabled:opacity-50"
                    title={t('categoryDelete', 'Eliminar')}
                  >
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                </>
              )}
            </div>
          ))}

          {categories.length === 0 && (
            <p className="text-sm text-on-surface/40 italic py-2">
              {t('noCategories', 'No hay categorías creadas')}
            </p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <input
              ref={newCategoryRef}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              placeholder={t('newCategoryPlaceholder', 'Nueva categoría...')}
              className="flex-1 bg-surface-container-high rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder-on-surface/30 border-none focus:ring-1 focus:ring-primary/40"
            />
            <button
              onClick={handleAddCategory}
              disabled={categorySaving || !newCategoryName.trim()}
              className="bg-primary/10 border border-primary/20 text-primary px-5 py-2.5 rounded-lg text-xs font-bold tracking-widest hover:bg-primary hover:text-on-primary transition-all disabled:opacity-40"
            >
              + {t('addCategory', 'AGREGAR')}
            </button>
          </div>
        </div>
      </section>

      {/* Save message */}
      {saveMessage && (
        <div
          className={cn(
            'p-4 rounded-xl text-sm',
            saveMessage.toLowerCase().includes('error')
              ? 'border border-error/20 bg-error/5 text-error'
              : 'border border-primary/20 bg-primary/5 text-primary',
          )}
        >
          {saveMessage}
        </div>
      )}

      {/* Sticky footer actions */}
      <div className="flex items-center justify-end gap-4 border-t border-outline-variant/10 pt-8">
        <button
          type="button"
          onClick={handleDiscard}
          disabled={!isDirty || saving}
          className="px-8 py-3 text-xs font-bold uppercase tracking-widest text-on-surface/60 hover:text-on-surface transition-colors disabled:opacity-30"
        >
          {t('discardChanges', 'Descartar Cambios')}
        </button>
        <Button
          type="button"
          variant="gold"
          size="form"
          onClick={handleSave}
          disabled={saving}
          className="gap-2 text-on-primary"
        >
          {saving && (
            <span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>
          )}
          <span className="material-symbols-outlined text-lg">save</span>
          {t('saveChanges', 'Guardar Cambios')}
        </Button>
      </div>
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4">
      <h4 className="text-[10px] uppercase tracking-[0.4em] text-on-surface/40 whitespace-nowrap">
        {label}
      </h4>
      <span className="h-px flex-1 bg-outline-variant/10" />
    </div>
  );
}
