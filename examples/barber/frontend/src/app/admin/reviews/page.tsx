'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { PaginationBar, StarRating } from '@/components/shared/data';
import { PageHeader } from '@/components/shared/page';
import { ConfirmModal } from '@/components/shared/modals';

type ReportedReview = {
  id: string;
  rating: number;
  comment: string;
  isReported: boolean;
  createdAt: string;
  client: { id: string; name: string; avatarUrl?: string };
  barbershop: { id: string; name: string };
};

export default function AdminReviewsPage() {
  const t = useT('admin');
  const client = useSimfinityClient();
  const pagination = usePagination(10);

  const [search, setSearch] = useState('');
  const [reviews, setReviews] = useState<ReportedReview[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [removeTarget, setRemoveTarget] = useState<ReportedReview | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let query = client
        .find('review')
        .fields(
          'id rating comment isReported createdAt client { id name avatarUrl } barbershop { id name }',
        )
        .where('isReported', 'EQ', 'true')
        .sort('createdAt', 'DESC')
        .page(pagination.page, pagination.pageSize);

      if (search.trim()) {
        query = query.where('comment', 'LIKE', search.trim());
      }

      const results = await query.exec();
      setReviews(results as unknown as ReportedReview[]);

      try {
        let aggQuery = client
          .aggregate('review')
          .fact('count', 'total')
          .where('isReported', 'EQ', 'true');
        if (search.trim()) {
          aggQuery = aggQuery.where('comment', 'LIKE', search.trim());
        }
        const agg = await aggQuery.exec();
        setTotal((agg as { total?: number })?.total ?? (results as unknown[]).length);
      } catch {
        setTotal((results as unknown[]).length);
      }
    } catch {
      setReviews([]);
      setTotal(0);
    }
    setLoading(false);
  }, [client, pagination.page, pagination.pageSize, search]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  const handleDismiss = async (reviewId: string) => {
    try {
      await client.update('review', reviewId, { isReported: false });
      await fetchData();
    } catch (err) {
      console.error('Dismiss failed:', err);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      await client.delete('review', removeTarget.id);
      setRemoveTarget(null);
      await fetchData();
    } catch (err) {
      console.error('Remove failed:', err);
    }
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

  return (
    <div className="max-w-7xl space-y-8">
      <PageHeader
        title={t('reviewModeration', 'Moderación de Reseñas')}
        subtitle={t(
          'reviewModerationSub',
          'Gestiona los comentarios reportados por la comunidad.',
        )}
        breadcrumbs={[
          { label: t('administration', 'Administración'), href: '/admin' },
          { label: t('reportedReviews', 'Reseñas Reportadas') },
        ]}
      />

      {/* Filters */}
      <div className="bg-surface-container-low p-6 rounded-xl border-b border-outline-variant/10 flex flex-wrap gap-6 items-end">
        <div className="flex-1 min-w-[300px]">
          <label className="block text-[10px] uppercase tracking-widest text-primary font-bold mb-2">
            {t('directSearch', 'Búsqueda Directa')}
          </label>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
              search
            </span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                pagination.setPage(1);
              }}
              className="w-full bg-surface-container-high border-b-2 border-outline-variant/20 focus:border-primary focus:ring-0 text-on-surface py-3 pl-12 pr-4 transition-all outline-none"
              placeholder={t('searchByUserOrShop', 'Buscar por usuario o barbería...')}
            />
          </div>
        </div>
      </div>

      {/* Reviews List */}
      <div className="grid grid-cols-1 gap-6">
        {reviews.length === 0 ? (
          <div className="bg-surface-container-low rounded-xl p-12 text-center border border-outline-variant/10">
            <span className="material-symbols-outlined text-on-surface-variant/30 text-4xl">
              check_circle
            </span>
            <p className="text-on-surface-variant mt-4">
              {t('noReportedReviews', 'No hay reseñas reportadas pendientes.')}
            </p>
          </div>
        ) : (
          reviews.map((review) => (
            <div
              key={review.id}
              className="bg-surface-container-low rounded-xl overflow-hidden border border-white/5 hover:border-primary/20 transition-all"
            >
              <div className="flex flex-col md:flex-row">
                <div className="p-8 flex-1">
                  {/* Header */}
                  <div className="flex justify-between items-start mb-6">
                    <div className="flex items-center gap-4">
                      <div className="relative w-12 h-12 rounded-full overflow-hidden border border-primary/20 bg-surface-container-highest flex items-center justify-center">
                        {review.client?.avatarUrl ? (
                          <Image
                            src={review.client.avatarUrl}
                            alt={review.client.name}
                            fill
                            className="object-cover"
                            sizes="48px"
                          />
                        ) : (
                          <span className="material-symbols-outlined text-on-surface-variant/40">
                            person
                          </span>
                        )}
                      </div>
                      <div>
                        <h4 className="font-headline text-xl text-on-surface italic">
                          {review.client?.name ?? t('anonymous', 'Anónimo')}
                        </h4>
                        <StarRating rating={review.rating} />
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="inline-block px-3 py-1 bg-primary-container text-on-primary-container text-[10px] font-bold uppercase tracking-widest rounded-full mb-2">
                        {t('reported', 'Reportado')}
                      </span>
                      {review.createdAt && (
                        <p className="text-xs text-on-surface-variant/50">
                          {new Date(review.createdAt).toLocaleDateString('es-AR', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Barbershop */}
                  <div className="flex gap-2 items-center mb-4">
                    <span className="material-symbols-outlined text-on-surface-variant/40 text-lg">
                      storefront
                    </span>
                    <span className="text-on-surface-variant font-medium text-sm tracking-tight">
                      {review.barbershop?.name ?? '—'}
                    </span>
                  </div>

                  {/* Comment */}
                  <p className="text-on-surface/80 leading-relaxed bg-surface/40 p-5 rounded-lg border-l-2 border-primary/40 italic">
                    &ldquo;{review.comment}&rdquo;
                  </p>
                </div>

                {/* Action Panel */}
                <div className="bg-surface-container-high/50 p-8 flex flex-col justify-center gap-4 w-full md:w-64 border-t md:border-t-0 md:border-l border-white/5">
                  <button
                    onClick={() => handleDismiss(review.id)}
                    className="w-full bg-surface-container-highest text-on-surface hover:bg-surface-bright py-4 px-6 rounded-lg text-xs uppercase tracking-widest transition-all font-semibold"
                  >
                    {t('keepReview', 'Mantener Reseña')}
                  </button>
                  <button
                    onClick={() => setRemoveTarget(review)}
                    className="w-full bg-error-container/20 text-error hover:bg-error-container/40 py-4 px-6 rounded-lg text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 font-semibold"
                  >
                    <span className="material-symbols-outlined text-lg">delete</span>
                    {t('deleteReview', 'Eliminar Reseña')}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {reviews.length > 0 && (
        <PaginationBar
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={total}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
        />
      )}

      <ConfirmModal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
        title={t('confirmDeleteReview', 'Eliminar Reseña')}
        message={t(
          'confirmDeleteReviewMessage',
          '¿Estás seguro de que querés eliminar esta reseña? Esta acción no se puede deshacer.',
        )}
        confirmLabel={t('delete', 'Eliminar')}
        cancelLabel={t('cancel', 'Cancelar')}
        variant="danger"
      />
    </div>
  );
}
