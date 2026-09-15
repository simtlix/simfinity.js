'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { DataTable, StatusChip, PaginationBar } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';
import type { Column } from '@/components/shared/data';
import { cn } from '@/lib/cn';

const STATUS_OPTIONS = ['', 'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];
type SearchField = 'name' | 'city' | 'owner';

export default function AdminBarbershopsPage() {
  const t = useT('admin');
  const router = useRouter();
  const searchParams = useSearchParams();
  const client = useSimfinityClient();
  const pagination = usePagination(10);

  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<SearchField>('name');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') ?? '');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let query = client
        .find('barbershop')
        .fields('id name slug state averageRating address { city } owner { id name email }')
        .sort('name', 'ASC')
        .page(pagination.page, pagination.pageSize);

      if (statusFilter) {
        query = query.where('state', 'EQ', statusFilter);
      }
      if (search.trim()) {
        if (searchField === 'name') {
          query = query.where('name', 'LIKE', search.trim());
        } else if (searchField === 'owner') {
          query = query.where('owner', [{ path: 'name', operator: 'LIKE', value: search.trim() }]);
        } else if (searchField === 'city') {
          query = query.where('address.city', 'LIKE', search.trim());
        }
      }

      const results = await query.exec();
      const filtered = results as Record<string, unknown>[];

      setData(filtered);

      try {
        let aggQuery = client.aggregate('barbershop').fact('count', 'total');
        if (statusFilter) {
          aggQuery = aggQuery.where('state', 'EQ', statusFilter);
        }
        if (search.trim()) {
          if (searchField === 'name') {
            aggQuery = aggQuery.where('name', 'LIKE', search.trim());
          } else if (searchField === 'owner') {
            aggQuery = aggQuery.where('owner', [{ path: 'name', operator: 'LIKE', value: search.trim() }]);
          } else if (searchField === 'city') {
            aggQuery = aggQuery.where('address.city', 'LIKE', search.trim());
          }
        }
        const agg = await aggQuery.exec();
        setTotal((agg as { total?: number })?.total ?? filtered.length);
      } catch {
        setTotal(filtered.length);
      }
    } catch {
      setData([]);
      setTotal(0);
    }
    setLoading(false);
  }, [client, pagination.page, pagination.pageSize, statusFilter, search, searchField]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const columns: Column[] = [
    {
      key: 'name',
      label: t('barbershopName', 'Barbería'),
      render: (v, row) => {
        const city = String((row.address as Record<string, unknown>)?.city ?? '');
        const ownerName = String((row.owner as Record<string, unknown>)?.name ?? '');
        return (
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center border border-outline-variant/20 overflow-hidden">
              <span className="material-symbols-outlined text-on-surface-variant/40">storefront</span>
            </div>
            <div>
              <p className="text-sm font-bold text-on-surface">{String(v ?? '')}</p>
              <p className="text-[11px] text-on-surface-variant/60">
                {[city, ownerName].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'state',
      label: t('status', 'Estado'),
      render: (v) => <StatusChip status={String(v ?? 'DRAFT')} />,
    },
    {
      key: 'averageRating',
      label: 'Rating',
      render: (v) => {
        const rating = Number(v);
        if (!rating) return <span className="text-on-surface-variant/40">—</span>;
        return (
          <div className="flex items-center gap-1">
            <span
              className="material-symbols-outlined text-primary text-sm"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              star
            </span>
            <span className="text-sm font-bold">{rating.toFixed(1)}</span>
          </div>
        );
      },
    },
    {
      key: 'slug',
      label: 'Slug',
      render: (v) => (
        <span className="text-xs text-on-surface-variant font-mono">{String(v ?? '')}</span>
      ),
    },
  ];

  const actions = (row: Record<string, unknown>) => {
    const state = String(row.state ?? '');
    return (
      <div className="flex items-center gap-2 justify-end">
        {state === 'PENDING_REVIEW' ? (
          <button
            onClick={() => router.push(`/admin/barbershops/${row.id}/view`)}
            className="px-5 py-2 bg-primary-container/10 text-primary-container rounded-lg text-xs font-bold hover:bg-primary-container hover:text-on-primary-container transition-all"
          >
            {t('review', 'Revisar')}
          </button>
        ) : (
          <>
            <button
              onClick={() => router.push(`/admin/barbershops/${row.id}/view`)}
              className="p-2 hover:bg-surface-container-highest rounded-lg transition-colors text-on-surface-variant/60 hover:text-primary"
            >
              <span className="material-symbols-outlined">visibility</span>
            </button>
            <button
              onClick={() => router.push(`/admin/barbershops/${row.id}/edit`)}
              className="p-2 hover:bg-surface-container-highest rounded-lg transition-colors text-on-surface-variant/60 hover:text-primary"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-7xl space-y-8">
      <PageHeader
        title={t('barbershopsDirectory', 'Directorio de Barberías')}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('barbershops', 'Barberías') },
        ]}
      />

      {/* Toolbar */}
      <div className="flex flex-col gap-4 bg-surface-container-low/50 p-6 rounded-2xl border border-outline-variant/10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="flex bg-surface-container-high p-1 rounded-lg">
              {([
                { field: 'name' as SearchField, label: t('byName', 'Nombre') },
                { field: 'city' as SearchField, label: t('byCity', 'Ciudad') },
                { field: 'owner' as SearchField, label: t('byOwner', 'Dueño') },
              ]).map((tab) => (
                <button
                  key={tab.field}
                  onClick={() => { setSearchField(tab.field); pagination.setPage(1); }}
                  className={cn(
                    'px-4 py-2 rounded-md text-xs font-semibold transition-all',
                    searchField === tab.field
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface/60 hover:text-on-surface',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
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
                placeholder={
                  searchField === 'name' ? t('searchByName', 'Buscar por nombre...')
                    : searchField === 'city' ? t('searchByCity', 'Buscar por ciudad...')
                    : t('searchByOwner', 'Buscar por dueño...')
                }
              />
            </div>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-container-high border border-outline-variant/10">
            <span className="text-xs text-on-surface-variant/60 uppercase tracking-tighter">
              {t('filterBy', 'Filtrar por:')}
            </span>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                pagination.setPage(1);
              }}
              className="bg-transparent border-none text-sm font-semibold text-primary focus:ring-0 cursor-pointer pr-8"
            >
              <option value="">{t('allStatuses', 'Todos los estados')}</option>
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
          emptyMessage={t('noBarbershopsFound', 'No se encontraron barberías')}
          actions={actions}
          onRowClick={(row) => router.push(`/admin/barbershops/${row.id}/view`)}
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
