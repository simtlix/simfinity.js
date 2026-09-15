"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginRequest } from "@/lib/authApi";
import { useAuth } from "@/lib/authContext";
import { AuthFormLayout } from "@/components/custom/AuthFormLayout";
import { GoldTextField } from "@/components/custom/GoldTextField";
import { Button } from "@/components/shared/ui";
import { useT } from "@/hooks/useT";

export default function OwnerLoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const t = useT("auth");
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
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al iniciar sesión");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthFormLayout
      title={t("brand.managementSuite", "Management Suite")}
      subtitle={t("brand.ownerSubtitle", "Gestiona tu barbería")}
      footer={
        <p className="text-center font-body text-[0.8125rem] text-on-surface-variant">
          <Link href="/auth/login" className="text-outline no-underline hover:underline">
            {t("brand.clientQuestion", "¿Eres cliente?")}
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <p className="-mb-2 text-center font-label text-[0.6875rem] font-normal uppercase tracking-[0.15em] text-outline">
          {t("brand.name", "Simfinity Barber")}
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
          {loading ? "Ingresando…" : "Acceder al Panel"}
        </Button>
        <p className="text-center font-body text-sm text-on-surface-variant">
          ¿No tenés cuenta?{" "}
          <Link
            href="/auth/register/owner"
            className="font-semibold text-primary no-underline"
          >
            Registrate
          </Link>
        </p>
      </form>
    </AuthFormLayout>
  );
}
