'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { useBarbershop } from '@/lib/barbershopContext';
import {
  PageHeader,
  DataTable,
  PaginationBar,
  StatusChip,
} from '@/components/shared';
import { cn } from '@/lib/cn';
import type { Column } from '@/components/shared';

type Bundle = {
  id: string;
  name: string;
  description: string;
  price: number;
  totalDurationMinutes: number;
  isActive: boolean;
};

function formatCurrency(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export default function BundlesPage() {
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('bundles');
  const { page, pageSize, setPage, setPageSize } = usePagination(9);
  const { selectedBarbershop } = useBarbershop();

  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const fetchBundles = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      let query = client
        .find('bundle')
        .fields('id name description price totalDurationMinutes isActive')
        .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
        .page(page, pageSize);

      if (search.trim()) {
        query = query.where('name', 'CONTAINS', search.trim());
      }
      if (filter === 'ACTIVE') {
        query = query.where('isActive', 'EQ', true);
      } else if (filter === 'INACTIVE') {
        query = query.where('isActive', 'EQ', false);
      }

      const result = await query.exec();
      const items = Array.isArray(result) ? result : [];
      setBundles(items as Bundle[]);
      setTotal(items.length < pageSize && page === 1 ? items.length : items.length + (page - 1) * pageSize + 1);
    } catch {
      setBundles([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [client, page, pageSize, search, filter, selectedBarbershop?.id]);

  useEffect(() => {
    fetchBundles();
  }, [fetchBundles]);

  const columns: Column[] = [
    {
      key: 'name',
      label: t('name', 'Nombre'),
      sortable: true,
      render: (val) => (
        <span className="font-headline text-lg text-on-surface">{val as string}</span>
      ),
    },
    {
      key: 'description',
      label: t('description', 'Descripción'),
      render: (val) => (
        <span className="text-on-surface/60 text-sm italic line-clamp-2 max-w-xs">
          {(val as string) || '—'}
        </span>
      ),
    },
    {
      key: 'price',
      label: t('price', 'Precio'),
      sortable: true,
      render: (val) => (
        <span className="font-headline text-xl text-primary">
          {formatCurrency((val as number) ?? 0)}
        </span>
      ),
    },
    {
      key: 'totalDurationMinutes',
      label: t('duration', 'Duración'),
      render: (val) => (
        <span className="text-on-surface text-sm">
          {val ? formatDuration(val as number) : '—'}
        </span>
      ),
    },
    {
      key: 'isActive',
      label: t('status', 'Estado'),
      render: (val) => (
        <StatusChip status={val ? 'ACTIVE' : 'INACTIVE'} />
      ),
    },
  ];

  const filterButtons: { key: typeof filter; label: string }[] = [
    { key: 'ALL', label: t('all', 'Todos') },
    { key: 'ACTIVE', label: t('active', 'Activos') },
    { key: 'INACTIVE', label: t('inactive', 'Inactivos') },
  ];

  return (
    <>
      <PageHeader
        title={t('title', 'Gestión de Bundles')}
        subtitle={t('subtitle', 'Crea y administra paquetes exclusivos de servicios.')}
        actions={
          <button
            onClick={() => router.push('/dashboard/bundles/create')}
            className="bg-primary/10 border border-primary/20 text-primary px-6 py-2.5 rounded-lg text-xs font-bold tracking-widest hover:bg-primary hover:text-on-primary transition-all duration-300"
          >
            + {t('new', 'NUEVO PAQUETE')}
          </button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4 mb-8 bg-surface-container-low/50 p-4 rounded-xl">
        <div className="flex items-center gap-2">
          {filterButtons.map((fb) => (
            <button
              key={fb.key}
              onClick={() => { setFilter(fb.key); setPage(1); }}
              className={cn(
                'px-5 py-2 rounded-full text-xs font-bold tracking-wider transition-all',
                filter === fb.key
                  ? 'bg-primary text-on-primary-container'
                  : 'text-on-surface/60 hover:bg-surface-container-high',
              )}
            >
              {fb.label.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="relative min-w-[280px]">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/40">
            search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('searchPlaceholder', 'Buscar paquetes...')}
            className="w-full bg-surface-container-high border-none rounded-lg py-2.5 pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 text-on-surface placeholder-on-surface/30"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={bundles as unknown as Record<string, unknown>[]}
        loading={loading}
        emptyMessage={t('empty', 'No hay bundles registrados')}
        onRowClick={(row) => router.push(`/dashboard/bundles/${row.id}/edit`)}
        actions={(row) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/dashboard/bundles/${row.id}/edit`);
            }}
            className="text-primary text-xs font-bold tracking-widest flex items-center gap-1 hover:gap-2 transition-all"
          >
            {t('edit', 'EDITAR')}
            <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </button>
        )}
      />

      <div className="mt-6">
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </>
  );
}
