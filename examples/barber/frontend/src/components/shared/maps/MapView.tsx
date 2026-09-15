"use client";

import dynamic from "next/dynamic";

const MapViewInner = dynamic(() => import("./MapViewInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[300px] w-full items-center justify-center rounded-2xl bg-surface-container-low">
      <span className="material-symbols-outlined animate-spin text-primary">progress_activity</span>
    </div>
  ),
});

interface MapMarker {
  lat: number;
  lng: number;
  label?: string;
  popupContent?: React.ReactNode;
}

interface MapViewProps {
  center: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  className?: string;
  style?: React.CSSProperties;
  onClick?: (lat: number, lng: number) => void;
}

export default function MapView(props: MapViewProps) {
  return <MapViewInner {...props} />;
}
