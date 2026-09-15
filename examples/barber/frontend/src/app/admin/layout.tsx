'use client';

import { RequireAuth } from '@/lib/requireAuth';
import { AdminShell } from '@/components/shared/layout';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth role="PLATFORM_ADMIN">
      <AdminShell>{children}</AdminShell>
    </RequireAuth>
  );
}
