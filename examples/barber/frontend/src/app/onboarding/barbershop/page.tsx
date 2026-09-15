'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useAuth } from '@/lib/authContext';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { StepIndicator } from '@/components/shared/booking';
import { BusinessHoursEditor } from '@/components/shared/hours';
import { LocationPicker } from '@/components/shared/maps';
import {
  FormField,
  FormTextarea,
  FormImageUpload,
  FormSelect,
  FormSection,
} from '@/components/shared/form';
import {
  Button,
  Eyebrow,
  InfoBanner,
  SectionTitle,
  Surface,
  TipCard,
} from '@/components/shared/ui';
import type { BusinessHourSlot } from '@/components/shared/hours';
import { cn } from '@/lib/cn';

const STEP_IDS = ['basics', 'location', 'schedule', 'confirm'] as const;
type StepId = (typeof STEP_IDS)[number];

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
  instagramUrl: string;
  facebookUrl: string;
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
  instagramUrl: '',
  facebookUrl: '',
  slotDurationMinutes: '45',
  bufferMinutes: '10',
  minAdvanceHours: '2',
  maxAdvanceDays: '30',
  cancellationPolicyHours: '24',
  cancellationFeePercent: '0',
  latitude: '',
  longitude: '',
};

const DEFAULT_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  openTime: '09:00',
  closeTime: '18:00',
  isClosed: i === 6,
}));

