"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/lib/authContext";
import { useBarbershop } from "@/lib/barbershopContext";
import { useT } from "@/hooks/useT";
import { buttonVariants } from "@/components/shared/ui/Button";
import { cn } from "@/lib/cn";

type NavItem = {
  key: string;
  icon: string;
  href: string;
};

const navItems: NavItem[] = [
  { key: "dashboard", icon: "dashboard", href: "/dashboard" },
  { key: "bookings", icon: "calendar_month", href: "/dashboard/bookings" },
  { key: "services", icon: "content_cut", href: "/dashboard/services" },
  { key: "professionals", icon: "badge", href: "/dashboard/professionals" },
  { key: "bundles", icon: "inventory_2", href: "/dashboard/bundles" },
  { key: "reviews", icon: "reviews", href: "/dashboard/reviews" },
  { key: "settings", icon: "settings", href: "/dashboard/settings" },
];

export default function OwnerSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();
  const { barbershops, selectedBarbershop, setSelectedBarbershop } = useBarbershop();
  const t = useT("nav");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = () => {
    logout();
    router.push("/");
  };

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-[#131315] border-r border-surface-container-low flex flex-col py-8 px-5 z-50">
      <div className="mb-10 relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen((prev) => !prev)}
          className="w-full text-left group"
        >
          <h1 className="font-headline italic text-2xl text-primary tracking-tight flex items-center gap-2">
            <span className="truncate">{selectedBarbershop?.name ?? t("defaultShopName", "Mi Barbería")}</span>
            {barbershops.length > 1 && (
              <span className="material-symbols-outlined text-base text-on-surface-variant/60 group-hover:text-primary transition-colors">
                {dropdownOpen ? "expand_less" : "expand_more"}
              </span>
            )}
          </h1>
          <p className="text-xs uppercase tracking-widest text-on-surface-variant/60 mt-1">
            {t("managementSuite", "Management Suite")}
          </p>
        </button>

        {dropdownOpen && barbershops.length > 1 && (
          <div className="absolute left-0 top-full mt-2 w-full bg-[#1c1c1e] border border-surface-container-low rounded-xl shadow-2xl overflow-hidden z-50">
            {barbershops.map((shop) => (
              <button
                key={shop.id}
                onClick={() => {
                  setSelectedBarbershop(shop);
                  setDropdownOpen(false);
                }}
                className={cn(
                  "w-full text-left px-4 py-3 text-sm transition-colors",
                  shop.id === selectedBarbershop?.id
                    ? "text-primary bg-surface-container-low font-semibold"
                    : "text-on-surface/70 hover:text-on-surface hover:bg-surface-container-low/50",
                )}
              >
                {shop.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="flex-1 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname?.startsWith(item.href) ?? false;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 py-3 pl-3 text-sm transition-all duration-150",
                active
                  ? "text-primary font-bold border-l-2 border-primary bg-surface-container-low"
                  : "text-on-surface/60 border-l-2 border-transparent hover:text-on-surface hover:bg-surface-container-low",
              )}
            >
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              {t(item.key)}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3">
        <Link
          href="/dashboard/bookings/create"
          className={cn(
            buttonVariants({ variant: "gold", size: "form" }),
            "w-full justify-center font-semibold tracking-wide",
          )}
        >
          <span className="material-symbols-outlined text-xl">add</span>
          {t("newBooking")}
        </Link>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full py-2.5 px-3 text-sm text-on-surface-variant/60 hover:text-error hover:bg-error/5 rounded-lg transition-colors"
        >
          <span className="material-symbols-outlined text-xl">logout</span>
          {t("logout", "Cerrar sesión")}
        </button>
      </div>
    </aside>
  );
}
