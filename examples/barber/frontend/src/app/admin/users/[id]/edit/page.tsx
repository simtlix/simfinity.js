'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { PageHeader } from '@/components/shared/page';
import { FormField, FormSelect, FormSection, FormLayout, FormActions } from '@/components/shared/form';

type UserForm = {
  name: string;
  email: string;
  phone: string;
  role: string;
};

const INITIAL: UserForm = {
  name: '',
  email: '',
  phone: '',
  role: '',
};

type UserData = {
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
};

const ROLE_OPTIONS = [
  { value: 'CLIENT', label: 'Cliente' },
  { value: 'OWNER', label: 'Dueño' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'PLATFORM_ADMIN', label: 'Admin' },
];

export default function AdminUserEditPage() {
  const t = useT('admin');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();
  const id = params.id as string;

  const form = useFormState(INITIAL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.getById('user', id, 'id name email phone role');

      if (result) {
        const data = result as UserData;
        form.setValues({
          name: String(data.name ?? ''),
          email: String(data.email ?? ''),
          phone: String(data.phone ?? ''),
          role: String(data.role ?? ''),
        });
      }
    } catch {
      // empty
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id]);

  useEffect(() => {
    fetchUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    if (!form.values.name.trim()) {
      form.setError('name', t('required', 'Campo obligatorio'));
      return;
    }
    if (!form.values.email.trim()) {
      form.setError('email', t('required', 'Campo obligatorio'));
      return;
    }

    setSaving(true);
    try {
      await client.update('user', id, {
        name: form.values.name,
        email: form.values.email,
        phone: form.values.phone || null,
        role: form.values.role || null,
      });
      router.push(`/admin/users/${id}/view`);
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
    <div className="max-w-4xl space-y-8">
      <PageHeader
        title={t('editUser', 'Editar Usuario')}
        subtitle={form.values.name}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('users', 'Usuarios'), href: '/admin/users' },
          { label: form.values.name || '…', href: `/admin/users/${id}/view` },
          { label: t('edit', 'Editar') },
        ]}
      />

      <FormLayout>
        <div className="space-y-8">
          <FormSection title={t('personalInfo', 'Información Personal')} icon="person">
            <FormField
              label={t('name', 'Nombre')}
              value={form.values.name}
              onChange={(v) => form.setValue('name', v)}
              error={form.errors.name}
              required
            />
            <FormField
              label="Email"
              value={form.values.email}
              onChange={(v) => form.setValue('email', v)}
              error={form.errors.email}
              type="email"
              required
            />
            <FormField
              label={t('phone', 'Teléfono')}
              value={form.values.phone}
              onChange={(v) => form.setValue('phone', v)}
            />
          </FormSection>

          <FormSection title={t('accessControl', 'Control de Acceso')} icon="admin_panel_settings">
            <FormSelect
              label={t('role', 'Rol')}
              value={form.values.role}
              onChange={(v) => form.setValue('role', v)}
              options={ROLE_OPTIONS}
              placeholder={t('selectRole', 'Seleccionar rol')}
            />
          </FormSection>

          <FormActions
            onCancel={() => router.push(`/admin/users/${id}/view`)}
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
