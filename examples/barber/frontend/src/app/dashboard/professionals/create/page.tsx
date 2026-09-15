'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { useBarbershop } from '@/lib/barbershopContext';
import {
  PageHeader,
  FormLayout,
  FormField,
  FormTextarea,
  FormImageUpload,
  FormSidePanel,
  FormSection,
  FormActions,
} from '@/components/shared';
import { BusinessHoursEditor, type BusinessHourSlot } from '@/components/shared/hours';

type ProfessionalForm = {
  name: string;
  bio: string;
  photoUrl: string;
};

const DEFAULT_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  openTime: '09:00',
  closeTime: '18:00',
  isClosed: i === 0,
}));

export default function CreateProfessionalPage() {
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('professionals');
  const { selectedBarbershop } = useBarbershop();
  const [saving, setSaving] = useState(false);
  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);

  const { values, errors, setValue, setError, clearErrors } = useFormState<ProfessionalForm>({
    name: '',
    bio: '',
    photoUrl: '',
  });

  function validate(): boolean {
    clearErrors();
    let valid = true;
    if (!values.name.trim()) {
      setError('name', t('nameRequired', 'El nombre es obligatorio'));
      valid = false;
    }
    return valid;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      await client.add('professional', {
        name: values.name.trim(),
        bio: values.bio.trim(),
        photoUrl: values.photoUrl || undefined,
        isActive: true,
        barbershop: { id: selectedBarbershop!.id },
        businessHours: businessHours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime,
          closeTime: h.closeTime,
          isClosed: h.isClosed,
          breakStartTime: h.breakStartTime,
          breakEndTime: h.breakEndTime,
        })),
      });
      router.push('/dashboard/professionals');
    } catch {
      setError('name', t('saveError', 'Error al guardar. Intenta de nuevo.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('createTitle', 'Registrar Nuevo Talento')}
        subtitle={t('createSubtitle', 'Añade un nuevo profesional a la plantilla.')}
        breadcrumbs={[
          { label: t('breadcrumbList', 'Profesionales'), href: '/dashboard/professionals' },
          { label: t('breadcrumbCreate', 'Crear profesional') },
        ]}
      />

      <FormLayout
        sidebar={
          <FormSidePanel>
            <FormImageUpload
              label={t('photo', 'Foto de perfil')}
              value={values.photoUrl}
              onChange={(url) => setValue('photoUrl', url)}
              hint={t('photoHint', 'Subir imagen')}
            />
          </FormSidePanel>
        }
      >
        <FormSection title={t('identitySection', 'Perfil & Identidad')} icon="badge">
          <FormField
            label={t('nameLabel', 'Nombre Completo')}
            value={values.name}
            onChange={(v) => setValue('name', v)}
            error={errors.name}
            placeholder={t('namePlaceholder', 'Ej. Julian S. Masterbarber')}
            required
          />

          <FormTextarea
            label={t('bioLabel', 'Biografía / Descripción')}
            value={values.bio}
            onChange={(v) => setValue('bio', v)}
            error={errors.bio}
            placeholder={t('bioPlaceholder', 'Describe la trayectoria y el estilo del profesional...')}
            rows={4}
          />
        </FormSection>

        <FormSection title={t('scheduleSection', 'Horario de Disponibilidad')} icon="schedule">
          <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} />
        </FormSection>

        <FormActions
          onCancel={() => router.push('/dashboard/professionals')}
          onSubmit={handleSubmit}
          submitLabel={t('save', 'Guardar Profesional')}
          cancelLabel={t('cancel', 'Cancelar')}
          loading={saving}
        />
      </FormLayout>
    </>
  );
}
