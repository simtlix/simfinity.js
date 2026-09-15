'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';

type RequireAuthProps = {
  children: React.ReactNode;
  role?: 'CLIENT' | 'OWNER' | 'PLATFORM_ADMIN';
};

export function RequireAuth({ children, role }: RequireAuthProps) {
  const { user, isOwner, isAdmin } = useAuth();
  const router = useRouter();
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    if (!user) {
      router.replace('/auth/login');
      return;
    }
    if (role === 'OWNER' && !isOwner) {
      router.replace('/');
      return;
    }
    if (role === 'PLATFORM_ADMIN' && !isAdmin) {
      router.replace('/');
      return;
    }
    setChecked(true);
  }, [user, role, isOwner, isAdmin, router]);

  if (!checked) return null;
  return <>{children}</>;
}
