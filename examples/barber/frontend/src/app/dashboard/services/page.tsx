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

type Service = {
  id: string;
  name: string;
  description: string;
  price: number;
  durationMinutes: number;
  isActive: boolean;
  category?: { id: string; name: string };
  imageUrl: string;
};

export default function OwnerServicesPage() {
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('dashboard');
  const { page, pageSize, setPage, setPageSize } = usePagination(9);
  const { selectedBarbershop } = useBarbershop();

  const [services, setServices] = useState<Service[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const fetchServices = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      let query = client
        .find('service')
        .fields('id name description price durationMinutes isActive category { id name } imageUrl')
        .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
        .page(page, pageSize);

      if (search.trim()) {
        query = query.where('name', 'LIKE', search.trim());
      }
      if (filter === 'ACTIVE') {
        query = query.where('isActive', 'EQ', true);
      } else if (filter === 'INACTIVE') {
        query = query.where('isActive', 'EQ', false);
      }

      const result = await query.exec();
      const items = Array.isArray(result) ? result : [];
      setServices(items as Service[]);
      setTotal(items.length < pageSize && page === 1 ? items.length : items.length + (page - 1) * pageSize + 1);
    } catch {
      setServices([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [client, page, pageSize, search, filter, selectedBarbershop?.id]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const columns: Column[] = [
    {
      key: 'name',
      label: t('services.name', 'Nombre'),
      sortable: true,
      render: (val, row) => (
        <div>
          <span className="font-headline text-lg text-on-surface">{val as string}</span>
          {(row.category as { name: string } | undefined)?.name && (
            <p className="text-xs text-on-surface/50 mt-0.5">
              {(row.category as { name: string }).name}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'price',
      label: t('services.price', 'Precio'),
      sortable: true,
      render: (val) => (
        <span className="font-mono text-sm text-on-surface">
          ${Number(val).toFixed(2)}
        </span>
      ),
    },
    {
      key: 'durationMinutes',
      label: t('services.duration', 'Duración'),
      render: (val) => (
        <span className="text-sm text-on-surface/70">
          {val as number} min
        </span>
      ),
    },
    {
      key: 'isActive',
      label: t('services.status', 'Estado'),
      render: (val) => (
        <StatusChip status={val ? 'ACTIVE' : 'INACTIVE'} />
      ),
    },
  ];

  const filterButtons: { key: typeof filter; label: string }[] = [
    { key: 'ALL', label: t('services.all', 'Todos') },
    { key: 'ACTIVE', label: t('services.active', 'Activos') },
    { key: 'INACTIVE', label: t('services.inactive', 'Inactivos') },
  ];

  return (
    <>
      <PageHeader
        title={t('services.title', 'Servicios')}
        subtitle={t('services.subtitle', 'Administra el catálogo de servicios, precios y duraciones.')}
        actions={
          <button
            onClick={() => router.push('/dashboard/services/create')}
            className="bg-primary/10 border border-primary/20 text-primary px-6 py-2.5 rounded-lg text-xs font-bold tracking-widest hover:bg-primary hover:text-on-primary transition-all duration-300"
          >
            + {t('services.new', 'NUEVO SERVICIO')}
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
            placeholder={t('services.searchPlaceholder', 'Buscar servicio...')}
            className="w-full bg-surface-container-high border-none rounded-lg py-2.5 pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 text-on-surface placeholder-on-surface/30"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={services as unknown as Record<string, unknown>[]}
        loading={loading}
        emptyMessage={t('services.empty', 'No hay servicios registrados')}
        onRowClick={(row) => router.push(`/dashboard/services/${row.id}/edit`)}
        actions={(row) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/dashboard/services/${row.id}/edit`);
            }}
            className="text-primary text-xs font-bold tracking-widest flex items-center gap-1 hover:gap-2 transition-all"
          >
            {t('services.edit', 'EDITAR')}
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