export default function OnboardingBarbershopPage() {
  const router = useRouter();
  const client = useSimfinityClient();
  const { user } = useAuth();
  const t = useT('onboarding');

  const [stepIdx, setStepIdx] = useState(0);
  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const { values, setValue, errors, setError } = useFormState<FormData>(INITIAL);

  const steps = useMemo(
    () => [
      { id: 'basics', label: t('step1', 'Datos básicos') },
      { id: 'location', label: t('step2', 'Ubicación') },
      { id: 'schedule', label: t('step3', 'Horarios') },
      { id: 'confirm', label: t('step4', 'Confirmación') },
    ],
    [t],
  );

  const currentStepId = STEP_IDS[stepIdx];

  function validateStep(): boolean {
    let valid = true;
    if (currentStepId === 'basics') {
      if (!values.name.trim()) {
        setError('name', t('required', 'Campo requerido'));
        valid = false;
      }
      if (!values.slug.trim()) {
        setError('slug', t('required', 'Campo requerido'));
        valid = false;
      }
    }
    if (currentStepId === 'location') {
      if (!values.street.trim()) {
        setError('street', t('required', 'Campo requerido'));
        valid = false;
      }
      if (!values.city.trim()) {
        setError('city', t('required', 'Campo requerido'));
        valid = false;
      }
    }
    return valid;
  }

  function goNext() {
    if (!validateStep()) return;
    setStepIdx((i) => Math.min(i + 1, STEP_IDS.length - 1));
  }

  function goBack() {
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const payload = {
        owner: { id: user?.id },
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
          instagramUrl: values.instagramUrl || undefined,
          facebookUrl: values.facebookUrl || undefined,
        },
        timezone,
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
      };
      const result = await client.add('barbershop', payload) as { id: string };
      await client.transition('barbershop', 'submitforreview', result.id);
      router.push('/dashboard');
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t('submitError', 'Error al crear la barbería'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function autoSlug(name: string) {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }


  return (
    <div className="max-w-4xl mx-auto space-y-10">
      {/* Step indicator */}
      <div>
        <StepIndicator steps={steps} currentStep={currentStepId} />
        <div className="flex justify-end mt-3">
          <Eyebrow>{t('stepOf', `Paso ${stepIdx + 1} de ${STEP_IDS.length}`)}</Eyebrow>
        </div>
      </div>

      {/* Step 1: Datos básicos */}
      {currentStepId === 'basics' && (
        <div className="space-y-10">
          <SectionTitle
            heading={t('step1Title', 'Tu Barbería')}
            subtitle={t(
              'step1Subtitle',
              'Comencemos por definir la identidad visual y el nombre de tu santuario de estilo.',
            )}
          />

          <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
            {/* Left column: images + tip */}
            <div className="md:col-span-4 space-y-8">
              <FormImageUpload
                label={t('logo', 'Logo del Negocio')}
                value={values.logoUrl}
                onChange={(v) => setValue('logoUrl', v)}
                variant="square"
                hint={t('logoHint', 'SVG, PNG o JPG (cuadrado recomendado)')}
              />

              <TipCard title={t('tipTitle', 'Consejo Editorial')}>
                {t(
                  'tipBody',
                  '"El nombre es el primer aroma que percibe el cliente. Elige algo que evoque herencia y precisión."',
                )}
              </TipCard>
            </div>

            {/* Right column: fields */}
            <div className="md:col-span-8 space-y-8">
              <FormField
                label={t('shopName', 'Nombre del Negocio')}
                value={values.name}
                onChange={(v) => {
                  setValue('name', v);
                  if (!values.slug || values.slug === autoSlug(values.name)) {
                    setValue('slug', autoSlug(v));
                  }
                }}
                placeholder={t('shopNamePlaceholder', 'Ej. The Heritage Cut & Shave')}
                error={errors.name}
                required
              />

              <FormField
                label={t('slug', 'URL Slug')}
                value={values.slug}
                onChange={(v) => setValue('slug', v)}
                placeholder="mi-barberia"
                error={errors.slug}
                required
              />

              <FormTextarea
                label={t('description', 'Descripción Corta')}
                value={values.description}
                onChange={(v) => setValue('description', v)}
                placeholder={t(
                  'descPlaceholder',
                  'Una breve reseña sobre la experiencia y el arte que ofreces...',
                )}
                rows={3}
              />

              <FormImageUpload
                label={t('coverImage', 'Imagen de Portada')}
                value={values.coverImageUrl}
                onChange={(v) => setValue('coverImageUrl', v)}
                variant="wide"
                hint={t('coverHint', 'Recomendado: 1920×820px')}
              />
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Ubicación y contacto */}
      {currentStepId === 'location' && (
        <div className="space-y-10">
          <SectionTitle
            heading={t('step2Title', 'Donde ocurre la magia.')}
            subtitle={t(
              'step2Subtitle',
              'Define la ubicación de tu estudio y los medios de contacto directo para tus clientes.',
            )}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
            <div className="lg:col-span-7 space-y-10">
              <FormSection title={t('studioAddress', 'Dirección del Estudio')} icon="location_on">
                <FormField
                  label={t('street', 'Calle')}
                  value={values.street}
                  onChange={(v) => setValue('street', v)}
                  placeholder={t('streetPlaceholder', 'Av. Libertador')}
                  error={errors.street}
                  required
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
                    placeholder={t('cityPlaceholder', 'Ciudad')}
                    error={errors.city}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <FormSelect
                    label={t('province', 'Provincia')}
                    value={values.state}
                    onChange={(v) => setValue('state', v)}
                    options={PROVINCES}
                    placeholder={t('selectProvince', 'Seleccionar provincia')}
                  />
                  <FormField
                    label={t('zip', 'Código Postal')}
                    value={values.zip}
                    onChange={(v) => setValue('zip', v)}
                    placeholder="C1425"
                  />
                </div>
                <FormSelect
                  label={t('country', 'País')}
                  value={values.country}
                  onChange={(v) => setValue('country', v)}
                  options={COUNTRIES}
                />
              </FormSection>

              <FormSection title={t('directContact', 'Contacto Directo')} icon="call">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    label={t('phone', 'Teléfono')}
                    value={values.phone}
                    onChange={(v) => setValue('phone', v)}
                    type="tel"
                    placeholder="+54 11 0000 0000"
                  />
                  <FormField
                    label={t('email', 'Email')}
                    value={values.email}
                    onChange={(v) => setValue('email', v)}
                    type="email"
                    placeholder="info@tubarberia.com"
                  />
                  <FormField
                    label={t('whatsapp', 'WhatsApp Business')}
                    value={values.whatsapp}
                    onChange={(v) => setValue('whatsapp', v)}
                    type="tel"
                    placeholder="+54 9 11 0000 0000"
                  />
                  <FormField
                    label={t('instagram', 'Instagram')}
                    value={values.instagramUrl}
                    onChange={(v) => setValue('instagramUrl', v)}
                    placeholder="https://instagram.com/tubarberia"
                  />
                </div>
                <FormField
                  label={t('facebook', 'Facebook')}
                  value={values.facebookUrl}
                  onChange={(v) => setValue('facebookUrl', v)}
                  placeholder="https://facebook.com/tubarberia"
                />
              </FormSection>
            </div>

            <div className="lg:col-span-5 sticky top-32">
              <FormSection title={t('coordinates', 'Coordenadas')} icon="my_location">
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
              </FormSection>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Horarios y configuración */}
      {currentStepId === 'schedule' && (
        <div className="space-y-10">
          <SectionTitle
            heading={t('step3Title', 'Horarios y Configuración')}
            subtitle={t(
              'step3Subtitle',
              'Define tu disponibilidad semanal y las reglas de reserva.',
            )}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
            <div className="lg:col-span-8 space-y-8">
              <FormSection title={t('weeklyAvailability', 'Disponibilidad Semanal')} icon="schedule">
                <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} />
              </FormSection>
            </div>

            <div className="lg:col-span-4 space-y-8">
              <FormSection title={t('bookingProtocol', 'Protocolo de Reserva')} icon="event_available">
                <FormSelect
                  label={t('slotDuration', 'Duración de Slots')}
                  value={values.slotDurationMinutes}
                  onChange={(v) => setValue('slotDurationMinutes', v)}
                  options={SLOT_DURATIONS}
                />
                <FormSelect
                  label={t('buffer', 'Buffer entre turnos')}
                  value={values.bufferMinutes}
                  onChange={(v) => setValue('bufferMinutes', v)}
                  options={BUFFER_OPTIONS}
                />
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
              </FormSection>

              <FormSection title={t('cancellation', 'Política de Cancelación')} icon="event_busy">
                <FormField
                  label={t('cancellationHours', 'Horas límite para cancelar')}
                  value={values.cancellationPolicyHours}
                  onChange={(v) => setValue('cancellationPolicyHours', v)}
                  type="number"
                />
                <FormField
                  label={t('cancellationFee', 'Cargo por cancelación (%)')}
                  value={values.cancellationFeePercent}
                  onChange={(v) => setValue('cancellationFeePercent', v)}
                  type="number"
                />
              </FormSection>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: Confirmación */}
      {currentStepId === 'confirm' && (
        <div className="space-y-10">
          <header className="grid grid-cols-1 md:grid-cols-12 gap-8 items-end">
            <div className="md:col-span-8">
              <Eyebrow className="mb-4 font-semibold block">
                {t('finalStep', 'Paso Final')}
              </Eyebrow>
              <h1 className="font-headline italic text-5xl text-on-surface tracking-tight">
                {t('step4Title', '¡Listo para enviar!')}
              </h1>
            </div>
            <div className="md:col-span-4 text-right">
              <p className="text-on-surface-variant text-sm leading-relaxed">
                {t(
                  'step4Subtitle',
                  'Revisá los detalles finales antes de crear tu barbería.',
                )}
              </p>
            </div>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            {/* Summary */}
            <div className="lg:col-span-2 space-y-8">
              <Surface tone="summary" padding="lg" radius="xl">
                <h2 className="text-2xl font-headline italic mb-8">
                  {t('profileSummary', 'Resumen del Perfil')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-y-8 gap-x-12">
                  <SummaryItem
                    label={t('shopName', 'Nombre')}
                    value={values.name || '—'}
                  />
                  <SummaryItem label={t('slug', 'Slug')} value={values.slug || '—'} />
                  <SummaryItem
                    label={t('address', 'Dirección')}
                    value={
                      [values.street, values.number, values.city, values.state]
                        .filter(Boolean)
                        .join(', ') || '—'
                    }
                  />
                  <SummaryItem
                    label={t('schedule', 'Disponibilidad')}
                    value={
                      businessHours.filter((h) => !h.isClosed).length +
                      ` ${t('daysPerWeek', 'días por semana')}`
                    }
                  />
                  <SummaryItem
                    label={t('slotDuration', 'Duración de Slots')}
                    value={`${values.slotDurationMinutes} min`}
                  />
                  <SummaryItem
                    label={t('cancellation', 'Cancelación')}
                    value={`${values.cancellationPolicyHours}hs / ${values.cancellationFeePercent}%`}
                  />
                </div>
              </Surface>
            </div>

            {/* Checklist */}
            <div className="space-y-8">
              <Surface tone="high" padding="lg" radius="xl">
                <h3 className="text-xs uppercase tracking-[0.2em] font-bold mb-8 text-on-surface-variant">
                  {t('verificationStatus', 'Estado de Verificación')}
                </h3>
                <ul className="space-y-5">
                  <CheckItem
                    label={t('checkBasicData', 'Datos Básicos')}
                    done={!!values.name && !!values.slug}
                  />
                  <CheckItem
                    label={t('checkLocation', 'Ubicación y Contacto')}
                    done={!!values.street && !!values.city}
                  />
                  <CheckItem
                    label={t('checkSchedule', 'Horarios Configurados')}
                    done={businessHours.some((h) => !h.isClosed)}
                  />
                  <CheckItem
                    label={t('checkImages', 'Imágenes Cargadas')}
                    done={!!values.logoUrl || !!values.coverImageUrl}
                  />
                </ul>
              </Surface>

              <InfoBanner icon="info" title={t('reviewProcess', 'Proceso de Revisión')}>
                {t(
                  'reviewProcessBody',
                  'Una vez enviado, nuestro equipo revisará tu solicitud en un plazo de 24 a 48 horas. Recibirás una notificación por correo electrónico.',
                )}
              </InfoBanner>

              {submitError && (
                <div className="p-4 rounded-xl border border-error/20 bg-error/5 text-error text-sm">
                  {submitError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer navigation */}
      <footer className="border-t border-outline-variant/10 pt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={stepIdx === 0 ? () => router.push('/dashboard') : goBack}
          className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors text-[10px] uppercase tracking-widest font-bold"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          {stepIdx === 0 ? t('cancel', 'Cancelar') : t('back', 'Atrás')}
        </button>

        <div className="flex items-center gap-6">
          {currentStepId === 'confirm' ? (
            <Button
              type="button"
              variant="gold"
              size="lg"
              onClick={handleSubmit}
              disabled={submitting}
              className="gap-3 text-on-primary-container"
            >
              {submitting ? (
                <span className="material-symbols-outlined text-lg animate-spin">
                  progress_activity
                </span>
              ) : (
                <span className="material-symbols-outlined text-lg">storefront</span>
              )}
              {submitting
                ? t('creating', 'Creando...')
                : t('createBarbershop', 'Crear Barbería')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="gold"
              size="lg"
              onClick={goNext}
              className="gap-2 text-on-primary-container"
            >
              {t('nextStep', 'Siguiente Paso')}
              <span className="material-symbols-outlined text-lg">arrow_forward</span>
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-[0.15em] text-on-surface-variant">{label}</p>
      <p className="text-on-surface font-medium">{value}</p>
    </div>
  );
}

function CheckItem({ label, done }: { label: string; done: boolean }) {
  return (
    <li className="flex items-center gap-4">
      <span
        className={cn(
          'material-symbols-outlined text-xl',
          done ? 'text-primary' : 'text-on-surface-variant/30',
        )}
        style={done ? { fontVariationSettings: "'FILL' 1" } : undefined}
      >
        {done ? 'check_circle' : 'radio_button_unchecked'}
      </span>
      <span
        className={cn(
          'text-sm font-medium',
          done ? '' : 'text-on-surface-variant/50',
        )}
      >
        {label}
      </span>
    </li>
  );
}
