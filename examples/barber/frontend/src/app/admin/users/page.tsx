'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback } from 'react';
import { PLACEHOLDER_MISSING_IMAGE } from '@/lib/placeholders';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { DataTable, StatusChip, PaginationBar } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';
import type { Column } from '@/components/shared/data';
import { cn } from '@/lib/cn';

const ROLE_OPTIONS = ['', 'CLIENT', 'OWNER', 'STAFF', 'PLATFORM_ADMIN'];
const STATUS_OPTIONS = ['', 'ACTIVE', 'SUSPENDED'];

function UserAvatarCell({ avatarUrl, name }: { avatarUrl: unknown; name: unknown }) {
  const [useFallback, setUseFallback] = useState(false);
  const url = avatarUrl ? String(avatarUrl) : '';
  const label = String(name ?? '');

  return (
    <div className="relative w-12 h-12 rounded-full overflow-hidden bg-surface-container-highest border border-outline-variant/20 flex items-center justify-center shrink-0">
      {url && !useFallback ? (
        <Image
          src={url}
          alt={label}
          fill
          unoptimized
          className="object-cover"
          onError={() => setUseFallback(true)}
        />
      ) : url && useFallback ? (
        <Image
          src={PLACEHOLDER_MISSING_IMAGE}
          alt=""
          width={32}
          height={32}
          className="object-contain opacity-70"
        />
      ) : (
        <span className="material-symbols-outlined text-on-surface-variant/40">person</span>
      )}
    </div>
  );
}

export default function AdminUsersPage() {
  const t = useT('admin');
  const router = useRouter();
  const client = useSimfinityClient();
  const pagination = usePagination(10);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let query = client
        .find('user')
        .fields('id name email phone role status avatarUrl')
        .sort('name', 'ASC')
        .page(pagination.page, pagination.pageSize);

      if (roleFilter) query = query.where('role', 'EQ', roleFilter);
      if (statusFilter) query = query.where('status', 'EQ', statusFilter);
      const q = search.trim();
      if (q) {
        query = q.includes('@')
          ? query.where('email', 'LIKE', q)
          : query.where('name', 'LIKE', q);
      }

      const results = await query.exec();
      setData(results as Record<string, unknown>[]);

      try {
        let aggQuery = client.aggregate('user').fact('count', 'total');
        if (roleFilter) aggQuery = aggQuery.where('role', 'EQ', roleFilter);
        if (statusFilter) aggQuery = aggQuery.where('status', 'EQ', statusFilter);
        if (q) {
          aggQuery = q.includes('@')
            ? aggQuery.where('email', 'LIKE', q)
            : aggQuery.where('name', 'LIKE', q);
        }
        const agg = await aggQuery.exec();
        setTotal((agg as { total?: number })?.total ?? (results as unknown[]).length);
      } catch {
        setTotal((results as unknown[]).length);
      }
    } catch {
      setData([]);
      setTotal(0);
    }
    setLoading(false);
  }, [client, pagination.page, pagination.pageSize, roleFilter, statusFilter, search]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const columns: Column[] = [
    {
      key: 'name',
      label: t('user', 'Usuario'),
      render: (v, row) => (
        <div className="flex items-center gap-4">
          <UserAvatarCell avatarUrl={row.avatarUrl} name={v} />
          <div>
            <p className="font-medium text-on-surface">{String(v ?? '')}</p>
            <p className="text-xs text-on-surface-variant/60">{String(row.email ?? '')}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'phone',
      label: t('phone', 'Teléfono'),
      render: (v) => (
        <span className="text-sm text-on-surface-variant">{String(v ?? '—')}</span>
      ),
    },
    {
      key: 'role',
      label: t('role', 'Rol'),
      render: (v) => {
        const role = String(v ?? '');
        const colors: Record<string, string> = {
          OWNER: 'bg-primary/10 text-primary border-primary/20',
          PLATFORM_ADMIN: 'bg-tertiary/10 text-tertiary border-tertiary/20',
        };
        return (
          <span
            className={cn(
              'inline-block py-1 px-3 rounded-full text-[10px] font-bold uppercase tracking-tighter border',
              colors[role] ?? 'bg-surface-container-highest text-on-surface border-outline-variant/30',
            )}
          >
            {role}
          </span>
        );
      },
    },
    {
      key: 'status',
      label: t('status', 'Estado'),
      render: (v) => <StatusChip status={String(v ?? 'ACTIVE')} />,
    },
  ];

  const actions = (row: Record<string, unknown>) => (
    <div className="flex items-center gap-1 justify-end">
      <button
        onClick={(e) => {
          e.stopPropagation();
          router.push(`/admin/users/${row.id}/view`);
        }}
        className="p-2 hover:bg-surface-container-highest rounded-lg transition-colors text-on-surface-variant/60 hover:text-primary"
        title={t('view', 'Ver')}
      >
        <span className="material-symbols-outlined">visibility</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          router.push(`/admin/users/${row.id}/edit`);
        }}
        className="p-2 hover:bg-surface-container-highest rounded-lg transition-colors text-on-surface-variant/60 hover:text-primary"
        title={t('edit', 'Editar')}
      >
        <span className="material-symbols-outlined">edit</span>
      </button>
    </div>
  );

  return (
    <div className="max-w-7xl space-y-8">
      <PageHeader
        title={t('userManagement', 'Gestión de Usuarios')}
        subtitle={t('userManagementSub', 'Administra el acceso y roles de todos los usuarios.')}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('users', 'Usuarios') },
        ]}
        actions={
          <button
            onClick={() => router.push('/admin/users/create')}
            className="flex items-center gap-2 px-6 py-3 bg-primary-container text-on-primary-container rounded-xl font-bold text-sm hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <span className="material-symbols-outlined">add</span>
            {t('newUser', 'Nuevo Usuario')}
          </button>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-6 bg-surface-container-low/50 p-6 rounded-2xl border border-outline-variant/10">
        <div className="relative flex-1 max-w-md">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
            search
          </span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              pagination.setPage(1);
            }}
            className="w-full bg-surface-container-high border-none rounded-xl py-3 pl-12 pr-4 text-sm focus:ring-2 focus:ring-primary-container/20 text-on-surface placeholder:text-on-surface-variant/30 transition-all"
            placeholder={t('searchUsers', 'Buscar por nombre o email...')}
          />
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/60">
              {t('role', 'Rol')}:
            </span>
            <select
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                pagination.setPage(1);
              }}
              className="bg-surface-container-high border-none text-sm text-on-surface py-2 px-4 rounded-lg focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="">{t('all', 'Todos')}</option>
              {ROLE_OPTIONS.filter(Boolean).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-on-surface-variant/60">
              {t('status', 'Estado')}:
            </span>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                pagination.setPage(1);
              }}
              className="bg-surface-container-high border-none text-sm text-on-surface py-2 px-4 rounded-lg focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="">{t('all', 'Todos')}</option>
              {STATUS_OPTIONS.filter(Boolean).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-surface-container-low rounded-3xl overflow-hidden border border-outline-variant/10 shadow-2xl">
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          emptyMessage={t('noUsersFound', 'No se encontraron usuarios')}
          actions={actions}
          onRowClick={(row) => router.push(`/admin/users/${row.id}/view`)}
        />
        <PaginationBar
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={total}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
        />
      </div>
    </div>
  );
}
