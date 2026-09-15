'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Image from 'next/image';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { StatusChip, StarRating } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';
import { RejectModal } from '@/components/shared/modals';
import { MapView } from '@/components/shared/maps';
import { Button } from '@/components/shared/ui';

type BusinessHour = {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
};

type Barbershop = {
  id: string;
  name: string;
  slug: string;
  description: string;
  state: string;
  averageRating: number;
  reviewCount: number;
  rejectionReason: string;
  logoUrl: string;
  coverImageUrl: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  slotDurationMinutes: number;
  bufferMinutes: number;
  minAdvanceHours: number;
  maxAdvanceDays: number;
  cancellationPolicyHours: number;
  cancellationFeePercent: number;
  businessHours: BusinessHour[];
  address: { street?: string; number?: string; city?: string; state?: string; zip?: string; country?: string };
  contactInfo: { phone?: string; email?: string; whatsapp?: string; instagramUrl?: string; facebookUrl?: string };
  owner: { id: string; name: string; email: string };
};

const FIELDS_QUERY =
  'id name slug description state averageRating reviewCount rejectionReason ' +
  'logoUrl coverImageUrl timezone latitude longitude ' +
  'slotDurationMinutes bufferMinutes minAdvanceHours maxAdvanceDays ' +
  'cancellationPolicyHours cancellationFeePercent ' +
  'businessHours { dayOfWeek openTime closeTime isClosed } ' +
  'address { street number city state zip country } ' +
  'contactInfo { phone email whatsapp instagramUrl facebookUrl } ' +
  'owner { id name email }';

