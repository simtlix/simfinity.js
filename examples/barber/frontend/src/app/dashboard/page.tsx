'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useBarbershop } from '@/lib/barbershopContext';
import { useT } from '@/hooks/useT';
import { KpiCard, DataTable, StatusChip } from '@/components/shared/data';
import { RevenueChart, BookingsByServiceChart } from '@/components/shared/charts';
import { EmptyState } from '@/components/shared/page';
import { format, subDays } from 'date-fns';
import type { Column } from '@/components/shared/data';
import { cn } from '@/lib/cn';

type Period = 'HOY' | 'SEMANA' | 'MES';

interface Booking {
  id: string;
  scheduledDate?: string;
  startTime?: string;
  endTime?: string;
  totalPrice?: number;
  state?: string;
  client?: { id: string; name?: string };
  professional?: { id: string; name?: string };
  lines?: { service?: { id: string; name?: string }; price?: number; durationMinutes?: number }[];
  barbershop?: { id: string };
}

interface DashboardData {
  totalRevenue: number;
  totalBookings: number;
  cancelRate: number;
  avgRating: number;
  hasBarbershop: boolean;
  recentBookings: Booking[];
  professionals: {
    id: string;
    name: string;
    initials: string;
    role: string;
    bookings: number;
    revenue: number;
    rating: number;
  }[];
  revenueByDay: { date: string; revenue: number }[];
  bookingsByService: { service: string; count: number }[];
}

