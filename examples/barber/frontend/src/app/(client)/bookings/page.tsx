"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSimfinityClient } from "@/lib/simfinity";
import { RequireAuth } from "@/lib/requireAuth";
import { useAuth } from "@/lib/authContext";
import { useT } from "@/hooks/useT";
import { usePagination } from "@/hooks/usePagination";
import { BookingCard } from "@/components/shared/booking";
import { PaginationBar } from "@/components/shared/data";
import { EmptyState } from "@/components/shared/page";
import { ConfirmModal } from "@/components/shared/modals";
import { cn } from "@/lib/cn";

const UPCOMING_STATES = new Set(["CONFIRMED"]);
const PAST_STATES = new Set([
  "COMPLETED",
  "CANCELLED_BY_CLIENT",
  "CANCELLED_BY_SHOP",
  "NO_SHOW",
]);

type BookingLine = {
  service?: { id: string; name?: string };
  bundle?: { id: string; name?: string };
  price?: number;
};

type BookingData = {
  id: string;
  confirmationCode?: string;
  scheduledDate?: string;
  startTime?: string;
  endTime?: string;
  totalPrice?: number;
  state?: string;
  barbershop?: { id: string; name?: string };
  professional?: { id: string; name?: string };
  lines?: BookingLine[];
};

function getServiceName(booking: BookingData): string {
  if (!booking.lines?.length) return "—";
  const names = booking.lines
    .map((l) => l.service?.name || l.bundle?.name)
    .filter(Boolean);
  return names.join(" + ") || "—";
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function BookingsContent() {
  const router = useRouter();
  const client = useSimfinityClient();
  const { user } = useAuth();
  const t = useT("booking");
  const pagination = usePagination(10);

  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");
  const [bookings, setBookings] = useState<BookingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState<BookingData | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await client
          .find("booking")
          .fields(
            "id confirmationCode scheduledDate startTime endTime totalPrice state barbershop { id name } professional { id name } lines { service { id name } bundle { id name } price durationMinutes }",
          )
          .where("client", [{ path: "id", operator: "EQ", value: user.id }])
          .exec();
        if (!cancelled) setBookings(result as BookingData[]);
      } catch {
        if (!cancelled) setBookings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, user?.id]);

  const upcoming = useMemo(
    () =>
      bookings
        .filter((b) => UPCOMING_STATES.has(b.state ?? ""))
        .sort(
          (a, b) =>
            (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""),
        ),
    [bookings],
  );

  const past = useMemo(
    () =>
      bookings
        .filter((b) => PAST_STATES.has(b.state ?? ""))
        .sort(
          (a, b) =>
            (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""),
        ),
    [bookings],
  );

  const list = tab === "upcoming" ? upcoming : past;
  const paged = list.slice(pagination.offset, pagination.offset + pagination.pageSize);

  const handleCancel = useCallback(
    async (booking: BookingData) => {
      try {
        await client.transition(
          "booking",
          "cancelbyclient",
          booking.id,
          {},
          "id state",
        );
        setBookings((prev) =>
          prev.map((b) =>
            b.id === booking.id
              ? { ...b, state: "CANCELLED_BY_CLIENT" }
              : b,
          ),
        );
      } catch {
        /* silent */
      } finally {
        setCancelTarget(null);
      }
    },
    [client],
  );

  const tabs = [
    { id: "upcoming" as const, label: t("upcoming", "Próximos") },
    { id: "past" as const, label: t("past", "Pasados") },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 lg:px-12 py-8">
      <h1 className="font-headline italic text-4xl lg:text-5xl text-on-surface mb-2 leading-tight">
        {t("myBookings", "Mis Turnos")}
      </h1>
      <p className="text-on-surface-variant text-sm mb-8">
        {t(
          "bookingsSubtitle",
          "Gestiona tus próximas citas y revisa tu historial de servicios.",
        )}
      </p>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-container-low rounded-xl p-1 mb-8">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id);
              pagination.reset();
            }}
            className={cn(
              "flex-1 py-2.5 text-sm font-semibold uppercase tracking-wider rounded-lg transition-colors",
              tab === item.id
                ? "bg-primary text-on-primary"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {paged.length === 0 ? (
        <EmptyState
          icon={tab === "upcoming" ? "event" : "history"}
          title={
            tab === "upcoming"
              ? t("noUpcoming", "No tenés turnos próximos")
              : t("noPast", "No hay turnos pasados")
          }
          message={
            tab === "upcoming"
              ? t(
                  "noUpcomingMessage",
                  "¿Listo para un nuevo look? Reservá tu turno ahora.",
                )
              : undefined
          }
          actionLabel={
            tab === "upcoming"
              ? t("explore", "Explorar Barberías")
              : undefined
          }
          onAction={
            tab === "upcoming" ? () => router.push("/search") : undefined
          }
        />
      ) : (
        <>
          <div className="space-y-4 mb-6">
            {paged.map((booking) => (
              <BookingCard
                key={booking.id}
                confirmationCode={booking.confirmationCode ?? booking.id.slice(0, 6)}
                barbershopName={booking.barbershop?.name ?? "—"}
                serviceName={getServiceName(booking)}
                professionalName={booking.professional?.name}
                date={formatDate(booking.scheduledDate)}
                time={
                  booking.startTime
                    ? `${booking.startTime}${booking.endTime ? ` — ${booking.endTime}` : ""}`
                    : "—"
                }
                status={booking.state ?? "PENDING"}
                onCancel={
                  tab === "upcoming"
                    ? () => setCancelTarget(booking)
                    : undefined
                }
                onReschedule={
                  tab === "upcoming"
                    ? () => router.push(`/book?barbershop=${booking.barbershop?.id ?? ""}&reschedule=${booking.id}&step=date`)
                    : undefined
                }
              />
            ))}
          </div>

          {list.length > pagination.pageSize && (
            <PaginationBar
              page={pagination.page}
              pageSize={pagination.pageSize}
              total={list.length}
              onPageChange={pagination.setPage}
            />
          )}
        </>
      )}

      <ConfirmModal
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => cancelTarget && handleCancel(cancelTarget)}
        title={t("cancelBooking", "Cancelar Turno")}
        message={t(
          "cancelConfirmation",
          "¿Estás seguro que querés cancelar este turno? Esta acción no se puede deshacer.",
        )}
        confirmLabel={t("confirmCancel", "Sí, cancelar")}
        cancelLabel={t("keep", "Mantener")}
        variant="danger"
      />
    </div>
  );
}

export default function BookingsPage() {
  return (
    <RequireAuth role="CLIENT">
      <BookingsContent />
    </RequireAuth>
  );
}
