'use client';

import { RequireAuth } from '@/lib/requireAuth';
import { BarbershopProvider } from '@/lib/barbershopContext';
import { OwnerShell } from '@/components/shared/layout';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth role="OWNER">
      <BarbershopProvider>
        <OwnerShell>{children}</OwnerShell>
      </BarbershopProvider>
    </RequireAuth>
  );
}
