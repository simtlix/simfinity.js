'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useFormState } from '@/hooks/useFormState';
import { PageHeader } from '@/components/shared/page';
import { FormField, FormSelect, FormSection, FormLayout, FormActions } from '@/components/shared/form';

type NewUserForm = {
  name: string;
  email: string;
  phone: string;
  role: string;
  password: string;
};

const INITIAL: NewUserForm = {
  name: '',
  email: '',
  phone: '',
  role: 'CLIENT',
  password: '',
};

const ROLE_OPTIONS = [
  { value: 'CLIENT', label: 'Cliente' },
  { value: 'OWNER', label: 'Dueño' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'PLATFORM_ADMIN', label: 'Admin' },
];

export default function AdminUserCreatePage() {
  const t = useT('admin');
  const router = useRouter();
  const client = useSimfinityClient();
  const form = useFormState(INITIAL);
  const [saving, setSaving] = useState(false);

  const validate = (): boolean => {
    let valid = true;
    form.clearErrors();

    if (!form.values.name.trim()) {
      form.setError('name', t('required', 'Campo obligatorio'));
      valid = false;
    }
    if (!form.values.email.trim()) {
      form.setError('email', t('required', 'Campo obligatorio'));
      valid = false;
    }
    if (!form.values.password.trim() || form.values.password.length < 6) {
      form.setError('password', t('minPassword', 'Mínimo 6 caracteres'));
      valid = false;
    }
    return valid;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      const role = form.values.role;
      const mutation = role === 'OWNER' ? 'registerOwner' : 'register';
      const registerInput = {
        email: form.values.email,
        password: form.values.password,
        name: form.values.name,
        ...(form.values.phone.trim() ? { phone: form.values.phone.trim() } : {}),
      };

      const result = (await client.customMutation(
        mutation,
        { input: registerInput },
        'user { id }',
      )) as { user?: { id: string } } | null;

      const userId = result?.user?.id;

      if (userId && role !== 'CLIENT' && role !== 'OWNER') {
        await client.update('user', userId, { role }, 'id role');
      }

      router.push('/admin/users');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      form.setError('email', msg);
    }
    setSaving(false);
  };

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        title={t('createUser', 'Crear Usuario')}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('users', 'Usuarios'), href: '/admin/users' },
          { label: t('new', 'Nuevo') },
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
              placeholder={t('namePlaceholder', 'Nombre completo')}
            />
            <FormField
              label="Email"
              value={form.values.email}
              onChange={(v) => form.setValue('email', v)}
              error={form.errors.email}
              type="email"
              required
              placeholder="user@example.com"
            />
            <FormField
              label={t('phone', 'Teléfono')}
              value={form.values.phone}
              onChange={(v) => form.setValue('phone', v)}
              placeholder="+54 11 1234 5678"
            />
          </FormSection>

          <FormSection title={t('accessControl', 'Control de Acceso')} icon="admin_panel_settings">
            <FormField
              label={t('password', 'Contraseña')}
              value={form.values.password}
              onChange={(v) => form.setValue('password', v)}
              error={form.errors.password}
              type="password"
              required
              placeholder={t('passwordPlaceholder', 'Mínimo 6 caracteres')}
            />
            <FormSelect
              label={t('role', 'Rol')}
              value={form.values.role}
              onChange={(v) => form.setValue('role', v)}
              options={ROLE_OPTIONS}
            />
          </FormSection>

          <FormActions
            onCancel={() => router.push('/admin/users')}
            onSubmit={handleSave}
            submitLabel={t('createUser', 'Crear Usuario')}
            cancelLabel={t('cancel', 'Cancelar')}
            loading={saving}
          />
        </div>
      </FormLayout>
    </div>
  );
}
