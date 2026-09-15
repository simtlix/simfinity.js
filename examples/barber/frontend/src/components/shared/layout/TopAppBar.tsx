"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";
import { useT } from "@/hooks/useT";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

function formatTodayDate(): string {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

export default function TopAppBar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const t = useT("topBar");
  const todayDate = formatTodayDate();
  const firstName = user?.name?.split(" ")[0] ?? "";
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    router.push("/");
  };

  return (
    <header className="sticky top-0 z-40 bg-[#131315]/80 backdrop-blur-xl flex justify-between items-center px-12 py-6">
      <div>
        <p className="text-xs uppercase tracking-widest text-primary">
          {todayDate}
        </p>
        <h2 className="text-on-surface text-lg font-medium mt-1">
          {t(getGreeting())}, {firstName}
        </h2>
      </div>

      <div className="flex items-center gap-6">
        <button className="relative text-on-surface/70 hover:text-on-surface transition-colors">
          <span className="material-symbols-outlined text-2xl">notifications</span>
          <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-primary" />
        </button>

        <div className="relative border-l border-outline-variant pl-6">
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <div className="w-9 h-9 rounded-full bg-surface-container-high border border-outline-variant/30 overflow-hidden" />
            <span className="text-sm text-on-surface font-medium">
              {user?.name ?? ""}
            </span>
            <span className="material-symbols-outlined text-on-surface-variant text-lg">
              expand_more
            </span>
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full mt-2 z-50 min-w-[200px] bg-surface-container-high rounded-xl border border-outline-variant/20 shadow-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-outline-variant/10">
                  <p className="text-sm font-medium text-on-surface">{user?.name}</p>
                  <p className="text-xs text-on-surface-variant/60">{user?.email}</p>
                </div>
                <Link
                  href="/profile"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-3 w-full px-4 py-3 text-sm text-on-surface hover:bg-surface-container transition-colors"
                >
                  <span className="material-symbols-outlined text-lg">person</span>
                  {t("profile", "Mi perfil")}
                </Link>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-3 w-full px-4 py-3 text-sm text-error hover:bg-error/10 transition-colors"
                >
                  <span className="material-symbols-outlined text-lg">logout</span>
                  {t("logout", "Cerrar sesión")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
