"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/cn";

type AppHeaderProps = {
  onMenuClick?: () => void;
};

const clientNavItems = [
  { key: "home", href: "/" },
  { key: "search", href: "/search" },
  { key: "myBookings", href: "/bookings" },
];

export default function AppHeader({ onMenuClick }: AppHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const t = useT("nav");
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    router.push("/");
  };

  return (
    <header className="fixed top-0 z-40 flex h-20 w-full items-center border-b-0 bg-background/70 backdrop-blur-xl">
      <div className="flex w-full items-center justify-between px-4 md:px-8">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="mr-1 text-on-surface md:hidden"
            aria-label="Abrir menú"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}

        <Link
          href="/"
          className="font-headline text-2xl font-bold italic tracking-tight text-primary no-underline"
        >
          The Groomed
        </Link>

        <nav
          className="absolute left-1/2 hidden -translate-x-1/2 gap-8 md:flex"
          aria-label="Secciones"
        >
          {clientNavItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname?.startsWith(item.href) ?? false;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative py-2 font-headline text-base italic no-underline transition-colors",
                  active ? "text-on-surface" : "text-on-surface/60 hover:text-on-surface",
                )}
              >
                {t(item.key)}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-sm bg-primary" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          {user && (
            <button
              type="button"
              className="text-on-surface/70 p-1"
              aria-label="Notificaciones"
            >
              <span className="material-symbols-outlined text-[22px]">notifications</span>
            </button>
          )}

          {user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className="h-9 w-9 cursor-pointer overflow-hidden rounded-full border border-primary/20 bg-surface-container-high transition-colors hover:border-primary/40"
                aria-expanded={menuOpen}
                aria-haspopup="true"
                aria-label="Menú de cuenta"
              />
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[1300]"
                    onClick={() => setMenuOpen(false)}
                    aria-hidden
                  />
                  <div className="absolute right-0 top-full z-[1400] mt-2 min-w-[200px] overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-high shadow-2xl">
                    <div className="border-b border-outline-variant/10 px-4 py-3">
                      <p className="text-sm font-medium text-on-surface">
                        {user.name ?? user.email}
                      </p>
                      <p className="text-xs text-on-surface-variant/60">{user.email}</p>
                    </div>
                    {user.role === "OWNER" && (
                      <Link
                        href="/dashboard"
                        onClick={() => setMenuOpen(false)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-sm text-on-surface transition-colors hover:bg-surface-container"
                      >
                        <span className="material-symbols-outlined text-lg">dashboard</span>
                        {t("dashboard", "Dashboard")}
                      </Link>
                    )}
                    {user.role === "PLATFORM_ADMIN" && (
                      <Link
                        href="/admin"
                        onClick={() => setMenuOpen(false)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-sm text-on-surface transition-colors hover:bg-surface-container"
                      >
                        <span className="material-symbols-outlined text-lg">
                          admin_panel_settings
                        </span>
                        {t("adminPanel", "Administración")}
                      </Link>
                    )}
                    <Link
                      href="/profile"
                      onClick={() => setMenuOpen(false)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-sm text-on-surface transition-colors hover:bg-surface-container"
                    >
                      <span className="material-symbols-outlined text-lg">person</span>
                      {t("profile", "Mi perfil")}
                    </Link>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-error transition-colors hover:bg-error/10"
                    >
                      <span className="material-symbols-outlined text-lg">logout</span>
                      {t("logout", "Cerrar sesión")}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link
              href="/auth/login"
              className="font-body text-sm font-semibold text-primary no-underline hover:underline"
            >
              {t("login", "Ingresar")}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
