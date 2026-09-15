'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useSimfinityClient } from '@/lib/simfinity';
import { useT } from '@/hooks/useT';
import { useBarbershop } from '@/lib/barbershopContext';
import { PageHeader, EmptyState } from '@/components/shared/page';
import { KpiCard, StatusChip } from '@/components/shared/data';
import { cn } from '@/lib/cn';
import {
  format,
  addDays,
  subDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isToday,
  getHours,
  getMinutes,
  parseISO,
  addMonths,
  subMonths,
} from 'date-fns';
import { es } from 'date-fns/locale';

type ViewMode = 'DAY' | 'WEEK' | 'MONTH';

interface Booking {
  id: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  totalPrice: number;
  state: string;
  confirmationCode: string;
  notes: string;
  client?: { id: string; name?: string; email?: string };
  professional?: { id: string; name?: string };
  lines?: { service?: { id: string; name?: string }; price?: number; durationMinutes?: number }[];
}

interface Professional {
  id: string;
  name: string;
  photoUrl?: string;
  bio?: string;
}

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8);

const STATUS_BORDER: Record<string, string> = {
  CONFIRMED: 'border-l-primary',
  COMPLETED: 'border-l-emerald-500',
  CANCELLED_BY_CLIENT: 'border-l-red-400',
  CANCELLED_BY_SHOP: 'border-l-red-400',
  NO_SHOW: 'border-l-amber-400',
};

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  CONFIRMED: { bg: 'bg-primary/10', text: 'text-primary' },
  COMPLETED: { bg: 'bg-emerald-400/10', text: 'text-emerald-400' },
  CANCELLED_BY_CLIENT: { bg: 'bg-red-400/10', text: 'text-red-400' },
  CANCELLED_BY_SHOP: { bg: 'bg-red-400/10', text: 'text-red-400' },
  NO_SHOW: { bg: 'bg-amber-400/10', text: 'text-amber-400' },
};

const STATUS_LABEL_KEY: Record<string, string> = {
  CONFIRMED: 'stateConfirmed',
  COMPLETED: 'stateCompleted',
  CANCELLED_BY_CLIENT: 'stateCancelled',
  CANCELLED_BY_SHOP: 'stateCancelled',
  NO_SHOW: 'stateNoShow',
};

function getServiceNames(b: Booking, t: (k: string, fb: string) => string): string {
  if (!b.lines?.length) return '—';
  return b.lines.map((l) => l.service?.name ?? t('fallbackService', 'Service')).join(', ');
}

