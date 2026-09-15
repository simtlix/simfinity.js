"use client";

import { useCallback } from "react";
import { useT } from "@/hooks/useT";
import { MapView } from "@/components/shared/maps";
import { cn } from "@/lib/cn";

const DEFAULT_CENTER: [number, number] = [-34.6037, -58.3816];

interface LocationPickerProps {
  value: [number, number] | null;
  onChange: (lat: number, lng: number) => void;
  zoom?: number;
  className?: string;
}

export default function LocationPicker({
  value,
  onChange,
  zoom = 14,
  className = "",
}: LocationPickerProps) {
  const t = useT("common");

  const handleClick = useCallback(
    (lat: number, lng: number) => {
      onChange(lat, lng);
    },
    [onChange],
  );

  const center = value ?? DEFAULT_CENTER;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="relative rounded-xl overflow-hidden border border-outline-variant/10 h-[300px]">
        <MapView
          center={center}
          zoom={zoom}
          markers={
            value
              ? [{ lat: value[0], lng: value[1] }]
              : []
          }
          onClick={handleClick}
          className="w-full h-full"
        />
        {!value && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="bg-surface/80 backdrop-blur-sm text-on-surface/70 text-sm font-medium px-4 py-2 rounded-lg">
              {t("clickMapToSelect", "Hacé clic en el mapa para seleccionar la ubicación")}
            </span>
          </div>
        )}
      </div>

      {value && (
        <div className="flex gap-6 text-sm text-on-surface/60">
          <span>
            <span className="font-semibold text-on-surface/80">
              {t("latitude", "Latitud")}:
            </span>{" "}
            {value[0].toFixed(6)}
          </span>
          <span>
            <span className="font-semibold text-on-surface/80">
              {t("longitude", "Longitud")}:
            </span>{" "}
            {value[1].toFixed(6)}
          </span>
        </div>
      )}
    </div>
  );
}
