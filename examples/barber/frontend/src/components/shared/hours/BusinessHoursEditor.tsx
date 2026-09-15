"use client";

import { useT } from "@/hooks/useT";
import { cn } from "@/lib/cn";

export interface BusinessHourSlot {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
  breakStartTime?: string;
  breakEndTime?: string;
}

interface BusinessHoursEditorProps {
  value: BusinessHourSlot[];
  onChange: (slots: BusinessHourSlot[]) => void;
  disabled?: boolean;
}

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function ensureAllDays(slots: BusinessHourSlot[]): BusinessHourSlot[] {
  return DAY_KEYS.map((_, idx) => {
    const existing = slots.find((s) => s.dayOfWeek === idx);
    return (
      existing ?? {
        dayOfWeek: idx,
        openTime: "09:00",
        closeTime: "18:00",
        isClosed: false,
      }
    );
  });
}

export function BusinessHoursEditor({
  value,
  onChange,
  disabled,
}: BusinessHoursEditorProps) {
  const t = useT("hours");
  const allDays = ensureAllDays(value);

  function updateSlot(dayOfWeek: number, patch: Partial<BusinessHourSlot>) {
    const updated = allDays.map((slot) =>
      slot.dayOfWeek === dayOfWeek ? { ...slot, ...patch } : slot,
    );
    onChange(updated);
  }

  function toggleBreak(dayOfWeek: number) {
    const slot = allDays.find((s) => s.dayOfWeek === dayOfWeek)!;
    if (slot.breakStartTime !== undefined) {
      updateSlot(dayOfWeek, {
        breakStartTime: undefined,
        breakEndTime: undefined,
      });
    } else {
      updateSlot(dayOfWeek, {
        breakStartTime: "13:00",
        breakEndTime: "14:00",
      });
    }
  }

  return (
    <div className="space-y-3">
      {allDays.map((slot) => {
        const dayLabel = t(DAY_KEYS[slot.dayOfWeek]) || DAY_KEYS[slot.dayOfWeek];
        const hasBreak = slot.breakStartTime !== undefined;

        return (
          <div
            key={slot.dayOfWeek}
            className="bg-surface-container-low rounded-xl p-4 border border-outline-variant/10"
          >
            <div className="flex items-center gap-4 flex-wrap">
              <span className="w-32 text-sm font-medium text-on-surface capitalize shrink-0">
                {dayLabel}
              </span>

              <button
                type="button"
                role="switch"
                aria-checked={!slot.isClosed}
                disabled={disabled}
                onClick={() => updateSlot(slot.dayOfWeek, { isClosed: !slot.isClosed })}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 shrink-0",
                  !slot.isClosed ? "bg-primary" : "bg-surface-container-high",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-on-primary transition-transform shadow-sm",
                    !slot.isClosed ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </button>

              {!slot.isClosed && (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={slot.openTime}
                      disabled={disabled}
                      onChange={(e) =>
                        updateSlot(slot.dayOfWeek, { openTime: e.target.value })
                      }
                      className="bg-surface-container-high text-on-surface text-sm rounded-lg px-3 py-2 border border-outline-variant/10 focus:border-primary outline-none disabled:opacity-50"
                    />
                    <span className="text-on-surface-variant text-xs">—</span>
                    <input
                      type="time"
                      value={slot.closeTime}
                      disabled={disabled}
                      onChange={(e) =>
                        updateSlot(slot.dayOfWeek, { closeTime: e.target.value })
                      }
                      className="bg-surface-container-high text-on-surface text-sm rounded-lg px-3 py-2 border border-outline-variant/10 focus:border-primary outline-none disabled:opacity-50"
                    />
                  </div>

                  {!hasBreak && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleBreak(slot.dayOfWeek)}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                    >
                      Agregar descanso
                    </button>
                  )}
                </>
              )}

              {slot.isClosed && (
                <span className="text-sm text-on-surface-variant/50 italic">
                  Cerrado
                </span>
              )}
            </div>

            {!slot.isClosed && hasBreak && (
              <div className="flex items-center gap-2 mt-3 ml-36">
                <span className="text-xs text-on-surface-variant mr-1">
                  Descanso:
                </span>
                <input
                  type="time"
                  value={slot.breakStartTime ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateSlot(slot.dayOfWeek, { breakStartTime: e.target.value })
                  }
                  className="bg-surface-container-high text-on-surface text-sm rounded-lg px-3 py-2 border border-outline-variant/10 focus:border-primary outline-none disabled:opacity-50"
                />
                <span className="text-on-surface-variant text-xs">—</span>
                <input
                  type="time"
                  value={slot.breakEndTime ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateSlot(slot.dayOfWeek, { breakEndTime: e.target.value })
                  }
                  className="bg-surface-container-high text-on-surface text-sm rounded-lg px-3 py-2 border border-outline-variant/10 focus:border-primary outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleBreak(slot.dayOfWeek)}
                  className="text-xs text-error hover:text-error/80 transition-colors disabled:opacity-50 ml-1"
                >
                  Quitar
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
