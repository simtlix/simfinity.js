"use client";

import Image from "next/image";
import { cn } from "@/lib/cn";

interface ProfessionalSelectionCardProps {
  name: string;
  bio?: string;
  photoUrl?: string;
  specialty?: string;
  selected: boolean;
  onToggle: () => void;
}

function Initials({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="w-full aspect-square bg-surface-container-high flex items-center justify-center rounded-xl">
      <span className="text-on-surface-variant font-semibold text-3xl tracking-wider">
        {initials}
      </span>
    </div>
  );
}

export function ProfessionalSelectionCard({
  name,
  photoUrl,
  specialty,
  selected,
  onToggle,
}: ProfessionalSelectionCardProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex flex-col items-center text-center cursor-pointer transition-all"
    >
      <div
        className={cn(
          "relative w-full aspect-square rounded-xl overflow-hidden border-2 transition-all",
          selected
            ? "border-primary shadow-[0_0_20px_rgba(230,196,135,0.15)]"
            : "border-transparent hover:border-primary/30",
        )}
      >
        {photoUrl ? (
          <Image
            src={photoUrl}
            alt={name}
            fill
            className="object-cover"
            unoptimized
          />
        ) : (
          <Initials name={name} />
        )}

        {selected && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
            <span className="px-3 py-1 bg-primary text-on-primary text-[9px] font-bold uppercase tracking-[0.2em] rounded-full whitespace-nowrap">
              Seleccionado
            </span>
          </div>
        )}
      </div>

      <p className="mt-3 font-headline italic text-lg text-on-surface">
        {name}
      </p>
      {specialty && (
        <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60 font-medium">
          {specialty}
        </p>
      )}
    </button>
  );
}