function formatCurrency(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0 })}`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function periodDays(p: Period): number {
  switch (p) {
    case 'HOY':
      return 0;
    case 'SEMANA':
      return 7;
    case 'MES':
      return 30;
  }
}

function getStatusLabel(rating: number): { label: string; color: string; border: string } {
  if (rating >= 4.9)
    return { label: 'Óptimo', color: 'text-emerald-400 bg-emerald-500/10', border: 'border-emerald-500/20' };
  if (rating >= 4.5)
    return { label: 'Estable', color: 'text-primary bg-primary/10', border: 'border-primary/20' };
  return { label: 'Atención', color: 'text-amber-400 bg-amber-400/10', border: 'border-amber-400/20' };
}

function PeriodToggle({
  selected,
  onChange,
}: {
  selected: Period;
  onChange: (p: Period) => void;
}) {
  const periods: Period[] = ['HOY', 'SEMANA', 'MES'];
  return (
    <div className="flex bg-surface-container-low p-1 rounded-xl border border-outline-variant/10">
      {periods.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'px-5 py-2 text-[10px] uppercase tracking-widest transition-colors rounded-lg',
            selected === p
              ? 'text-primary bg-surface-container-high shadow-sm font-bold'
              : 'text-on-surface/40 hover:text-on-surface',
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

const BOOKING_FIELDS =
  'id client { id name } lines { service { id name } price durationMinutes } scheduledDate startTime endTime totalPrice state barbershop { id } professional { id name }';

export default function DashboardPage() {
  const t = useT('dashboard');
  const router = useRouter();
  const client = useSimfinityClient();
  const { selectedBarbershop, barbershops, loading: barbershopLoading } = useBarbershop();
  const [period, setPeriod] = useState<Period>('HOY');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const dateFrom = useMemo(() => {
    const days = periodDays(period);
    return format(subDays(new Date(), days), 'yyyy-MM-dd');
  }, [period]);

  const fetchDashboard = useCallback(async () => {
    if (!selectedBarbershop) return;
    setLoading(true);

    const safe = async <T,>(promise: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await promise;
      } catch {
        return fallback;
      }
    };

    const shopFilter = [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }];

    const [bookings, professionals, reviews, recentBookings] = await Promise.all([
      safe(
        client
          .find('booking')
          .fields(BOOKING_FIELDS)
          .where('barbershop', shopFilter)
          .where('scheduledDate', 'GTE', dateFrom)
          .exec(),
        [],
      ),
      safe(
        client
          .find('professional')
          .fields('id name bio')
          .where('barbershop', shopFilter)
          .exec(),
        [],
      ),
      safe(
        client
          .find('review')
          .fields('id rating booking { professional { id } }')
          .where('barbershop', shopFilter)
          .exec(),
        [],
      ),
      safe(
        client
          .find('booking')
          .fields(BOOKING_FIELDS)
          .where('barbershop', shopFilter)
          .sort('scheduledDate', 'DESC')
          .page(1, 5)
          .exec(),
        [],
      ),
    ]);

    const bookingList = bookings as Booking[];
    const totalBookings = bookingList.length;
    const totalRevenue = bookingList.reduce((s, b) => s + (b.totalPrice ?? 0), 0);
    const cancelledCount = bookingList.filter(
      (b) => b.state === 'CANCELLED_BY_CLIENT' || b.state === 'CANCELLED_BY_SHOP',
    ).length;
    const cancelRate =
      totalBookings > 0 ? Math.round((cancelledCount / totalBookings) * 1000) / 10 : 0;

    const reviewList = reviews as { id: string; rating?: number; booking?: { professional?: { id: string } } }[];
    const avgRating =
      reviewList.length > 0
        ? Math.round(
            (reviewList.reduce((s, r) => s + (r.rating ?? 0), 0) / reviewList.length) * 100,
          ) / 100
        : 0;

    const revenueMap = new Map<string, number>();
    bookingList.forEach((b) => {
      if (b.scheduledDate) {
        const day = b.scheduledDate.slice(0, 10);
        revenueMap.set(day, (revenueMap.get(day) ?? 0) + (b.totalPrice ?? 0));
      }
    });
    const revenueByDay = Array.from(revenueMap.entries())
      .map(([date, revenue]) => ({ date, revenue }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const serviceMap = new Map<string, number>();
    bookingList.forEach((b) => {
      b.lines?.forEach((l) => {
        const name = l.service?.name ?? 'Otro';
        serviceMap.set(name, (serviceMap.get(name) ?? 0) + 1);
      });
    });
    const bookingsByService = Array.from(serviceMap.entries())
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count);

    const proList = professionals as { id: string; name?: string; bio?: string }[];
    const proBookingMap = new Map<string, { count: number; revenue: number }>();
    bookingList.forEach((b) => {
      const pid = b.professional?.id;
      if (!pid) return;
      const prev = proBookingMap.get(pid) ?? { count: 0, revenue: 0 };
      proBookingMap.set(pid, {
        count: prev.count + 1,
        revenue: prev.revenue + (b.totalPrice ?? 0),
      });
    });

    const proRatingMap = new Map<string, number[]>();
    reviewList.forEach((r) => {
      const pid = r.booking?.professional?.id;
      if (!pid || !r.rating) return;
      const arr = proRatingMap.get(pid) ?? [];
      arr.push(r.rating);
      proRatingMap.set(pid, arr);
    });

    const profData = proList
      .map((p) => {
        const stats = proBookingMap.get(p.id) ?? { count: 0, revenue: 0 };
        const ratings = proRatingMap.get(p.id) ?? [];
        const avgR =
          ratings.length > 0
            ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 100) / 100
            : 0;
        return {
          id: p.id,
          name: p.name ?? 'Sin nombre',
          initials: getInitials(p.name ?? '??'),
          role: p.bio ?? 'Profesional',
          bookings: stats.count,
          revenue: stats.revenue,
          rating: avgR,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    setData({
      totalRevenue,
      totalBookings,
      cancelRate,
      avgRating,
      hasBarbershop: true,
      recentBookings: recentBookings as Booking[],
      professionals: profData,
      revenueByDay,
      bookingsByService,
    });
    setLoading(false);
  }, [client, selectedBarbershop, dateFrom]);

  useEffect(() => {
    if (barbershopLoading || !selectedBarbershop) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDashboard();
  }, [fetchDashboard, barbershopLoading, selectedBarbershop]);

  const isLoading = barbershopLoading || (!!selectedBarbershop && loading);

  const bookingColumns: Column[] = [
    {
      key: 'client',
      label: t('colClient', 'Cliente'),
      render: (v) => {
        const c = v as { name?: string } | null;
        return <span className="font-medium">{c?.name ?? '—'}</span>;
      },
    },
    {
      key: 'lines',
      label: t('colService', 'Servicio'),
      render: (v) => {
        const lines = v as { service?: { name?: string } }[] | null;
        return <span>{lines?.[0]?.service?.name ?? '—'}</span>;
      },
    },
    {
      key: 'scheduledDate',
      label: t('colDate', 'Fecha'),
      render: (v) => {
        if (!v) return '—';
        try {
          return new Date(v as string).toLocaleDateString('es-AR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          });
        } catch {
          return String(v);
        }
      },
    },
    {
      key: 'totalPrice',
      label: t('colAmount', 'Monto'),
      render: (v) => (
        <span className="font-headline italic text-primary">
          {formatCurrency(Number(v) || 0)}
        </span>
      ),
    },
    {
      key: 'state',
      label: t('colState', 'Estado'),
      render: (v) => <StatusChip status={String(v ?? 'PENDING')} />,
    },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <span className="material-symbols-outlined text-primary text-4xl animate-spin">
          progress_activity
        </span>
      </div>
    );
  }

  if (!selectedBarbershop && barbershops.length === 0) {
    return (
      <EmptyState
        icon="storefront"
        title={t('noBarbershop', 'Todavía no tenés una barbería registrada')}
        message={t(
          'noBarbershopMessage',
          'Creá tu barbería para empezar a recibir reservas y gestionar tu negocio.',
        )}
        actionLabel={t('createBarbershop', 'Crear barbería')}
        onAction={() => router.push('/onboarding/barbershop')}
      />
    );
  }

  return (
    <div className="max-w-7xl space-y-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6">
        <div>
          <span className="text-primary text-[10px] tracking-[0.3em] uppercase block mb-2">
            {t('subtitle', 'Performance Analytics')}
          </span>
          <h1 className="font-headline text-5xl text-on-surface tracking-tight leading-tight italic font-bold">
            {t('title', 'Reportes y Métricas')}
          </h1>
          <div className="h-1 w-12 bg-primary mt-6" />
        </div>

        <div className="flex items-center gap-4">
          <PeriodToggle selected={period} onChange={setPeriod} />
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KpiCard
          label={t('kpiRevenue', 'Ingresos Totales')}
          value={formatCurrency(data?.totalRevenue ?? 0)}
          icon="payments"
        />
        <KpiCard
          label={t('kpiBookings', 'Turnos Atendidos')}
          value={(data?.totalBookings ?? 0).toLocaleString('es-AR')}
          icon="calendar_month"
        />
        <KpiCard
          label={t('kpiCancellations', 'Cancelaciones')}
          value={`${data?.cancelRate ?? 0}%`}
          icon="event_busy"
        />
        <KpiCard
          label={t('kpiRating', 'Rating Promedio')}
          value={String(data?.avgRating || '—')}
          icon="star"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-12 gap-10">
        {/* Revenue Chart */}
        <div className="col-span-12 lg:col-span-7 space-y-4">
          <div className="flex items-center gap-4">
            <h4 className="text-[10px] uppercase tracking-[0.4em] text-on-surface/40 whitespace-nowrap">
              {t('revenueByDay', 'Ingresos por Día')}
            </h4>
            <span className="h-px flex-1 bg-outline-variant/10" />
          </div>
          {data?.revenueByDay && data.revenueByDay.length > 0 ? (
            <RevenueChart data={data.revenueByDay} />
          ) : (
            <div className="bg-surface-container-low rounded-2xl p-10 border border-outline-variant/10 flex flex-col items-center justify-center h-80">
              <span className="material-symbols-outlined text-on-surface-variant/30 text-4xl">
                show_chart
              </span>
              <p className="text-on-surface-variant text-sm mt-3">
                {t('chartPlaceholder', 'Los datos del gráfico se mostrarán cuando haya reservas')}
              </p>
            </div>
          )}
        </div>

        {/* Bookings by Service Chart */}
        <div className="col-span-12 lg:col-span-5 space-y-4">
          <div className="flex items-center gap-4">
            <h4 className="text-[10px] uppercase tracking-[0.4em] text-on-surface/40 whitespace-nowrap">
              {t('bookingsByService', 'Turnos por Servicio')}
            </h4>
            <span className="h-px flex-1 bg-outline-variant/10" />
          </div>
          {data?.bookingsByService && data.bookingsByService.length > 0 ? (
            <BookingsByServiceChart data={data.bookingsByService} />
          ) : (
            <div className="bg-surface-container-low rounded-2xl p-10 border border-outline-variant/10 flex flex-col items-center justify-center h-80">
              <span className="material-symbols-outlined text-on-surface-variant/30 text-4xl">
                bar_chart
              </span>
              <p className="text-on-surface-variant text-sm mt-3">
                {t('noServiceData', 'Sin datos de servicios para este período')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Bookings */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <h4 className="text-[10px] uppercase tracking-[0.4em] text-on-surface/40 whitespace-nowrap">
            {t('recentBookings', 'Últimas Reservas')}
          </h4>
          <span className="h-px flex-1 bg-outline-variant/10" />
        </div>
        <DataTable
          columns={bookingColumns}
          data={(data?.recentBookings as unknown as Record<string, unknown>[]) ?? []}
          emptyMessage={t('noBookings', 'No hay reservas aún')}
        />
      </div>

      {/* Professional Ranking */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <h4 className="text-[10px] uppercase tracking-[0.4em] text-on-surface/40 whitespace-nowrap">
            {t('professionalRanking', 'Ranking de Profesionales')}
          </h4>
          <span className="h-px flex-1 bg-outline-variant/10" />
        </div>

        {data?.professionals && data.professionals.length > 0 ? (
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-surface-container-high/40">
                <tr>
                  <th className="py-5 px-8 text-[10px] uppercase tracking-widest text-on-surface/40 font-bold">
                    {t('professional', 'Profesional')}
                  </th>
                  <th className="py-5 px-8 text-[10px] uppercase tracking-widest text-on-surface/40 font-bold">
                    {t('shifts', 'Turnos')}
                  </th>
                  <th className="py-5 px-8 text-[10px] uppercase tracking-widest text-on-surface/40 font-bold">
                    {t('revenue', 'Ingresos')}
                  </th>
                  <th className="py-5 px-8 text-[10px] uppercase tracking-widest text-on-surface/40 font-bold">
                    Rating
                  </th>
                  <th className="py-5 px-8 text-[10px] uppercase tracking-widest text-on-surface/40 font-bold text-right">
                    {t('status', 'Estado')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/5">
                {data.professionals.map((pro) => {
                  const status = getStatusLabel(pro.rating);
                  return (
                    <tr
                      key={pro.id}
                      className="group hover:bg-surface-container-high/20 transition-colors"
                    >
                      <td className="py-6 px-8">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-xs font-bold">
                            {pro.initials}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-on-surface">{pro.name}</p>
                            <p className="text-[10px] text-on-surface/30 uppercase tracking-widest">
                              {pro.role}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6 px-8 text-sm text-on-surface">{pro.bookings}</td>
                      <td className="py-6 px-8 text-sm font-headline italic font-bold text-primary">
                        {formatCurrency(pro.revenue)}
                      </td>
                      <td className="py-6 px-8">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-on-surface">
                            {pro.rating || '—'}
                          </span>
                          {pro.rating > 0 && (
                            <span
                              className="material-symbols-outlined text-sm text-primary"
                              style={{ fontVariationSettings: "'FILL' 1" }}
                            >
                              star
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-6 px-8 text-right">
                        <span
                          className={cn(
                            'inline-block px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest border',
                            status.color,
                            status.border,
                          )}
                        >
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 py-12 text-center">
            <p className="text-on-surface-variant text-sm">
              {t('noProfessionals', 'No hay profesionales registrados')}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-outline-variant/10 pt-8 flex items-center justify-between text-on-surface/30">
        <p className={cn('text-[10px] uppercase tracking-[0.2em] italic text-on-surface/30')}>
          {t('lastUpdate', 'Última actualización de datos: ahora')}
        </p>
      </footer>
    </div>
  );
}
