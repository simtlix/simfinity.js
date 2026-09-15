'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Image from 'next/image';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { StatusChip } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';
import { SuspendModal } from '@/components/shared/modals';

type User = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  status: string;
  avatarUrl: string;
  emailVerified: boolean;
};

export default function AdminUserViewPage() {
  const t = useT('admin');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();
  const id = params.id as string;

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.getById('user', id, 'id name email phone role status avatarUrl emailVerified');
      setUser(result as unknown as User);
    } catch {
      setUser(null);
    }
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchUser();
  }, [fetchUser]);

  const handleSuspend = async (reason: string) => {
    setSuspendOpen(false);
    setActionLoading(true);
    try {
      await client.update('user', id, { status: 'SUSPENDED' });
      await fetchUser();
    } catch (err) {
      console.error('Suspend failed:', err);
    }
    setActionLoading(false);
  };

  const handleReactivate = async () => {
    setActionLoading(true);
    try {
      await client.update('user', id, { status: 'ACTIVE' });
      await fetchUser();
    } catch (err) {
      console.error('Reactivate failed:', err);
    }
    setActionLoading(false);
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

  if (!user) {
    return (
      <div className="text-center py-20">
        <p className="text-on-surface-variant">{t('userNotFound', 'Usuario no encontrado')}</p>
      </div>
    );
  }

  const isSuspended = user.status === 'SUSPENDED';

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        title={user.name}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('users', 'Usuarios'), href: '/admin/users' },
          { label: user.name },
        ]}
        actions={
          <button
            onClick={() => router.push(`/admin/users/${id}/edit`)}
            className="px-5 py-2.5 bg-surface-container-high text-on-surface-variant rounded-xl text-sm font-semibold hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-sm mr-1 align-middle">edit</span>
            {t('edit', 'Editar')}
          </button>
        }
      />

      {/* Profile Header */}
      <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant/10 flex flex-col sm:flex-row items-start sm:items-center gap-6">
        <div className="w-20 h-20 rounded-full bg-surface-container-highest border border-outline-variant/20 overflow-hidden flex items-center justify-center shrink-0">
          {user.avatarUrl ? (
            <Image src={user.avatarUrl} alt={user.name} className="w-full h-full object-cover" width={80} height={80} unoptimized />
          ) : (
            <span className="material-symbols-outlined text-on-surface-variant/40 text-3xl">
              person
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h2 className="font-headline text-2xl italic text-on-surface">{user.name}</h2>
          <p className="text-on-surface-variant text-sm mt-1">{user.email}</p>
          <div className="flex items-center gap-3 mt-3">
            <StatusChip status={user.status ?? 'ACTIVE'} />
            <span className="inline-block py-1 px-3 rounded-full text-[10px] font-bold uppercase tracking-tighter bg-primary/10 text-primary border border-primary/20">
              {user.role}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {!isSuspended ? (
            <button
              disabled={actionLoading}
              onClick={() => setSuspendOpen(true)}
              className="bg-error/10 text-error px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-error/20 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">block</span>
              {t('suspend', 'Suspender')}
            </button>
          ) : (
            <button
              disabled={actionLoading}
              onClick={handleReactivate}
              className="bg-emerald-500/10 text-emerald-400 px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-emerald-500/20 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">check_circle</span>
              {t('reactivate', 'Reactivar')}
            </button>
          )}
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="bg-surface-container-low rounded-2xl p-8 border-l-2 border-primary space-y-6">
          <h3 className="text-xs uppercase tracking-widest text-primary font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">person</span>
            {t('personalInfo', 'Información Personal')}
          </h3>
          <div className="space-y-4">
            <DetailRow label={t('name', 'Nombre')} value={user.name} />
            <DetailRow label="Email" value={user.email} />
            <DetailRow label={t('phone', 'Teléfono')} value={user.phone || '—'} />
            <DetailRow
              label={t('emailVerified', 'Email Verificado')}
              value={user.emailVerified ? t('yes', 'Sí') : t('no', 'No')}
            />
          </div>
        </section>

        <section className="bg-surface-container-low rounded-2xl p-8 border-l-2 border-primary space-y-6">
          <h3 className="text-xs uppercase tracking-widest text-primary font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">admin_panel_settings</span>
            {t('accessControl', 'Control de Acceso')}
          </h3>
          <div className="space-y-4">
            <DetailRow label={t('role', 'Rol')} value={user.role} />
            <DetailRow label={t('status', 'Estado')} value={user.status ?? 'ACTIVE'} />
          </div>
        </section>
      </div>

      <SuspendModal
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        onConfirm={handleSuspend}
        title={t('suspendUser', 'Suspender Usuario')}
        userName={user.name}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-on-surface-variant/60 mb-1">
        {label}
      </p>
      <p className="text-sm text-on-surface">{value}</p>
    </div>
  );
}
