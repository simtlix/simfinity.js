"use client";

import * as React from "react";
import AppHeader from "@/components/app/AppHeader";
import ClientBottomNav from "@/components/app/ClientBottomNav";

export default function MarketingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col pb-24 md:pb-0">
      <AppHeader />
      <div className="h-20 shrink-0" aria-hidden />
      <main className="min-h-0 flex-1 w-full">{children}</main>
      <ClientBottomNav />
    </div>
  );
}
