"use client";

import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/cn";

L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const goldIcon = new L.DivIcon({
  className: "",
  html: `<div style="
    width: 24px; height: 24px;
    background: #e6c487;
    border: 2px solid #1c1a16;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    box-shadow: 0 2px 6px rgba(0,0,0,.4);
  "></div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24],
});

interface MapMarker {
  lat: number;
  lng: number;
  label?: string;
  popupContent?: React.ReactNode;
}

interface MapViewInnerProps {
  center: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  className?: string;
  style?: React.CSSProperties;
  onClick?: (lat: number, lng: number) => void;
}

function ClickHandler({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function MapViewInner({
  center,
  zoom = 13,
  markers = [],
  className = "",
  style,
  onClick,
}: MapViewInnerProps) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className={cn("h-full w-full rounded-2xl", className)}
      style={{ minHeight: 200, ...style }}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />

      <ClickHandler onClick={onClick} />

      {markers.map((m, i) => (
        <Marker key={i} position={[m.lat, m.lng]} icon={goldIcon}>
          {(m.label || m.popupContent) && (
            <Popup className="dark-popup">
              {m.popupContent ?? <span className="text-sm font-medium">{m.label}</span>}
            </Popup>
          )}
        </Marker>
      ))}
    </MapContainer>
  );
}
