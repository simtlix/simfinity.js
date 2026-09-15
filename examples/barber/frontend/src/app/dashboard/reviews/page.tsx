'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { usePagination } from '@/hooks/usePagination';
import { useBarbershop } from '@/lib/barbershopContext';
import { PageHeader, PaginationBar, StarRating } from '@/components/shared';
import { Button } from '@/components/shared/ui';
import { cn } from '@/lib/cn';

type Review = {
  id: string;
  rating: number;
  comment: string;
  reply: string;
  isReported: boolean;
  client: { id: string; name: string } | null;
  createdAt: string;
};

function formatRelativeDate(dateStr: string, t: (k: string, fb: string) => string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return t('today', 'Hoy');
  if (days === 1) return t('oneDayAgo', 'Hace 1 día');
  if (days < 7) return t('daysAgo', `Hace ${days} días`).replace('{n}', String(days));
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? t('oneWeekAgo', 'Hace 1 semana') : t('weeksAgo', `Hace ${weeks} semanas`).replace('{n}', String(weeks));
  }
  const months = Math.floor(days / 30);
  return months === 1 ? t('oneMonthAgo', 'Hace 1 mes') : t('monthsAgo', `Hace ${months} meses`).replace('{n}', String(months));
}

function ReviewCard({
  review,
  onReply,
  onReport,
}: {
  review: Review;
  onReply: (id: string, text: string) => Promise<void>;
  onReport: (id: string) => void;
}) {
  const t = useT('reviews');
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState(review.reply ?? '');
  const [sending, setSending] = useState(false);

  async function handleSendReply() {
    if (!replyText.trim()) return;
    setSending(true);
    try {
      await onReply(review.id, replyText.trim());
      setReplyOpen(false);
    } catch (e) {
      console.error('Failed to send reply', e);
    } finally {
      setSending(false);
    }
  }

  const clientName = review.client?.name ?? t('anonymous', 'Cliente anónimo');
  const initials = clientName
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="bg-surface-container-low rounded-xl p-8 border border-white/5 group hover:bg-[#1B1B1D] transition-all duration-300">
      <div className="flex items-start justify-between mb-6">
        <div className="flex gap-5">
          <div className="w-14 h-14 rounded-full bg-surface-container-high border border-primary/20 flex items-center justify-center flex-shrink-0">
            <span className="text-primary text-sm font-bold">{initials}</span>
          </div>
          <div>
            <h4 className="font-headline text-xl text-on-surface">{clientName}</h4>
            <div className="flex items-center gap-3 mt-1">
              <StarRating rating={review.rating} size="sm" />
              <span className="text-[10px] text-on-surface/40 uppercase tracking-widest">
                {formatRelativeDate(review.createdAt, t)}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => onReport(review.id)}
          className={cn(
            'transition-all',
            review.isReported
              ? 'text-error/60'
              : 'text-on-surface/20 hover:text-error',
          )}
          title={t('report', 'Reportar')}
        >
          <span className="material-symbols-outlined">flag</span>
        </button>
      </div>

      {review.comment && (
        <p className="text-on-surface/80 text-lg leading-relaxed mb-6 italic">
          &ldquo;{review.comment}&rdquo;
        </p>
      )}

      {review.reply && !replyOpen && (
        <div className="bg-surface-container-high/40 p-5 rounded-lg mb-6 border-l-2 border-primary/40 ml-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-primary uppercase tracking-widest">
              {t('ownerReply', 'Tu respuesta')}
            </span>
          </div>
          <p className="text-sm text-on-surface/70 leading-relaxed italic">
            &ldquo;{review.reply}&rdquo;
          </p>
        </div>
      )}

      <div className="flex justify-end gap-4 items-center">
        {review.reply && !replyOpen ? (
          <button
            onClick={() => { setReplyOpen(true); setReplyText(review.reply); }}
            className="flex items-center gap-2 text-on-surface/60 text-xs font-bold uppercase tracking-widest hover:text-primary transition-all"
          >
            <span className="material-symbols-outlined text-sm">edit</span>
            {t('editReply', 'Editar respuesta')}
          </button>
        ) : !replyOpen ? (
          <button
            onClick={() => setReplyOpen(true)}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg border border-primary/30 text-primary text-xs font-bold uppercase tracking-widest hover:bg-primary/10 transition-all"
          >
            <span className="material-symbols-outlined text-sm">reply</span>
            {t('reply', 'Responder')}
          </button>
        ) : null}
      </div>

      {replyOpen && (
        <div className="mt-4 space-y-3">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            rows={3}
            placeholder={t('replyPlaceholder', 'Escribe tu respuesta...')}
            className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg p-4 text-sm text-on-surface placeholder:text-on-surface/30 resize-none focus:outline-none focus:border-primary/40"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setReplyOpen(false)}
              className="text-on-surface/60 text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors px-4 py-2"
            >
              {t('cancel', 'Cancelar')}
            </button>
            <Button
              type="button"
              variant="gold"
              size="sm"
              onClick={handleSendReply}
              disabled={sending || !replyText.trim()}
              className="rounded-lg px-6 py-2.5 text-on-primary normal-case"
            >
              {sending ? t('sending', 'Enviando...') : t('send', 'Enviar')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const client = useSimfinityClient();
  const t = useT('reviews');
  const { page, pageSize, setPage } = usePagination(10);
  const { selectedBarbershop } = useBarbershop();

  const [reviews, setReviews] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'UNREPLIED' | '5STAR'>('ALL');

  const fetchReviews = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      let query = client
        .find('review')
        .fields('id rating comment reply isReported client { id name } createdAt')
        .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
        .page(page, pageSize);

      if (search.trim()) {
        query = query.where('comment', 'CONTAINS', search.trim());
      }
      if (filter === '5STAR') {
        query = query.where('rating', 'EQ', 5);
      } else if (filter === 'UNREPLIED') {
        query = query.where('reply', 'EQ', null);
      }

      const result = await query.exec();
      const items = Array.isArray(result) ? result : [];
      setReviews(items as Review[]);
      setTotal(items.length < pageSize && page === 1 ? items.length : items.length + (page - 1) * pageSize + 1);
    } catch {
      setReviews([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [client, page, pageSize, search, filter, selectedBarbershop?.id]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  async function handleReply(id: string, text: string) {
    try {
      await client.update('review', id, { reply: text });
      setReviews((prev) =>
        prev.map((r) => (r.id === id ? { ...r, reply: text } : r)),
      );
    } catch {
      /* silently fail */
    }
  }

  function handleReport(id: string) {
    client.update('review', id, { isReported: true }).catch(() => {});
    setReviews((prev) =>
      prev.map((r) => (r.id === id ? { ...r, isReported: true } : r)),
    );
  }

  const filterButtons: { key: typeof filter; label: string }[] = [
    { key: 'ALL', label: t('all', 'Todas') },
    { key: '5STAR', label: t('fiveStar', '5 Estrellas') },
    { key: 'UNREPLIED', label: t('unreplied', 'Sin Responder') },
  ];

  return (
    <>
      <PageHeader
        title={t('title', 'Gestión de Reseñas')}
        subtitle={t('subtitle', 'Administra el feedback y la satisfacción de tus clientes.')}
      />

      <div className="flex flex-wrap items-center justify-between gap-4 mb-8 bg-surface-container-high/50 backdrop-blur-sm p-4 rounded-xl">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative max-w-sm w-full">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/40 text-sm">
              search
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder={t('searchPlaceholder', 'Buscar por cliente o comentario...')}
              className="w-full bg-surface-container-low border-none rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-1 focus:ring-primary text-on-surface placeholder:text-on-surface/30"
            />
          </div>

          <div className="h-6 w-px bg-white/10" />

          <div className="flex gap-2">
            {filterButtons.map((fb) => (
              <button
                key={fb.key}
                onClick={() => { setFilter(fb.key); setPage(1); }}
                className={cn(
                  'px-4 py-1.5 rounded-full text-[10px] font-bold tracking-wider uppercase transition-all',
                  filter === fb.key
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container-low border border-white/5 text-on-surface/60 hover:text-primary',
                )}
              >
                {fb.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <span className="material-symbols-outlined text-primary text-3xl animate-spin">
            progress_activity
          </span>
        </div>
      ) : reviews.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant text-3xl">reviews</span>
          </div>
          <h3 className="font-headline italic text-xl text-on-surface mt-6">
            {t('empty', 'No hay reseñas aún')}
          </h3>
          <p className="text-on-surface-variant text-sm mt-2">
            {t('emptyMessage', 'Las reseñas de tus clientes aparecerán aquí.')}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              onReply={handleReply}
              onReport={handleReport}
            />
          ))}
        </div>
      )}

      <div className="mt-8">
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
        />
      </div>
    </>
  );
}
