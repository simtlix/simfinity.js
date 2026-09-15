"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSimfinityClient } from "@/lib/simfinity";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { RequireAuth } from "@/lib/requireAuth";
import { useT } from "@/hooks/useT";
import { computeAvailableSlots } from "@/lib/slotUtils";
import {
  StepIndicator,
  ServiceSelectionCard,
  CalendarPicker,
  ProfessionalSelectionCard,
  TimeSlotGrid,
  BookingReviewStep,
  BookingConfirmationStep,
} from "@/components/shared/booking";
import { Button } from "@/components/shared/ui";
import { cn } from "@/lib/cn";

type StepId = "services" | "date" | "professional" | "time" | "review" | "confirmation";

const STEP_IDS: StepId[] = [
  "services",
  "date",
  "professional",
  "time",
  "review",
  "confirmation",
];

const STEP_ICONS: Record<StepId, string> = {
  services: "content_cut",
  date: "calendar_today",
  professional: "badge",
  time: "schedule",
  review: "verified",
  confirmation: "check_circle",
};

type ServiceData = {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  category?: string;
};

type BundleData = {
  id: string;
  name: string;
  description?: string;
  price: number;
  totalDurationMinutes: number;
  services?: { service?: { id: string; name: string } }[];
};

type ProfessionalData = {
  id: string;
  name: string;
  bio?: string;
  photoUrl?: string;
  specialty?: string;
};

type BusinessHour = {
  dayOfWeek?: number;
  openTime?: string;
  closeTime?: string;
  isClosed?: boolean;
};

type BarbershopData = {
  id: string;
  name: string;
  slug: string;
  slotDurationMinutes?: number;
  businessHours?: BusinessHour[];
};

const NO_PREFERENCE_ID = "__any__";

function BookingFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const client = useSimfinityClient();
  const t = useT("booking");

  const barbershopId = searchParams.get("barbershop") ?? "";
  const rescheduleId = searchParams.get("reschedule");
  const bundleParam = searchParams.get("bundle");
  const stepParam = (searchParams.get("step") as StepId) || "services";
  const currentStep = STEP_IDS.includes(stepParam) ? stepParam : "services";
  const currentIdx = STEP_IDS.indexOf(currentStep);

  const [barbershop, setBarbershop] = useState<BarbershopData | null>(null);
  const [services, setServices] = useState<ServiceData[]>([]);
  const [bundles, setBundles] = useState<BundleData[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedProfessionalId, setSelectedProfessionalId] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [availableSlots, setAvailableSlots] = useState<{ time: string; available: boolean }[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  useEffect(() => {
    if (!barbershopId) return;
    let cancelled = false;

    (async () => {
      try {
        const shop = (await client.getById(
          "barbershop",
          barbershopId,
          "id name slug slotDurationMinutes businessHours { dayOfWeek openTime closeTime isClosed } services { id name description durationMinutes price category { name } } bundles { id name description price totalDurationMinutes services { service { id name } } } professionals { id name bio photoUrl isActive }",
        )) as Record<string, unknown> | null;

        if (cancelled) return;
        if (shop) {
          setBarbershop(shop as unknown as BarbershopData);
          const rawServices = (shop.services ?? []) as Record<string, unknown>[];
          const mappedServices = rawServices.map((s) => ({
            id: String(s.id),
            name: String(s.name ?? ""),
            description: s.description ? String(s.description) : undefined,
            duration: Number(s.durationMinutes ?? 0),
            price: Number(s.price ?? 0),
            category: (s.category as Record<string, unknown>)?.name
              ? String((s.category as Record<string, unknown>).name)
              : undefined,
          }));
          setServices(mappedServices);

          const rawBundles = (shop.bundles ?? []) as Record<string, unknown>[];
          const mappedBundles: BundleData[] = rawBundles.map((b) => ({
            id: String(b.id),
            name: String(b.name ?? ""),
            description: b.description ? String(b.description) : undefined,
            price: Number(b.price ?? 0),
            totalDurationMinutes: Number(b.totalDurationMinutes ?? 0),
            services: ((b.services ?? []) as Record<string, unknown>[]).map((bs) => {
              const svc = bs.service as Record<string, unknown> | null;
              return {
                service: svc ? { id: String(svc.id), name: String(svc.name ?? "") } : undefined,
              };
            }),
          }));
          setBundles(mappedBundles);

          setProfessionals(
            ((shop.professionals ?? []) as Record<string, unknown>[])
              .filter((p) => p.isActive !== false)
              .map((p) => ({
                id: String(p.id),
                name: String(p.name ?? ""),
                bio: p.bio ? String(p.bio) : undefined,
                photoUrl: p.photoUrl ? String(p.photoUrl) : undefined,
              })),
          );

          if (bundleParam && !cancelled) {
            setSelectedBundleId(bundleParam);
            const autoBundle = mappedBundles.find((b) => b.id === bundleParam);
            if (autoBundle) {
              const svcIds = new Set(
                (autoBundle.services ?? [])
                  .map((s) => s.service?.id)
                  .filter((id): id is string => id != null),
              );
              setSelectedServiceIds(svcIds);
            }
          }

          if (rescheduleId) {
            try {
              const booking = (await client.getById(
                "booking",
                rescheduleId,
                "id lines { service { id } price durationMinutes } professional { id }",
              )) as Record<string, unknown> | null;

              if (!cancelled && booking) {
                const lines = (booking.lines ?? []) as Record<string, unknown>[];
                const serviceIds = new Set(
                  lines
                    .map((l) => {
                      const svc = l.service as Record<string, unknown> | null;
                      return svc?.id ? String(svc.id) : null;
                    })
                    .filter((id): id is string => id !== null),
                );
                setSelectedServiceIds(serviceIds);

                const pro = booking.professional as Record<string, unknown> | null;
                if (pro?.id) setSelectedProfessionalId(String(pro.id));
              }
            } catch {
              /* booking data unavailable */
            }
          }
        }
      } catch {
        /* data unavailable */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, barbershopId, bundleParam, rescheduleId]);

  useEffect(() => {
    if (!barbershop?.id || !selectedDate) {
      setAvailableSlots([]);
      return;
    }
    let cancelled = false;
    const dateStr = format(selectedDate, "yyyy-MM-dd");

    (async () => {
      setSlotsLoading(true);
      try {
        const bookings = (await client
          .find("booking")
          .where("barbershop", [{ path: "id", operator: "EQ", value: barbershop.id }])
          .where("scheduledDate", "EQ", dateStr)
          .where("state", "EQ", "CONFIRMED")
          .fields("startTime endTime")
          .exec()) as { startTime?: string; endTime?: string }[];

        if (cancelled) return;
        const slots = computeAvailableSlots(
          barbershop.businessHours ?? [],
          barbershop.slotDurationMinutes ?? 30,
          dateStr,
          bookings,
        );
        setAvailableSlots(slots);
      } catch {
        if (!cancelled) setAvailableSlots([]);
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, barbershop, selectedDate]);

  const steps = useMemo(
    () =>
      STEP_IDS.filter((id) => id !== "confirmation").map((id) => ({
        id,
        label: t("flow.step." + id, id.charAt(0).toUpperCase() + id.slice(1)),
      })),
    [t],
  );

  const setStep = useCallback(
    (step: StepId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("step", step);
      router.push(`/book?${params.toString()}`);
    },
    [router, searchParams],
  );

  const goNext = useCallback(() => {
    if (currentIdx < STEP_IDS.length - 1) {
      setStep(STEP_IDS[currentIdx + 1]);
    }
  }, [currentIdx, setStep]);

  const goBack = useCallback(() => {
    if (currentIdx > 0) {
      setStep(STEP_IDS[currentIdx - 1]);
    } else {
      router.back();
    }
  }, [currentIdx, setStep, router]);

  const toggleService = useCallback((id: string) => {
    if (selectedBundleId) setSelectedBundleId(null);
    setSelectedServiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [selectedBundleId]);

  const toggleBundle = useCallback(
    (bundleId: string) => {
      if (selectedBundleId === bundleId) {
        setSelectedBundleId(null);
        setSelectedServiceIds(new Set());
      } else {
        const bundle = bundles.find((b) => b.id === bundleId);
        if (bundle) {
          setSelectedBundleId(bundleId);
          const svcIds = new Set(
            (bundle.services ?? [])
              .map((s) => s.service?.id)
              .filter((id): id is string => id != null),
          );
          setSelectedServiceIds(svcIds);
        }
      }
    },
    [bundles, selectedBundleId],
  );

  const selectedServices = useMemo(
    () => services.filter((s) => selectedServiceIds.has(s.id)),
    [services, selectedServiceIds],
  );

  const selectedBundle = useMemo(
    () => bundles.find((b) => b.id === selectedBundleId),
    [bundles, selectedBundleId],
  );

  const totalPrice = useMemo(
    () =>
      selectedBundle
        ? selectedBundle.price
        : selectedServices.reduce((sum, s) => sum + s.price, 0),
    [selectedBundle, selectedServices],
  );

  const totalDuration = useMemo(
    () =>
      selectedBundle
        ? selectedBundle.totalDurationMinutes
        : selectedServices.reduce((sum, s) => sum + s.duration, 0),
    [selectedBundle, selectedServices],
  );

  const selectedProfessional = useMemo(
    () => professionals.find((p) => p.id === selectedProfessionalId),
    [professionals, selectedProfessionalId],
  );

  const canContinue = useMemo(() => {
    switch (currentStep) {
      case "services":
        return selectedServiceIds.size > 0 || selectedBundleId !== null;
      case "date":
        return selectedDate !== null;
      case "professional":
        return selectedProfessionalId !== null;
      case "time":
        return selectedTime !== null;
      case "review":
        return true;
      case "confirmation":
        return true;
      default:
        return false;
    }
  }, [currentStep, selectedServiceIds.size, selectedBundleId, selectedDate, selectedProfessionalId, selectedTime]);

  const handleConfirm = useCallback(async () => {
    if (!barbershop || !selectedDate || !selectedTime) return;
    setSubmitting(true);
    try {
      if (rescheduleId) {
        try {
          await client.transition("booking", "cancelbyclient", rescheduleId, {}, "id");
        } catch {
          /* old booking may already be cancelled */
        }
      }

      const proId = selectedProfessionalId === NO_PREFERENCE_ID ? undefined : selectedProfessionalId;

      const lines =
        selectedBundle
          ? [
              {
                bundle: { id: selectedBundle.id },
                price: selectedBundle.price,
                durationMinutes: selectedBundle.totalDurationMinutes,
              },
            ]
          : selectedServices.map((s) => ({
              service: { id: s.id },
              price: s.price,
              durationMinutes: s.duration,
            }));

      const payload: Record<string, unknown> = {
        barbershop: { id: barbershop.id },
        scheduledDate: format(selectedDate, "yyyy-MM-dd"),
        startTime: selectedTime,
        lines,
      };
      if (proId) payload.professional = { id: proId };
      if (notes.trim()) payload.notes = notes.trim();

      const result = (await client.add("booking", payload, "id confirmationCode")) as {
        id?: string;
        confirmationCode?: string;
      } | null;

      setConfirmationCode(result?.confirmationCode ?? "—");
      setStep("confirmation");
    } catch {
      setSubmitting(false);
    }
  }, [barbershop, client, notes, rescheduleId, selectedBundle, selectedDate, selectedProfessionalId, selectedServices, selectedTime, setStep]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const isConfirmed = currentStep === "confirmation";
  const sidebarSteps = STEP_IDS.filter((id) => id !== "confirmation");

  return (
    <div className="flex min-h-[calc(100vh-5rem)]">
      {/* Sidebar stepper — desktop */}
      {!isConfirmed && (
        <aside className="hidden lg:flex w-72 flex-col border-r border-outline-variant/10 bg-background pt-8 pb-12 fixed left-0 top-20 bottom-0 z-10">
          <div className="px-8 mb-12">
            <h2 className="font-label uppercase tracking-[0.1rem] text-[0.7rem] text-primary/60">
              {t("reservation", "RESERVACIÓN")}
            </h2>
            <p className="font-label uppercase tracking-[0.05rem] text-[0.6rem] text-on-surface/30">
              {t("stepOf", "Paso")} {Math.min(currentIdx + 1, sidebarSteps.length)} {t("of", "de")} {sidebarSteps.length}
            </p>
          </div>

          <nav className="flex flex-col space-y-6">
            {sidebarSteps.map((id, idx) => {
              const isActive = id === currentStep;
              const isCompleted = idx < currentIdx;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { if (isCompleted) setStep(id); }}
                  className={cn(
                    "flex items-center gap-4 pl-8 transition-all text-left",
                    isActive
                      ? "text-primary border-l-2 border-primary"
                      : isCompleted
                        ? "text-on-surface/60 hover:text-on-surface cursor-pointer"
                        : "text-on-surface/30 cursor-default",
                  )}
                >
                  <span
                    className="material-symbols-outlined text-xl"
                    style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                  >
                    {STEP_ICONS[id]}
                  </span>
                  <span className="font-label uppercase tracking-[0.15rem] text-[0.7rem]">
                    {t("flow.step." + id, id)}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>
      )}

      {/* Main content */}
      <main
        className={cn(
          "flex-1 flex flex-col items-center",
          !isConfirmed && "lg:ml-72",
        )}
      >
        {/* Mobile step header */}
        {!isConfirmed && (
          <div className="lg:hidden px-6 py-4 bg-background border-b border-outline-variant/10 w-full max-w-4xl">
            <div className="flex justify-between items-center mb-4">
              <button
                type="button"
                onClick={goBack}
                className="flex items-center gap-1 text-on-surface/60 hover:text-on-surface transition-colors"
              >
                <span className="material-symbols-outlined text-lg">arrow_back</span>
              </button>
              <div className="text-right">
                <span className="block text-[10px] uppercase tracking-widest text-on-surface/40 font-medium">
                  {t("stepOf", "Paso")} {Math.min(currentIdx + 1, sidebarSteps.length)}/{sidebarSteps.length}
                </span>
                <span className="block text-[10px] uppercase tracking-widest text-primary font-bold">
                  {t("flow.step." + currentStep, currentStep)}
                </span>
              </div>
            </div>
            <StepIndicator steps={steps} currentStep={currentStep} />
          </div>
        )}

        {/* Barbershop name header */}
        {barbershop && !isConfirmed && (
          <div className="px-8 lg:px-16 pt-8 lg:pt-12 w-full max-w-4xl">
            <button
              type="button"
              onClick={goBack}
              className="hidden lg:flex items-center gap-2 text-on-surface/40 hover:text-on-surface text-sm transition-colors mb-8"
            >
              <span className="material-symbols-outlined text-lg">arrow_back</span>
              {t("back", "Volver")}
            </button>
            <p className="text-[10px] uppercase tracking-[0.2em] text-primary/60 font-medium mb-1">
              {barbershop.name}
            </p>
          </div>
        )}

        {/* Step content */}
        <div className="flex-1 px-8 lg:px-16 py-8 overflow-y-auto w-full max-w-4xl">
          {currentStep === "services" && (
            <StepServices
              services={services}
              bundles={bundles}
              selectedIds={selectedServiceIds}
              selectedBundleId={selectedBundleId}
              onToggle={toggleService}
              onToggleBundle={toggleBundle}
              totalPrice={totalPrice}
              totalDuration={totalDuration}
              selectedCount={selectedServiceIds.size}
              t={t}
            />
          )}

          {currentStep === "date" && (
            <StepDate selectedDate={selectedDate} onSelect={setSelectedDate} t={t} />
          )}

          {currentStep === "professional" && (
            <StepProfessional
              professionals={professionals}
              selectedId={selectedProfessionalId}
              onSelect={setSelectedProfessionalId}
              t={t}
            />
          )}

          {currentStep === "time" && (
            <StepTime
              slots={availableSlots}
              slotsLoading={slotsLoading}
              selectedTime={selectedTime}
              onSelect={setSelectedTime}
              t={t}
            />
          )}

          {currentStep === "review" && (
            <BookingReviewStep
              barbershopName={barbershop?.name ?? ""}
              services={selectedServices}
              professional={
                selectedProfessionalId === NO_PREFERENCE_ID
                  ? t("noPreference", "Sin preferencia")
                  : selectedProfessional?.name
              }
              date={
                selectedDate
                  ? format(selectedDate, "EEEE d 'de' MMMM, yyyy", { locale: es })
                  : undefined
              }
              time={selectedTime ?? undefined}
              totalPrice={totalPrice}
              notes={notes}
              onNotesChange={setNotes}
            />
          )}

          {currentStep === "confirmation" && (
            <BookingConfirmationStep
              confirmationCode={confirmationCode}
              barbershopName={barbershop?.name ?? ""}
              onViewBookings={() => router.push("/bookings")}
            />
          )}
        </div>

        {/* Bottom bar */}
        {!isConfirmed && (
          <div className="sticky bottom-0 px-8 lg:px-16 py-6 bg-background/90 backdrop-blur-xl border-t border-outline-variant/10 w-full max-w-4xl">
            <div className="flex items-center justify-between">
              {currentIdx > 0 && (
                <button
                  type="button"
                  onClick={goBack}
                  className="flex items-center gap-2 px-6 py-3 text-on-surface/60 hover:text-on-surface transition-colors"
                >
                  <span className="material-symbols-outlined text-lg">arrow_back</span>
                  <span className="font-label uppercase tracking-[0.2em] text-[11px]">
                    {t("back", "Volver")}
                  </span>
                </button>
              )}

              <div className="ml-auto">
                {currentStep === "review" ? (
                  <Button
                    type="button"
                    variant="gold"
                    size="lg"
                    disabled={submitting}
                    onClick={handleConfirm}
                    className="gap-4 text-on-primary font-label tracking-[0.3em]"
                  >
                    {submitting ? (
                      <span className="w-5 h-5 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        {t("confirm", "Confirmar Reserva")}
                        <span className="material-symbols-outlined text-lg">check_circle</span>
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="gold"
                    size="lg"
                    disabled={!canContinue}
                    onClick={goNext}
                    className="gap-4 text-on-primary font-label tracking-[0.3em]"
                  >
                    {t("continue", "Continuar")}
                    <span className="material-symbols-outlined text-lg">arrow_forward</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------- Step 1: Services ---------- */

function StepServices({
  services,
  bundles,
  selectedIds,
  selectedBundleId,
  onToggle,
  onToggleBundle,
  totalPrice,
  totalDuration,
  selectedCount,
  t,
}: {
  services: ServiceData[];
  bundles: BundleData[];
  selectedIds: Set<string>;
  selectedBundleId: string | null;
  onToggle: (id: string) => void;
  onToggleBundle: (id: string) => void;
  totalPrice: number;
  totalDuration: number;
  selectedCount: number;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <>
      <div className="mb-12">
        <h1 className="font-headline text-5xl lg:text-7xl text-on-surface mb-4 leading-none">
          {t("flow.selectServices", "Elija sus Servicios")}
        </h1>
        <div className="flex items-center gap-4">
          <div className="h-px w-12 bg-primary" />
          <span className="font-label uppercase tracking-[0.3em] text-[10px] text-primary">
            {t("curationExcellence", "Curación de Excelencia")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-12">
        {services.map((service) => (
          <ServiceSelectionCard
            key={service.id}
            name={service.name}
            description={service.description}
            duration={service.duration}
            price={service.price}
            category={service.category}
            selected={selectedIds.has(service.id)}
            onToggle={() => onToggle(service.id)}
          />
        ))}
      </div>

      {bundles.length > 0 && (
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-6">
            <div className="h-px w-12 bg-primary" />
            <span className="font-label uppercase tracking-[0.3em] text-[10px] text-primary">
              {t("flow.bundles", "Paquetes")}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bundles.map((bundle) => {
              const isSelected = selectedBundleId === bundle.id;
              return (
                <button
                  key={bundle.id}
                  type="button"
                  onClick={() => onToggleBundle(bundle.id)}
                  className={cn(
                    "text-left p-6 rounded-xl border transition-all",
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-outline-variant/10 bg-surface-container-low hover:border-primary/30",
                  )}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-label text-sm font-semibold text-on-surface">
                      {bundle.name}
                    </h3>
                    <div
                      className={cn(
                        "w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ml-3",
                        isSelected ? "border-primary bg-primary" : "border-on-surface/20",
                      )}
                    >
                      {isSelected && (
                        <span className="material-symbols-outlined text-on-primary text-xs">check</span>
                      )}
                    </div>
                  </div>
                  {bundle.description && (
                    <p className="text-xs text-on-surface/50 mb-3">{bundle.description}</p>
                  )}
                  <div className="flex items-baseline gap-3 mb-3">
                    <span className="text-xl font-headline italic text-on-surface">
                      ${bundle.price.toLocaleString("es-AR")}
                    </span>
                    <span className="text-on-surface/30">/</span>
                    <span className="text-xs uppercase tracking-widest text-on-surface/50">
                      {bundle.totalDurationMinutes} min
                    </span>
                  </div>
                  {bundle.services && bundle.services.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.15em] text-on-surface/30 mb-2">
                        {t("flow.bundleIncludes", "Incluye")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {bundle.services.map((bs) =>
                          bs.service ? (
                            <span
                              key={bs.service.id}
                              className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium"
                            >
                              {bs.service.name}
                            </span>
                          ) : null,
                        )}
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(selectedCount > 0 || selectedBundleId) && (
        <div className="bg-surface-container-high/30 p-6 border-l-2 border-primary/50 max-w-lg">
          <p className="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface/40 mb-2">
            {t("estimatedSummary", "RESUMEN ESTIMADO")}
          </p>
          <div className="flex items-baseline gap-4">
            <p className="text-3xl font-headline italic text-on-surface">
              ${totalPrice.toLocaleString("es-AR")}
            </p>
            <span className="text-on-surface/30">/</span>
            <p className="text-sm uppercase tracking-widest text-on-surface/60">
              {totalDuration} min
            </p>
          </div>
          {!selectedBundleId && selectedCount > 0 && (
            <p className="text-sm text-on-surface/60 mt-2">
              {selectedCount}{" "}
              {selectedCount === 1
                ? t("serviceSelected", "servicio seleccionado")
                : t("servicesSelected", "servicios seleccionados")}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- Step 2: Date ---------- */

function StepDate({
  selectedDate,
  onSelect,
  t,
}: {
  selectedDate: Date | null;
  onSelect: (d: Date) => void;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <>
      <div className="mb-12">
        <h1 className="font-headline text-5xl lg:text-7xl text-on-surface mb-4 leading-none">
          {t("flow.selectDate", "Elija la Fecha")}
        </h1>
        <div className="flex items-center gap-4">
          <div className="h-px w-12 bg-primary" />
          <span className="font-label uppercase tracking-[0.3em] text-[10px] text-primary">
            {t("findYourDay", "Encuentre su día")}
          </span>
        </div>
      </div>

      <div className="max-w-md">
        <CalendarPicker selectedDate={selectedDate} onSelect={onSelect} minDate={new Date()} />
      </div>

      {selectedDate && (
        <div className="mt-8 bg-surface-container-high/30 p-6 border-l-2 border-primary/50 max-w-md">
          <p className="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface/40 mb-1">
            {t("selectedDate", "FECHA SELECCIONADA")}
          </p>
          <p className="text-lg text-on-surface capitalize">
            {format(selectedDate, "EEEE d 'de' MMMM, yyyy", { locale: es })}
          </p>
        </div>
      )}
    </>
  );
}

/* ---------- Step 3: Professional ---------- */

function StepProfessional({
  professionals,
  selectedId,
  onSelect,
  t,
}: {
  professionals: ProfessionalData[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  t: (key: string, fallback?: string) => string;
}) {
  const selectedPro = professionals.find((p) => p.id === selectedId);

  return (
    <>
      <div className="mb-12">
        <h1 className="font-headline text-5xl lg:text-7xl text-on-surface mb-4 leading-none italic">
          {t("flow.selectProfessional", "Seleccione su Barbero")}
        </h1>
        <div className="flex items-center gap-4">
          <div className="h-px w-12 bg-primary" />
          <span className="font-label uppercase tracking-[0.3em] text-[10px] text-primary">
            {t("masterBarbers", "Maestros Barberos")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 max-w-3xl">
        {/* No preference card */}
        <button
          type="button"
          onClick={() => onSelect(NO_PREFERENCE_ID)}
          className="group flex flex-col items-center text-center cursor-pointer transition-all"
        >
          <div
            className={cn(
              "relative w-full aspect-square rounded-xl overflow-hidden border-2 transition-all flex items-center justify-center bg-surface-container-low",
              selectedId === NO_PREFERENCE_ID
                ? "border-primary shadow-[0_0_20px_rgba(230,196,135,0.15)]"
                : "border-transparent hover:border-primary/30",
            )}
          >
            <span
              className="material-symbols-outlined text-primary/60 text-5xl"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              casino
            </span>
            {selectedId === NO_PREFERENCE_ID && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
                <span className="px-3 py-1 bg-primary text-on-primary text-[9px] font-bold uppercase tracking-[0.2em] rounded-full whitespace-nowrap">
                  Seleccionado
                </span>
              </div>
            )}
          </div>
          <p className="mt-3 font-headline italic text-lg text-on-surface">
            {t("noPreference", "Sin Preferencia")}
          </p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60 font-medium">
            {t("randomAssignment", "Asignación aleatoria")}
          </p>
        </button>

        {/* Professional cards */}
        {professionals.map((pro) => (
          <ProfessionalSelectionCard
            key={pro.id}
            name={pro.name}
            bio={pro.bio}
            photoUrl={pro.photoUrl}
            specialty={pro.specialty}
            selected={pro.id === selectedId}
            onToggle={() => onSelect(pro.id)}
          />
        ))}
      </div>

      {/* Bio panel for selected professional */}
      {selectedPro?.bio && (
        <div className="mt-10 max-w-2xl bg-surface-container-low rounded-2xl border border-outline-variant/10 p-8 border-l-2 border-l-primary">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h3 className="font-headline italic text-xl text-on-surface mb-3">
                {t("about", "Sobre")} {selectedPro.name}
              </h3>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {selectedPro.bio}
              </p>
            </div>
            <span className="material-symbols-outlined text-primary/20 text-4xl shrink-0">
              content_cut
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Step 4: Time ---------- */

function StepTime({
  slots,
  slotsLoading,
  selectedTime,
  onSelect,
  t,
}: {
  slots: { time: string; available: boolean }[];
  slotsLoading: boolean;
  selectedTime: string | null;
  onSelect: (t: string) => void;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <>
      <div className="mb-12">
        <h1 className="font-headline text-5xl lg:text-7xl text-on-surface mb-4 leading-none">
          {t("flow.selectTime", "Elija el Horario")}
        </h1>
        <div className="flex items-center gap-4">
          <div className="h-px w-12 bg-primary" />
          <span className="font-label uppercase tracking-[0.3em] text-[10px] text-primary">
            {t("availableSlots", "Horarios Disponibles")}
          </span>
        </div>
      </div>

      <div className="max-w-2xl">
        {slotsLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : slots.length === 0 ? (
          <p className="text-on-surface/50 text-sm">
            {t("noSlotsAvailable", "No hay horarios disponibles para esta fecha.")}
          </p>
        ) : (
          <TimeSlotGrid slots={slots} selectedTime={selectedTime} onSelect={onSelect} />
        )}
      </div>
    </>
  );
}

/* ---------- Page export ---------- */

export default function BookPage() {
  return (
    <RequireAuth role="CLIENT">
      <BookingFlow />
    </RequireAuth>
  );
}