function getClientName(b: Booking, t: (k: string, fb: string) => string): string {
  return b.client?.name || b.client?.email || t('fallbackClient', 'Client');
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

function getDuration(b: Booking): number {
  if (b.startTime && b.endTime) {
    return timeToMinutes(b.endTime) - timeToMinutes(b.startTime);
  }
  if (b.lines?.length) {
    return b.lines.reduce((s, l) => s + (l.durationMinutes ?? 30), 0);
  }
  return 60;
}

function ViewToggle({ selected, onChange }: { selected: ViewMode; onChange: (v: ViewMode) => void }) {
  const t = useT('bookings');
  const modes: { key: ViewMode; labelKey: string; fallback: string }[] = [
    { key: 'DAY', labelKey: 'viewDay', fallback: 'Day' },
    { key: 'WEEK', labelKey: 'viewWeek', fallback: 'Week' },
    { key: 'MONTH', labelKey: 'viewMonth', fallback: 'Month' },
  ];
  return (
    <div className="flex bg-surface-container-low/50 p-1.5 rounded-xl border border-outline-variant/10">
      {modes.map((m) => (
        <button
          key={m.key}
          onClick={() => onChange(m.key)}
          className={cn(
            'px-6 py-2 text-xs font-bold tracking-wider rounded-lg transition-all',
            selected === m.key
              ? 'bg-primary text-on-primary-container shadow-lg'
              : 'text-on-surface/60 hover:bg-surface-container-high',
          )}
        >
          {t(m.labelKey, m.fallback).toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DateNavigator({
  date,
  view,
  onPrev,
  onNext,
}: {
  date: Date;
  view: ViewMode;
  onPrev: () => void;
  onNext: () => void;
}) {
  let label: string;
  switch (view) {
    case 'DAY':
      label = format(date, "EEEE, d 'de' MMMM", { locale: es });
      break;
    case 'WEEK': {
      const ws = startOfWeek(date, { weekStartsOn: 1 });
      const we = endOfWeek(date, { weekStartsOn: 1 });
      label = `${format(ws, 'd MMM', { locale: es })} – ${format(we, 'd MMM yyyy', { locale: es })}`;
      break;
    }
    case 'MONTH':
      label = format(date, "MMMM 'de' yyyy", { locale: es });
      break;
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={onPrev} className="p-2 hover:bg-white/5 rounded-full transition-colors text-primary">
        <span className="material-symbols-outlined">chevron_left</span>
      </button>
      <span className="font-headline text-2xl font-light min-w-[240px] text-center capitalize">{label}</span>
      <button onClick={onNext} className="p-2 hover:bg-white/5 rounded-full transition-colors text-primary">
        <span className="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
  );
}

function BookingBlock({ booking, onClick }: { booking: Booking; onClick: () => void }) {
  const t = useT('bookings');
  const borderColor = STATUS_BORDER[booking.state] ?? 'border-l-outline-variant';
  const badge = STATUS_BADGE[booking.state] ?? STATUS_BADGE.CONFIRMED;
  const labelKey = STATUS_LABEL_KEY[booking.state] ?? 'stateConfirmed';
  const badgeLabel = t(labelKey, booking.state);
  const duration = getDuration(booking);

  return (
    <div
      onClick={onClick}
      className={cn(
        'h-full bg-surface-container-high rounded-lg p-3 border-l-4 shadow-lg hover:scale-[1.01] transition-transform cursor-pointer',
        borderColor,
      )}
    >
      <div className="flex justify-between items-start mb-1">
        <h4 className="font-medium text-sm text-on-surface truncate">{getClientName(booking, t)}</h4>
        <span
          className={cn(
            'text-[9px] px-2 py-0.5 rounded-full font-bold tracking-widest uppercase shrink-0',
            badge.bg,
            badge.text,
          )}
        >
          {badgeLabel}
        </span>
      </div>
      <p className="text-xs text-on-surface/50 truncate">{getServiceNames(booking, t)}</p>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-on-surface/30">
        <span className="material-symbols-outlined text-[14px]">timer</span>
        <span>{duration} min</span>
      </div>
    </div>
  );
}

function DayView({
  dayDate,
  bookings,
  professionals,
  onBookingClick,
}: {
  dayDate: Date;
  bookings: Booking[];
  professionals: Professional[];
  onBookingClick: (id: string) => void;
}) {
  const t = useT('bookings');
  const dayStr = format(dayDate, 'yyyy-MM-dd');
  const cols =
    professionals.length > 0
      ? [
          {
            id: '_unassigned',
            name: t('unassignedProfessional', 'Sin asignar'),
            photoUrl: undefined,
            bio: undefined,
          },
          ...professionals,
        ]
      : [{ id: '_all', name: t('allProfessionalsShort', 'All'), photoUrl: undefined, bio: undefined }];
  const colCount = cols.length;

  function getBookingsForCol(colId: string, hour: number): Booking[] {
    return bookings.filter((b) => {
      if (!b.scheduledDate?.startsWith(dayStr)) return false;
      if (!b.startTime) return false;
      const bookingHour = parseInt(b.startTime.split(':')[0], 10);
      if (bookingHour !== hour) return false;
      if (colId === '_all') return true;
      if (colId === '_unassigned') return !b.professional?.id;
      return b.professional?.id === colId;
    });
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-surface-container-low border border-outline-variant/10 shadow-2xl">
      <div
        className="grid border-b border-outline-variant/10 bg-surface-container-high/50"
        style={{ gridTemplateColumns: `100px repeat(${colCount}, 1fr)` }}
      >
        <div className="p-6 border-r border-outline-variant/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-on-surface/20">schedule</span>
        </div>
        {cols.map((pro) => (
          <div key={pro.id} className="p-6 flex flex-col items-center border-r border-outline-variant/10 last:border-r-0 group">
            <div className="relative mb-3">
              {pro.photoUrl ? (
                <Image
                  alt={pro.name}
                  className="w-14 h-14 rounded-full object-cover border-2 border-primary/20 grayscale group-hover:grayscale-0 transition-all duration-500"
                  src={pro.photoUrl}
                  width={56}
                  height={56}
                  unoptimized
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-surface-container-high border-2 border-primary/20 flex items-center justify-center text-primary font-bold text-lg">
                  {pro.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 border-2 border-surface-container-low rounded-full" />
            </div>
            <span className="font-headline text-xl text-primary-container">{pro.name}</span>
            {pro.bio && <span className="text-[10px] tracking-[0.2em] text-on-surface/40 uppercase">{pro.bio}</span>}
          </div>
        ))}
      </div>

      <div className="max-h-[700px] overflow-y-auto scrollbar-hide">
        <div className="flex flex-col">
          {HOURS.map((hour) => {
            const isCurrentHour = isToday(new Date()) && new Date().getHours() === hour;
            return (
              <div
                key={hour}
                className={cn(
                  'grid min-h-[100px] border-b border-outline-variant/5 relative',
                  isCurrentHour && 'bg-primary/5',
                )}
                style={{ gridTemplateColumns: `100px repeat(${colCount}, 1fr)` }}
              >
                <div
                  className={cn(
                    'flex items-center justify-center text-xs font-mono',
                    isCurrentHour ? 'text-primary font-bold' : 'text-on-surface/30',
                  )}
                >
                  {String(hour).padStart(2, '0')}:00
                </div>
                {cols.map((col) => {
                  const hourBookings = getBookingsForCol(col.id, hour);
                  return (
                    <div key={col.id} className="p-1.5 border-l border-outline-variant/5">
                      {hourBookings.map((b) => (
                        <div key={b.id} className="mb-1">
                          <BookingBlock booking={b} onClick={() => onBookingClick(b.id)} />
                        </div>
                      ))}
                    </div>
                  );
                })}
                {isCurrentHour && (
                  <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-primary/30 z-10 pointer-events-none">
                    <div className="absolute left-[100px] top-1/2 -translate-y-1/2 w-2 h-2 bg-primary rounded-full" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WeekView({
  date,
  bookings,
  onBookingClick,
  onDayClick,
}: {
  date: Date;
  bookings: Booking[];
  onBookingClick: (id: string) => void;
  onDayClick: (d: Date) => void;
}) {
  const t = useT('bookings');
  const weekStart = startOfWeek(date, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: addDays(weekStart, 6) });

  function bookingsForDay(d: Date): Booking[] {
    const dateStr = format(d, 'yyyy-MM-dd');
    return bookings.filter((b) => b.scheduledDate?.startsWith(dateStr));
  }

  return (
    <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 shadow-2xl overflow-hidden">
      <div className="grid grid-cols-7 bg-surface-container-high/50 border-b border-outline-variant/10">
        {days.map((d) => (
          <div
            key={d.toISOString()}
            onClick={() => onDayClick(d)}
            className={cn(
              'p-4 text-center border-r border-outline-variant/10 last:border-r-0 cursor-pointer hover:bg-surface-container-high/50 transition-colors',
              isToday(d) && 'bg-primary/5',
            )}
          >
            <p className="text-[10px] uppercase tracking-widest text-on-surface/40">
              {format(d, 'EEE', { locale: es })}
            </p>
            <p
              className={cn(
                'text-2xl font-headline mt-1',
                isToday(d) ? 'text-primary font-bold' : 'text-on-surface',
              )}
            >
              {format(d, 'd')}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 min-h-[500px]">
        {days.map((d) => {
          const dayBookings = bookingsForDay(d);
          return (
            <div
              key={d.toISOString()}
              className="border-r border-outline-variant/5 last:border-r-0 p-2 space-y-1.5"
            >
              {dayBookings.slice(0, 8).map((b) => (
                <div
                  key={b.id}
                  onClick={() => onBookingClick(b.id)}
                  className={cn(
                    'p-2 rounded-lg border-l-2 bg-surface-container-high/60 cursor-pointer hover:bg-surface-container-high transition-colors',
                    STATUS_BORDER[b.state] ?? 'border-l-primary',
                  )}
                >
                  <p className="text-[11px] font-medium text-on-surface truncate">{getClientName(b, t)}</p>
                  <p className="text-[10px] text-on-surface/40">{b.startTime ?? ''}</p>
                </div>
              ))}
              {dayBookings.length > 8 && (
                <p className="text-[10px] text-primary text-center font-bold">
                  {t('moreCount', '+{n} more').replace('{n}', String(dayBookings.length - 8))}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthView({
  date,
  bookings,
  onDayClick,
}: {
  date: Date;
  bookings: Booking[];
  onDayClick: (d: Date) => void;
}) {
  const t = useT('bookings');
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const allDays = eachDayOfInterval({ start: calStart, end: calEnd });

  const dayNames = [
    t('weekdayMon', 'Mon'),
    t('weekdayTue', 'Tue'),
    t('weekdayWed', 'Wed'),
    t('weekdayThu', 'Thu'),
    t('weekdayFri', 'Fri'),
    t('weekdaySat', 'Sat'),
    t('weekdaySun', 'Sun'),
  ];

  function countForDay(d: Date): number {
    const dateStr = format(d, 'yyyy-MM-dd');
    return bookings.filter((b) => b.scheduledDate?.startsWith(dateStr)).length;
  }

  const inMonth = (d: Date) => d.getMonth() === date.getMonth();

  return (
    <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 shadow-2xl overflow-hidden">
      <div className="grid grid-cols-7 bg-surface-container-high/50 border-b border-outline-variant/10">
        {dayNames.map((name) => (
          <div key={name} className="p-3 text-center text-[10px] uppercase tracking-widest text-on-surface/40 font-bold">
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {allDays.map((d) => {
          const count = countForDay(d);
          const today = isToday(d);
          return (
            <div
              key={d.toISOString()}
              onClick={() => onDayClick(d)}
              className={cn(
                'min-h-[100px] p-3 border-b border-r border-outline-variant/5 cursor-pointer hover:bg-surface-container-high/30 transition-colors',
                !inMonth(d) && 'opacity-30',
                today && 'bg-primary/5',
              )}
            >
              <p
                className={cn(
                  'text-sm',
                  today ? 'text-primary font-bold' : 'text-on-surface/60',
                )}
              >
                {format(d, 'd')}
              </p>
              {count > 0 && (
                <div className="mt-2 flex items-center gap-1">
                  <span className="inline-block w-5 h-5 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center">
                    {count}
                  </span>
                  <span className="text-[10px] text-on-surface/40">{t('appointmentsShort', 'bookings')}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BookingsCalendarPage() {
  const t = useT('bookings');
  const router = useRouter();
  const client = useSimfinityClient();
  const { selectedBarbershop } = useBarbershop();

  const [view, setView] = useState<ViewMode>('DAY');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterProId, setFilterProId] = useState<string>('');

  const dateRange = useMemo(() => {
    switch (view) {
      case 'DAY':
        return { from: format(currentDate, 'yyyy-MM-dd'), to: format(currentDate, 'yyyy-MM-dd') };
      case 'WEEK': {
        const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
        const we = endOfWeek(currentDate, { weekStartsOn: 1 });
        return { from: format(ws, 'yyyy-MM-dd'), to: format(we, 'yyyy-MM-dd') };
      }
      case 'MONTH': {
        const ms = startOfMonth(currentDate);
        const me = endOfMonth(currentDate);
        const calS = startOfWeek(ms, { weekStartsOn: 1 });
        const calE = endOfWeek(me, { weekStartsOn: 1 });
        return { from: format(calS, 'yyyy-MM-dd'), to: format(calE, 'yyyy-MM-dd') };
      }
    }
  }, [view, currentDate]);

  const fetchData = useCallback(async () => {
    if (!selectedBarbershop?.id) return;
    setLoading(true);
    try {
      let query = client
        .find('booking')
        .fields('id scheduledDate startTime endTime totalPrice state confirmationCode notes client { id name email } professional { id name } lines { service { id name } price durationMinutes }')
        .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
        .where('scheduledDate', 'GTE', dateRange.from)
        .where('scheduledDate', 'LTE', dateRange.to)
        .sort('startTime', 'ASC');

      if (filterProId) {
        query = query.where('professional', [{ path: 'id', operator: 'EQ', value: filterProId }]);
      }

      const [result, pros] = await Promise.all([
        query.exec(),
        client.find('professional')
          .fields('id name photoUrl bio')
          .where('barbershop', [{ path: 'id', operator: 'EQ', value: selectedBarbershop.id }])
          .exec(),
      ]);

      setBookings(Array.isArray(result) ? (result as Booking[]) : []);
      setProfessionals(Array.isArray(pros) ? (pros as Professional[]) : []);
    } catch {
      setBookings([]);
      setProfessionals([]);
    } finally {
      setLoading(false);
    }
  }, [client, dateRange, filterProId, selectedBarbershop?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredBookings = useMemo(() => {
    if (!search.trim()) return bookings;
    const q = search.toLowerCase();
    return bookings.filter(
      (b) =>
        getClientName(b, t).toLowerCase().includes(q) ||
        getServiceNames(b, t).toLowerCase().includes(q) ||
        b.confirmationCode?.toLowerCase().includes(q),
    );
  }, [bookings, search, t]);

  const navigatePrev = () => {
    switch (view) {
      case 'DAY':
        setCurrentDate((d) => subDays(d, 1));
        break;
      case 'WEEK':
        setCurrentDate((d) => subDays(d, 7));
        break;
      case 'MONTH':
        setCurrentDate((d) => subMonths(d, 1));
        break;
    }
  };

  const navigateNext = () => {
    switch (view) {
      case 'DAY':
        setCurrentDate((d) => addDays(d, 1));
        break;
      case 'WEEK':
        setCurrentDate((d) => addDays(d, 7));
        break;
      case 'MONTH':
        setCurrentDate((d) => addMonths(d, 1));
        break;
    }
  };

  const handleBookingClick = (id: string) => {
    router.push(`/dashboard/bookings/${id}/view`);
  };

  const handleDayClick = (d: Date) => {
    setCurrentDate(d);
    setView('DAY');
  };

  const totalBookings = filteredBookings.length;
  const confirmedCount = filteredBookings.filter((b) => b.state === 'CONFIRMED').length;
  const estimatedRevenue = filteredBookings.reduce((s, b) => s + (b.totalPrice ?? 0), 0);
  const occupancy = professionals.length > 0 && HOURS.length > 0
    ? Math.round((totalBookings / (professionals.length * HOURS.length)) * 100)
    : 0;

  return (
    <div className="max-w-full space-y-10">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-end gap-6">
        <div className="max-w-2xl">
          <h1 className="font-headline text-5xl md:text-6xl text-on-surface tracking-tight leading-none mb-4">
            {t('title', 'Gestión de Turnos')}
          </h1>
          <p className="text-on-surface/50 text-sm uppercase tracking-[0.2em]">
            {t('subtitle', 'Agenda')} / {format(currentDate, 'MMMM yyyy', { locale: es })}
          </p>
        </div>
        <ViewToggle selected={view} onChange={setView} />
      </div>

      {/* Filters & Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-6 bg-surface-container-low/50 p-4 rounded-xl border border-outline-variant/10">
        <DateNavigator date={currentDate} view={view} onPrev={navigatePrev} onNext={navigateNext} />

        <div className="flex items-center gap-4 flex-grow md:flex-grow-0">
          <div className="relative min-w-[250px]">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface/40">search</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface-container-high border-none rounded-lg py-2.5 pl-10 pr-4 text-sm focus:ring-1 focus:ring-primary/40 text-on-surface placeholder-on-surface/30"
              placeholder={t('searchClient', 'Buscar cliente...')}
            />
          </div>

          {professionals.length > 0 && (
            <select
              value={filterProId}
              onChange={(e) => setFilterProId(e.target.value)}
              className="bg-surface-container-high border border-outline-variant/20 rounded-lg px-4 py-2.5 text-xs uppercase tracking-widest font-semibold text-on-surface appearance-none cursor-pointer hover:border-primary/30 transition-all"
            >
              <option value="">{t('allProfessionals', 'Todos los Profesionales')}</option>
              {professionals.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Calendar Content */}
      {loading ? (
        <div className="flex items-center justify-center py-32">
          <span className="material-symbols-outlined text-primary text-4xl animate-spin">progress_activity</span>
        </div>
      ) : (
        <>
          {view === 'DAY' && (
            <DayView
              dayDate={currentDate}
              bookings={filteredBookings}
              professionals={professionals}
              onBookingClick={handleBookingClick}
            />
          )}
          {view === 'WEEK' && (
            <WeekView date={currentDate} bookings={filteredBookings} onBookingClick={handleBookingClick} onDayClick={handleDayClick} />
          )}
          {view === 'MONTH' && (
            <MonthView date={currentDate} bookings={filteredBookings} onDayClick={handleDayClick} />
          )}
        </>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <KpiCard
          label={t('kpiTotal', 'Turnos Totales')}
          value={String(totalBookings)}
          icon="group_work"
        />
        <KpiCard
          label={t('kpiOccupancy', 'Ocupación')}
          value={`${Math.min(occupancy, 100)}%`}
          icon="star_rate"
        />
        <KpiCard
          label={t('kpiRevenue', 'Ingresos Est.')}
          value={`$${estimatedRevenue.toLocaleString('es-AR')}`}
          icon="payments"
        />
      </div>
    </div>
  );
}
