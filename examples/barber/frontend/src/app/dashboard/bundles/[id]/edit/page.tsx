'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import {
  PageHeader,
  FormLayout,
  FormField,
  FormTextarea,
  FormCurrencyInput,
  FormDurationSelect,
  FormToggle,
  FormSection,
  FormActions,
} from '@/components/shared';

type BundleForm = {
  name: string;
  description: string;
  price: string;
  totalDurationMinutes: number;
  isActive: boolean;
};

export default function EditBundlePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('bundles');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const { values, errors, setValue, setValues, setError, clearErrors } =
    useFormState<BundleForm>({
      name: '',
      description: '',
      price: '',
      totalDurationMinutes: 60,
      isActive: true,
    });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      try {
        const bundle = (await client.getById(
          'bundle',
          id,
          'id name description price totalDurationMinutes isActive',
        )) as {
          name?: string;
          description?: string;
          price?: unknown;
          totalDurationMinutes?: number;
          isActive?: boolean;
        } | null;
        if (!cancelled && bundle) {
          setValues({
            name: bundle.name ?? '',
            description: bundle.description ?? '',
            price: String(bundle.price ?? ''),
            totalDurationMinutes: bundle.totalDurationMinutes ?? 60,
            isActive: bundle.isActive ?? true,
          });
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, id, setValues]);

  function validate(): boolean {
    clearErrors();
    let valid = true;
    if (!values.name.trim()) {
      setError('name', t('nameRequired', 'El nombre es obligatorio'));
      valid = false;
    }
    const price = parseFloat(values.price);
    if (isNaN(price) || price <= 0) {
      setError('price', t('priceRequired', 'Ingresa un precio válido'));
      valid = false;
    }
    return valid;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      await client.update('bundle', id, {
        name: values.name.trim(),
        description: values.description.trim(),
        price: parseFloat(values.price),
        totalDurationMinutes: values.totalDurationMinutes,
        isActive: values.isActive,
      });
      router.push('/dashboard/bundles');
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
        title={t('editTitle', 'Editar Bundle')}
        subtitle={t('editSubtitle', 'Actualiza la información del paquete.')}
        breadcrumbs={[
          { label: t('breadcrumbList', 'Bundles'), href: '/dashboard/bundles' },
          { label: t('breadcrumbEdit', 'Editar') },
        ]}
      />

      <FormLayout>
        <FormSection title={t('detailsSection', 'Detalles del Paquete')} icon="inventory_2">
          <FormField
            label={t('nameLabel', 'Nombre del Bundle')}
            value={values.name}
            onChange={(v) => setValue('name', v)}
            error={errors.name}
            placeholder={t('namePlaceholder', "Ej. The Gentleman's Ritual")}
            required
          />

          <FormTextarea
            label={t('descriptionLabel', 'Descripción')}
            value={values.description}
            onChange={(v) => setValue('description', v)}
            error={errors.description}
            placeholder={t('descriptionPlaceholder', 'Describe los beneficios de este paquete...')}
            rows={3}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FormCurrencyInput
              label={t('priceLabel', 'Precio')}
              value={values.price}
              onChange={(v) => setValue('price', v)}
              error={errors.price}
              placeholder="0.00"
              required
            />

            <FormDurationSelect
              label={t('durationLabel', 'Duración Total')}
              value={values.totalDurationMinutes}
              onChange={(v) => setValue('totalDurationMinutes', v)}
            />
          </div>

          <FormToggle
            label={t('activeToggle', 'Activo')}
            checked={values.isActive}
            onChange={(v) => setValue('isActive', v as unknown as boolean)}
          />
        </FormSection>

        <FormActions
          onCancel={() => router.push('/dashboard/bundles')}
          onSubmit={handleSubmit}
          submitLabel={t('update', 'Actualizar Bundle')}
          cancelLabel={t('cancel', 'Cancelar')}
          loading={saving}
        />
      </FormLayout>
    </>
  );
}
