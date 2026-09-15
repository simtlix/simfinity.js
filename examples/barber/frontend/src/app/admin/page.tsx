'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { KpiCard } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';

interface PlatformStats {
  totalBarbershops: number;
  totalUsers: number;
  totalRevenue: number;
  pendingReviews: number;
  pendingBarbershops: { id: string; name: string; ownerName: string; city: string }[];
  recentActivity: { type: string; text: string; detail: string; time: string }[];
}

function formatCurrency(n: number) {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0 })}`;
}

function useAdminDashboardData() {
  const client = useSimfinityClient();
  const [data, setData] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const safe = async <T,>(promise: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await promise;
      } catch {
        return fallback;
      }
    };

    (async () => {
      const [barbershops, users, bookings, pendingBarbershopList] = await Promise.all([
        safe(client.find('barbershop').fields('id state').exec(), []),
        safe(client.find('user').fields('id').exec(), []),
        safe(client.find('booking').fields('id totalPrice').exec(), []),
        safe(
          client
            .find('barbershop')
            .fields('id name state address { city }')
            .where('state', 'EQ', 'PENDING_REVIEW')
            .sort('name', 'ASC')
            .page(1, 5)
            .exec(),
          [],
        ),
      ]);

      if (cancelled) return;

      const bList = barbershops as { id: string; state?: string }[];
      const bookingList = bookings as { id: string; totalPrice?: number }[];
      const totalRevenue = bookingList.reduce((s, b) => s + (b.totalPrice ?? 0), 0);
      const pendingCount = bList.filter((b) => b.state === 'PENDING_REVIEW').length;

      const pending = (pendingBarbershopList as Record<string, unknown>[]).map((b) => ({
        id: String(b.id),
        name: String(b.name ?? ''),
        ownerName: '',
        city: String((b.address as { city?: string } | null)?.city ?? ''),
      }));

      setData({
        totalBarbershops: bList.filter((b) => b.state === 'APPROVED').length,
        totalUsers: (users as unknown[]).length,
        totalRevenue,
        pendingReviews: pendingCount,
        pendingBarbershops: pending,
        recentActivity: [],
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  return { data, loading };
}

export default function AdminDashboardPage() {
  const t = useT('admin');
  const router = useRouter();
  const { data, loading } = useAdminDashboardData();

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
    <div className="max-w-7xl space-y-12">
      <PageHeader
        title={t('dashboardTitle', 'Visión General del Sistema')}
        subtitle={t(
          'dashboardSubtitle',
          'Gestión centralizada de la red global de The Groomed.',
        )}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KpiCard
          label={t('activeBarbershops', 'Barberías Activas')}
          value={(data?.totalBarbershops ?? 0).toLocaleString()}
          icon="storefront"
        />
        <KpiCard
          label={t('totalUsers', 'Usuarios Totales')}
          value={(data?.totalUsers ?? 0).toLocaleString()}
          icon="group"
        />
        <KpiCard
          label={t('globalRevenue', 'Ingresos Globales')}
          value={formatCurrency(data?.totalRevenue ?? 0)}
          icon="payments"
        />
        <div className="bg-surface-container-low p-6 rounded-2xl border border-error/20 hover:border-error/50 transition-colors relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-error/5 blur-3xl rounded-full -mr-8 -mt-8" />
          <div className="flex justify-between items-start mb-4">
            <div className="bg-error-container/20 p-3 rounded-lg text-error">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                report
              </span>
            </div>
            <span className="bg-error text-on-error px-2 py-0.5 rounded text-[10px] font-bold tracking-tight">
              {t('alert', 'ALERTA')}
            </span>
          </div>
          <p className="text-on-surface-variant text-sm font-medium mb-1">
            {t('pendingReviews', 'Revisiones Pendientes')}
          </p>
          <span className="text-3xl font-headline italic font-bold text-error">
            {data?.pendingReviews ?? 0}
          </span>
          <div className="mt-4 flex items-center gap-2 text-error/80 text-xs">
            <span className="material-symbols-outlined text-sm">priority_high</span>
            <span>{t('requiresAction', 'Requiere acción inmediata')}</span>
          </div>
        </div>
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-12 gap-10 items-start">
        {/* Pending Approvals */}
        <section className="col-span-12 lg:col-span-7 space-y-6">
          <div className="flex justify-between items-end mb-4">
            <h2 className="font-headline text-3xl italic">
              {t('pendingApprovals', 'Barberías Pendientes de Aprobación')}
            </h2>
            <button
              onClick={() => router.push('/admin/barbershops?status=PENDING_REVIEW')}
              className="text-primary text-xs uppercase tracking-widest font-bold border-b border-primary/30 pb-1"
            >
              {t('viewAll', 'Ver todas')}
            </button>
          </div>

          <div className="space-y-4">
            {(data?.pendingBarbershops ?? []).length === 0 ? (
              <div className="bg-surface-container-high/40 p-8 rounded-2xl text-center">
                <span className="material-symbols-outlined text-on-surface-variant/40 text-3xl">
                  check_circle
                </span>
                <p className="text-on-surface-variant text-sm mt-3">
                  {t('noPending', 'No hay barberías pendientes de aprobación')}
                </p>
              </div>
            ) : (
              data?.pendingBarbershops.map((shop) => (
                <div
                  key={shop.id}
                  className="bg-surface-container-high/40 p-5 rounded-2xl flex items-center justify-between group hover:bg-surface-container-high transition-colors"
                >
                  <div className="flex items-center gap-5">
                    <div className="w-16 h-16 rounded-xl overflow-hidden bg-surface-container-highest flex items-center justify-center">
                      <span className="material-symbols-outlined text-on-surface-variant/40 text-2xl">
                        storefront
                      </span>
                    </div>
                    <div>
                      <h4 className="font-headline text-xl italic leading-tight">
                        {shop.name}
                      </h4>
                      <p className="text-on-surface-variant/60 text-xs">
                        {shop.city || t('noCityInfo', 'Sin información de ciudad')}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => router.push(`/admin/barbershops/${shop.id}/view`)}
                    className="bg-surface-container-highest text-primary font-bold px-6 py-2.5 rounded-lg text-xs tracking-widest uppercase hover:bg-primary hover:text-on-primary transition-all"
                  >
                    {t('review', 'Revisar')}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="col-span-12 lg:col-span-5" />

      </div>
    </div>
  );
}