export default function AdminBarbershopViewPage() {
  const t = useT('admin');
  const router = useRouter();
  const params = useParams();
  const client = useSimfinityClient();
  const id = params.id as string;

  const [shop, setShop] = useState<Barbershop | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const fetchShop = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.getById('barbershop', id, FIELDS_QUERY);
      setShop(result as unknown as Barbershop);
    } catch {
      setShop(null);
    }
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load barbershop on mount / id change
    void fetchShop();
  }, [fetchShop]);

  const scheduleDayLabel = (dayOfWeek: number) => {
    const raw = Number(dayOfWeek);
    const idx = raw >= 1 && raw <= 7 ? raw - 1 : ((raw % 7) + 7) % 7;
    return t(`scheduleWeekday${idx}`, `Day ${raw}`);
  };

  const handleTransition = async (action: string) => {
    setActionLoading(true);
    try {
      await client.transition('barbershop', action, id);
      await fetchShop();
    } catch (err) {
      console.error('Transition failed:', err);
    }
    setActionLoading(false);
  };

  const handleReject = async (reason: string) => {
    setRejectOpen(false);
    setActionLoading(true);
    try {
      await client.transition('barbershop', 'reject', id);
      await client.update('barbershop', id, { rejectionReason: reason });
      await fetchShop();
    } catch (err) {
      console.error('Reject failed:', err);
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

  if (!shop) {
    return (
      <div className="text-center py-20">
        <p className="text-on-surface-variant">{t('notFound', 'Barbería no encontrada')}</p>
      </div>
    );
  }

  const isDraft = shop.state === 'DRAFT';
  const isPending = shop.state === 'PENDING_REVIEW';
  const isRejected = shop.state === 'REJECTED';
  const isApproved = shop.state === 'APPROVED';
  const isSuspended = shop.state === 'SUSPENDED';

  const fullAddress = [
    shop.address?.street,
    shop.address?.number,
    shop.address?.city,
    shop.address?.state,
  ].filter(Boolean).join(', ');

  const hasCoords = shop.latitude != null && shop.longitude != null;

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        title={shop.name}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('barbershops', 'Barberías'), href: '/admin/barbershops' },
          { label: shop.name },
        ]}
        actions={
          <button
            onClick={() => router.push(`/admin/barbershops/${id}/edit`)}
            className="px-5 py-2.5 bg-surface-container-high text-on-surface-variant rounded-xl text-sm font-semibold hover:bg-surface-container-highest transition-colors"
          >
            <span className="material-symbols-outlined text-sm mr-1 align-middle">edit</span>
            {t('edit', 'Editar')}
          </button>
        }
      />

      {/* Cover + Logo header */}
      {(shop.coverImageUrl || shop.logoUrl) && (
        <div className="relative rounded-2xl overflow-hidden border border-outline-variant/10">
          {shop.coverImageUrl ? (
            <div className="relative h-48 bg-surface-container-low">
              <Image
                src={shop.coverImageUrl}
                alt={shop.name}
                fill
                className="object-cover"
                unoptimized
              />
            </div>
          ) : (
            <div className="h-48 bg-surface-container-low" />
          )}
          {shop.logoUrl && (
            <div className="absolute bottom-0 left-8 translate-y-1/2 w-24 h-24 rounded-xl bg-surface border-4 border-surface overflow-hidden shadow-xl">
              <Image
                src={shop.logoUrl}
                alt={`${shop.name} logo`}
                fill
                className="object-cover"
                unoptimized
              />
            </div>
          )}
        </div>
      )}
      {shop.logoUrl && <div className="h-8" />}

      {/* Status + Actions */}
      <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <StatusChip status={shop.state} />
          {shop.rejectionReason && (
            <p className="text-sm text-error/80 italic">
              {t('reason', 'Motivo:')} {shop.rejectionReason}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isDraft && (
            <Button
              type="button"
              variant="gold"
              size="form"
              disabled={actionLoading}
              onClick={() => handleTransition('submitforreview')}
              className="text-on-primary font-bold"
            >
              {t('submitForReview', 'Enviar a revisión')}
            </Button>
          )}
          {isPending && (
            <>
              <button disabled={actionLoading} onClick={() => handleTransition('approve')} className="bg-emerald-500 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-emerald-600 transition-colors disabled:opacity-50">
                {t('approve', 'Aprobar')}
              </button>
              <button disabled={actionLoading} onClick={() => setRejectOpen(true)} className="bg-error text-on-error px-6 py-2.5 rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50">
                {t('reject', 'Rechazar')}
              </button>
            </>
          )}
          {isRejected && (
            <Button
              type="button"
              variant="gold"
              size="form"
              disabled={actionLoading}
              onClick={() => handleTransition('resubmit')}
              className="text-on-primary font-bold"
            >
              {t('resubmit', 'Reenviar a revisión')}
            </Button>
          )}
          {isApproved && (
            <button disabled={actionLoading} onClick={() => handleTransition('suspend')} className="bg-error/10 text-error px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-error/20 transition-colors disabled:opacity-50">
              {t('suspend', 'Suspender')}
            </button>
          )}
          {isSuspended && (
            <button disabled={actionLoading} onClick={() => handleTransition('reactivate')} className="bg-emerald-500/10 text-emerald-400 px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
              {t('reactivate', 'Reactivar')}
            </button>
          )}
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* General Info */}
        <ViewSection icon="info" title={t('generalInfo', 'Información General')}>
          <DetailRow label={t('name', 'Nombre')} value={shop.name} />
          <DetailRow label={t('slug', 'Slug')} value={shop.slug} />
          <DetailRow label={t('description', 'Descripción')} value={shop.description || '—'} />
          <DetailRow label={t('timezone', 'Zona horaria')} value={shop.timezone || '—'} />
        </ViewSection>

        {/* Owner */}
        <ViewSection icon="person" title={t('owner', 'Propietario')}>
          {shop.owner ? (
            <>
              <DetailRow label={t('name', 'Nombre')} value={shop.owner.name} />
              <DetailRow label={t('email', 'Email')} value={shop.owner.email} />
              <button
                onClick={() => router.push(`/admin/users/${shop.owner.id}/view`)}
                className="text-primary text-xs uppercase tracking-widest font-bold hover:underline mt-2"
              >
                {t('viewProfile', 'Ver perfil')}
              </button>
            </>
          ) : (
            <p className="text-on-surface-variant text-sm">—</p>
          )}
        </ViewSection>

        {/* Address & Map */}
        <ViewSection icon="location_on" title={t('addressContact', 'Ubicación')}>
          <DetailRow label={t('address', 'Dirección')} value={fullAddress || '—'} />
          {shop.address?.zip && (
            <DetailRow label={t('zipCode', 'Código Postal')} value={shop.address.zip} />
          )}
          <DetailRow label={t('country', 'País')} value={shop.address?.country || '—'} />
          {hasCoords && (
            <>
              <div className="flex gap-6 text-xs text-on-surface-variant/60 mt-2">
                <span>Lat: {shop.latitude!.toFixed(6)}</span>
                <span>Lng: {shop.longitude!.toFixed(6)}</span>
              </div>
              <div className="mt-4 rounded-xl overflow-hidden h-48 border border-outline-variant/10">
                <MapView
                  center={[shop.latitude!, shop.longitude!]}
                  zoom={15}
                  markers={[{ lat: shop.latitude!, lng: shop.longitude! }]}
                  className="w-full h-full"
                />
              </div>
            </>
          )}
        </ViewSection>

        {/* Contact */}
        <ViewSection icon="phone" title={t('contact', 'Contacto')}>
          {shop.contactInfo ? (
            <>
              <DetailRow label={t('phone', 'Teléfono')} value={shop.contactInfo.phone || '—'} />
              <DetailRow label={t('email', 'Email')} value={shop.contactInfo.email || '—'} />
              <DetailRow label={t('whatsapp', 'WhatsApp')} value={shop.contactInfo.whatsapp || '—'} />
              {shop.contactInfo.instagramUrl && (
                <DetailRow label={t('instagram', 'Instagram')} value={shop.contactInfo.instagramUrl} />
              )}
              {shop.contactInfo.facebookUrl && (
                <DetailRow label={t('facebook', 'Facebook')} value={shop.contactInfo.facebookUrl} />
              )}
            </>
          ) : (
            <p className="text-on-surface-variant text-sm">—</p>
          )}
        </ViewSection>

        {/* Business Hours */}
        <ViewSection icon="schedule" title={t('schedule', 'Horarios de Atención')}>
          {shop.businessHours?.length > 0 ? (
            <div className="space-y-2">
              {shop.businessHours
                .slice()
                .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
                .map((h) => (
                  <div key={h.dayOfWeek} className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-on-surface font-medium">
                      {scheduleDayLabel(h.dayOfWeek)}
                    </span>
                    {h.isClosed ? (
                      <span className="text-xs text-on-surface-variant/40 uppercase tracking-wider">
                        {t('scheduleClosed', 'Closed')}
                      </span>
                    ) : (
                      <span className="text-sm text-primary font-semibold">
                        {h.openTime} - {h.closeTime}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-on-surface-variant text-sm">—</p>
          )}
        </ViewSection>

        {/* Booking Configuration */}
        <ViewSection icon="event_available" title={t('bookingConfig', 'Configuración de Turnos')}>
          <DetailRow
            label={t('slotDuration', 'Duración del turno')}
            value={shop.slotDurationMinutes ? `${shop.slotDurationMinutes} min` : '—'}
          />
          <DetailRow
            label={t('buffer', 'Buffer entre turnos')}
            value={shop.bufferMinutes != null ? `${shop.bufferMinutes} min` : '—'}
          />
          <DetailRow
            label={t('minAdvance', 'Anticipación mínima')}
            value={shop.minAdvanceHours != null ? `${shop.minAdvanceHours} hs` : '—'}
          />
          <DetailRow
            label={t('maxAdvance', 'Anticipación máxima')}
            value={shop.maxAdvanceDays != null ? `${shop.maxAdvanceDays} días` : '—'}
          />
          <DetailRow
            label={t('cancellationHours', 'Cancelación límite')}
            value={shop.cancellationPolicyHours != null ? `${shop.cancellationPolicyHours} hs` : '—'}
          />
          <DetailRow
            label={t('cancellationFee', 'Cargo por cancelación')}
            value={shop.cancellationFeePercent != null ? `${shop.cancellationFeePercent}%` : '—'}
          />
        </ViewSection>

        {/* Ratings */}
        <ViewSection icon="star" title={t('ratings', 'Valoraciones')}>
          <div className="flex items-center gap-6">
            <span className="font-headline text-4xl italic text-on-surface">
              {shop.averageRating?.toFixed(1) ?? '—'}
            </span>
            {shop.averageRating != null && <StarRating rating={shop.averageRating} />}
          </div>
          <p className="text-on-surface-variant text-sm mt-2">
            {shop.reviewCount ?? 0} {t('reviews', 'reseñas')}
          </p>
        </ViewSection>
      </div>

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={handleReject}
        title={t('rejectBarbershop', 'Rechazar Barbería')}
        placeholder={t('rejectPlaceholder', 'Motivo del rechazo...')}
      />
    </div>
  );
}

function ViewSection({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface-container-low rounded-2xl p-8 border-l-2 border-primary space-y-4">
      <h3 className="text-xs uppercase tracking-widest text-primary font-semibold flex items-center gap-2">
        <span className="material-symbols-outlined text-lg">{icon}</span>
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </section>
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
