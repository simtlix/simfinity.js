"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";
import { useT } from "@/hooks/useT";
import { buttonVariants } from "@/components/shared/ui/Button";
import { cn } from "@/lib/cn";

type NavItem = {
  key: string;
  icon: string;
  href: string;
};

const navItems: NavItem[] = [
  { key: "dashboard", icon: "dashboard", href: "/admin" },
  { key: "barbershops", icon: "storefront", href: "/admin/barbershops" },
  { key: "users", icon: "group", href: "/admin/users" },
  { key: "reportedReviews", icon: "report_problem", href: "/admin/reviews" },
];

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();
  const t = useT("nav");

  const handleLogout = () => {
    logout();
    router.push("/");
  };

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-[#131315] border-r border-surface-container-low flex flex-col py-8 px-5 z-50">
      <div className="mb-10">
        <h1 className="font-headline italic text-2xl text-primary tracking-tight">
          The Groomed
        </h1>
        <p className="text-xs uppercase tracking-widest text-on-surface-variant/60 mt-1">
          Global Administration
        </p>
      </div>

      <nav className="flex-1 flex flex-col gap-0.5 px-1">
        {navItems.map((item) => {
          const active =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname?.startsWith(item.href) ?? false;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 py-3 px-3 text-sm transition-all duration-150",
                active
                  ? "text-primary font-bold bg-surface-container-high rounded-lg"
                  : "text-on-surface/60 hover:text-on-surface hover:bg-surface-container-low rounded-lg",
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
          href="/admin/barbershops/create"
          className={cn(
            buttonVariants({ variant: "gold", size: "form" }),
            "w-full justify-center font-semibold tracking-wide",
          )}
        >
          <span className="material-symbols-outlined text-xl">add</span>
          {t("newBarbershop")}
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
