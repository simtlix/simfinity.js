"use client";

import { cn } from "@/lib/cn";

interface TimeSlot {
  time: string;
  available: boolean;
}

interface TimeSlotGridProps {
  slots: TimeSlot[];
  selectedTime: string | null;
  onSelect: (time: string) => void;
}

export function TimeSlotGrid({ slots, selectedTime, onSelect }: TimeSlotGridProps) {
  return (
    <div className="grid grid-cols-4 sm:grid-cols-5 gap-3">
      {slots.map((slot) => {
        const isSelected = slot.time === selectedTime;

        if (!slot.available) {
          return (
            <div
              key={slot.time}
              className="px-4 py-3 rounded-xl text-sm text-center bg-surface-container-low/50 text-on-surface-variant/30 cursor-not-allowed line-through"
            >
              {slot.time}
            </div>
          );
        }

        return (
          <button
            key={slot.time}
            type="button"
            onClick={() => onSelect(slot.time)}
            className={cn(
              "px-4 py-3 rounded-xl text-sm text-center cursor-pointer transition-all",
              isSelected
                ? "bg-primary text-on-primary"
                : "bg-surface-container-low border border-outline-variant/10 hover:border-primary/30 text-on-surface",
            )}
          >
            {slot.time}
          </button>
        );
      })}
    </div>
  );
}
