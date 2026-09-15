"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginRequest } from "@/lib/authApi";
import { useAuth } from "@/lib/authContext";
import { AuthFormLayout } from "@/components/custom/AuthFormLayout";
import { GoldTextField } from "@/components/custom/GoldTextField";
import { Button } from "@/components/shared/ui";

export default function AdminLoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const auth = await loginRequest(email, password);
      login(auth.accessToken, auth.refreshToken, auth.user);
      router.push("/admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al iniciar sesión");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthFormLayout
      title="Admin Console"
      subtitle="Acceso administrativo"
      footer={
        <p className="text-center font-body text-[0.8125rem] text-on-surface-variant">
          <Link href="/auth/login" className="text-outline no-underline hover:underline">
            Volver al login principal
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <p className="-mb-2 text-center font-label text-[0.6875rem] font-normal uppercase tracking-[0.15em] text-outline">
          The Groomed
        </p>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-sm text-error"
          >
            {error}
          </div>
        )}
        <GoldTextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <GoldTextField
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="gold" size="form" disabled={loading} className="mt-1 w-full shadow-md">
          {loading ? "Verificando…" : "Acceso Admin"}
        </Button>
      </form>
    </AuthFormLayout>
  );
}
