"use client";

import OwnerSidebar from "./OwnerSidebar";
import TopAppBar from "./TopAppBar";

export default function OwnerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <OwnerSidebar />
      <main className="flex-grow ml-64 bg-surface min-h-screen">
        <TopAppBar />
        <div className="px-12 py-10">{children}</div>
      </main>
    </div>
  );
}
