'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  FormToggle,
} from '@/components/shared';
import { BusinessHoursEditor, type BusinessHourSlot } from '@/components/shared/hours';
import { cn } from '@/lib/cn';

type ProfessionalForm = {
  name: string;
  bio: string;
  photoUrl: string;
  isActive: boolean;
};

type ServiceItem = { id: string; name: string };

const DEFAULT_HOURS: BusinessHourSlot[] = Array.from({ length: 7 }, (_, i) => ({
  dayOfWeek: i,
  openTime: '09:00',
  closeTime: '18:00',
  isClosed: i === 0,
}));

export default function EditProfessionalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('professionals');
  const { selectedBarbershop } = useBarbershop();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [businessHours, setBusinessHours] = useState<BusinessHourSlot[]>(DEFAULT_HOURS);
  const [allServices, setAllServices] = useState<ServiceItem[]>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());

  const { values, errors, setValue, setValues, setError, clearErrors } =
    useFormState<ProfessionalForm>({
      name: '',
      bio: '',
      photoUrl: '',
      isActive: true,
    });

  useEffect(() => {
    if (!id || !selectedBarbershop?.id) return;
    let cancelled = false;

    (async () => {
      try {
        const [pro, services] = await Promise.all([
          client.getById(
            'professional',
            id,
            'id name photoUrl bio isActive services { service { id name } } businessHours { dayOfWeek openTime closeTime isClosed breakStartTime breakEndTime }',
          ) as Promise<(ProfessionalForm & Record<string, unknown>) | null>,
          client
            .find('service')
            .fields('id name')
            .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
            .exec() as Promise<ServiceItem[]>,
        ]);
        if (!cancelled) {
          setAllServices(services ?? []);
          if (pro) {
            setValues({
              name: pro.name ?? '',
              bio: pro.bio ?? '',
              photoUrl: pro.photoUrl ?? '',
              isActive: pro.isActive ?? true,
            });
            if (Array.isArray(pro.businessHours)) {
              setBusinessHours(pro.businessHours as BusinessHourSlot[]);
            }
            const assigned = (pro.services as { service: ServiceItem }[] | undefined) ?? [];
            setSelectedServiceIds(new Set(assigned.map((ps) => ps.service.id)));
          }
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, id, setValues, selectedBarbershop?.id]);

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
      await client.update('professional', id, {
        name: values.name.trim(),
        bio: values.bio.trim(),
        photoUrl: values.photoUrl || undefined,
        isActive: values.isActive,
        services: Array.from(selectedServiceIds).map((sId) => ({
          service: { id: sId },
        })),
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="material-symbols-outlined text-primary text-3xl animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={t('editTitle', 'Editar Profesional')}
        subtitle={t('editSubtitle', 'Actualiza la información del profesional.')}
        breadcrumbs={[
          { label: t('breadcrumbList', 'Profesionales'), href: '/dashboard/professionals' },
          { label: t('breadcrumbEdit', 'Editar') },
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
            <div className="pt-4">
              <FormToggle
                label={t('activeToggle', 'Activo')}
                checked={values.isActive}
                onChange={(v) => setValue('isActive', v as unknown as boolean)}
              />
            </div>
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

        <FormSection title={t('servicesSection', 'Servicios que Realiza')} icon="content_cut">
          {allServices.length === 0 ? (
            <p className="text-sm text-on-surface/40 italic">
              {t('noServicesAvailable', 'No hay servicios registrados en esta barbería.')}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allServices.map((svc) => {
                const checked = selectedServiceIds.has(svc.id);
                return (
                  <label
                    key={svc.id}
                    className={cn(
                      'flex items-center gap-3 rounded-xl px-4 py-3 cursor-pointer transition-all',
                      checked
                        ? 'bg-primary/10 border border-primary/30'
                        : 'bg-surface-container-low/50 border border-transparent hover:border-outline-variant/20',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedServiceIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(svc.id)) next.delete(svc.id);
                          else next.add(svc.id);
                          return next;
                        });
                      }}
                      className="accent-primary w-4 h-4"
                    />
                    <span className="text-sm text-on-surface">{svc.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </FormSection>

        <FormSection title={t('scheduleSection', 'Horario de Disponibilidad')} icon="schedule">
          <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} />
        </FormSection>

        <FormActions
          onCancel={() => router.push('/dashboard/professionals')}
          onSubmit={handleSubmit}
          submitLabel={t('update', 'Actualizar Profesional')}
          cancelLabel={t('cancel', 'Cancelar')}
          loading={saving}
        />
      </FormLayout>
    </>
  );
}
