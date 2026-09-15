"use client";

import { useState, useMemo } from "react";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  addMonths,
  subMonths,
  isSameDay,
  isSameMonth,
  isBefore,
  startOfDay,
  getDay,
} from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/cn";

interface CalendarPickerProps {
  selectedDate: Date | null;
  onSelect: (date: Date) => void;
  minDate?: Date;
  availableDates?: Date[];
}

const WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

export function CalendarPicker({
  selectedDate,
  onSelect,
  minDate,
  availableDates,
}: CalendarPickerProps) {
  const [viewMonth, setViewMonth] = useState(
    selectedDate ?? minDate ?? new Date(),
  );

  const today = useMemo(() => startOfDay(new Date()), []);

  const days = useMemo(() => {
    const start = startOfMonth(viewMonth);
    const end = endOfMonth(viewMonth);
    return eachDayOfInterval({ start, end });
  }, [viewMonth]);

  const startOffset = useMemo(() => {
    const dow = getDay(startOfMonth(viewMonth));
    return dow === 0 ? 6 : dow - 1;
  }, [viewMonth]);

  function isAvailable(date: Date) {
    if (minDate && isBefore(date, startOfDay(minDate))) return false;
    if (availableDates) {
      return availableDates.some((d) => isSameDay(d, date));
    }
    return true;
  }

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={() => setViewMonth((m) => subMonths(m, 1))}
          className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-on-surface-variant">
            chevron_left
          </span>
        </button>
        <span className="font-semibold text-on-surface capitalize">
          {format(viewMonth, "MMMM yyyy", { locale: es })}
        </span>
        <button
          type="button"
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-on-surface-variant">
            chevron_right
          </span>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center mb-2">
        {WEEKDAYS.map((d) => (
          <span key={d} className="text-xs text-on-surface-variant font-medium">
            {d}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`pad-${i}`} />
        ))}

        {days.map((day) => {
          const isToday = isSameDay(day, today);
          const isSelected = selectedDate && isSameDay(day, selectedDate);
          const available = isAvailable(day);
          const inMonth = isSameMonth(day, viewMonth);

          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={!available}
              onClick={() => available && onSelect(day)}
              className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center text-sm transition-colors",
                isSelected
                  ? "bg-primary text-on-primary"
                  : isToday
                    ? "border border-primary text-on-surface"
                    : available && inMonth
                      ? "hover:bg-surface-container-high cursor-pointer text-on-surface"
                      : "text-on-surface-variant/30 cursor-not-allowed",
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
