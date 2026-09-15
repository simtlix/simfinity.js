'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { useBarbershop } from '@/lib/barbershopContext';
import {
  PageHeader,
  DataTable,
  PaginationBar,
  StatusChip,
  StarRating,
} from '@/components/shared';
import type { Column } from '@/components/shared';
import { cn } from '@/lib/cn';

type Professional = {
  id: string;
  name: string;
  photoUrl: string;
  bio: string;
  isActive: boolean;
  user?: { id: string; name: string };
};

export default function ProfessionalsPage() {
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT('professionals');
  const { selectedBarbershop } = useBarbershop();
  const { page, pageSize, setPage, setPageSize } = usePagination(9);

  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const fetchProfessionals = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      let query = client
        .find('professional')
        .fields('id name photoUrl bio isActive user { id name }')
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
      setProfessionals(items as Professional[]);
      setTotal(items.length < pageSize && page === 1 ? items.length : items.length + (page - 1) * pageSize + 1);
    } catch {
      setProfessionals([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [client, page, pageSize, search, filter, selectedBarbershop?.id]);

  useEffect(() => {
    fetchProfessionals();
  }, [fetchProfessionals]);

  const columns: Column[] = [
    {
      key: 'photoUrl',
      label: '',
      render: (val, row) => (
        <div className="w-12 h-12 rounded-full overflow-hidden bg-surface-container-high border border-outline-variant/20 flex-shrink-0">
          {val ? (
            <Image src={val as string} alt={row.name as string} className="w-full h-full object-cover" width={48} height={48} unoptimized />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-primary text-sm font-bold">
              {((row.name as string) ?? '?').slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'name',
      label: t('name', 'Nombre'),
      sortable: true,
      render: (val) => (
        <span className="font-headline text-lg text-on-surface">{val as string}</span>
      ),
    },
    {
      key: 'bio',
      label: t('bio', 'Especialidad'),
      render: (val) => (
        <span className="text-on-surface/60 text-sm italic line-clamp-2 max-w-xs">
          {(val as string) || '—'}
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
        title={t('title', 'Gestión de Profesionales')}
        subtitle={t('subtitle', 'Administra el equipo de talentos, sus especialidades y disponibilidad operativa.')}
        actions={
          <button
            onClick={() => router.push('/dashboard/professionals/create')}
            className="bg-primary/10 border border-primary/20 text-primary px-6 py-2.5 rounded-lg text-xs font-bold tracking-widest hover:bg-primary hover:text-on-primary transition-all duration-300"
          >
            + {t('new', 'NUEVO PROFESIONAL')}
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
            placeholder={t('searchPlaceholder', 'Buscar profesional...')}
            className="w-full bg-surface-container-high border-none rounded-lg py-2.5 pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 text-on-surface placeholder-on-surface/30"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={professionals as unknown as Record<string, unknown>[]}
        loading={loading}
        emptyMessage={t('empty', 'No hay profesionales registrados')}
        onRowClick={(row) => router.push(`/dashboard/professionals/${row.id}/edit`)}
        actions={(row) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/dashboard/professionals/${row.id}/edit`);
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
