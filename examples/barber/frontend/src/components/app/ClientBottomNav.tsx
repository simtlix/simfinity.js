"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const items = [
  { label: "Inicio", href: "/", icon: "home" },
  { label: "Turnos", href: "/bookings", icon: "event_available" },
  { label: "Favoritos", href: "/favorites", icon: "bookmark" },
  { label: "Perfil", href: "/profile", icon: "person" },
];

export default function ClientBottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 flex h-20 items-center justify-around border-t border-on-surface/5 bg-surface-container-low/90 px-2 backdrop-blur-md md:hidden"
      aria-label="Navegación principal"
    >
      {items.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href) ?? false;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-col items-center gap-0.5 no-underline",
              active ? "text-primary" : "text-on-surface/60",
            )}
          >
            <span
              className="material-symbols-outlined text-2xl"
              style={{
                fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0, 'wght' 300",
              }}
            >
              {item.icon}
            </span>
            <span className="font-label text-[0.625rem] font-bold uppercase tracking-tight">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
