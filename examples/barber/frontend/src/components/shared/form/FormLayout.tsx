"use client";

import type { ReactNode } from "react";

type FormLayoutProps = {
  children: ReactNode;
  sidebar?: ReactNode;
};

export default function FormLayout({ children, sidebar }: FormLayoutProps) {
  return (
    <div className="grid grid-cols-12 gap-8">
      <div className={sidebar ? "col-span-8" : "col-span-12"}>
        {children}
      </div>
      {sidebar && <div className="col-span-4">{sidebar}</div>}
    </div>
  );
}
