'use client';

import { RequireAuth } from '@/lib/requireAuth';
import { OwnerShell } from '@/components/shared/layout';

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth role="OWNER">
      <OwnerShell>{children}</OwnerShell>
    </RequireAuth>
  );
}
