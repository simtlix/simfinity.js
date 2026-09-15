"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginRequest } from "@/lib/authApi";
import { useAuth } from "@/lib/authContext";
import { AuthFormLayout } from "@/components/custom/AuthFormLayout";
import { GoldTextField } from "@/components/custom/GoldTextField";
import { Button } from "@/components/shared/ui";

function postLoginPath(role: string | null | undefined): string {
  if (role === "PLATFORM_ADMIN") return "/admin";
  if (role === "OWNER") return "/dashboard";
  return "/";
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const runLogin = React.useCallback(
    async (emailVal: string, passwordVal: string) => {
      setError(null);
      setLoading(true);
      try {
        const auth = await loginRequest(emailVal, passwordVal);
        login(auth.accessToken, auth.refreshToken, auth.user);
        router.push(postLoginPath(auth.user.role));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al iniciar sesión");
      } finally {
        setLoading(false);
      }
    },
    [login, router],
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await runLogin(email, password);
  };

  return (
    <AuthFormLayout title="Ingresar a The Groomed" subtitle="Tu próxima experiencia te espera">
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
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
          {loading ? "Ingresando…" : "Iniciar Sesión"}
        </Button>
        <p className="text-center font-body text-sm text-on-surface-variant">
          ¿No tenés cuenta?{" "}
          <Link href="/auth/register" className="font-semibold text-primary no-underline">
            Registrate
          </Link>
        </p>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-outline-variant/35" />
          <span className="whitespace-nowrap font-body text-xs text-on-surface-variant">
            O ingresá rápido
          </span>
          <div className="h-px flex-1 bg-outline-variant/35" />
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => void runLogin("cliente@demo.com", "demo1234")}
            className="w-full rounded-lg border border-primary/40 py-2.5 text-sm font-medium text-primary opacity-80 hover:bg-primary/10 disabled:opacity-50"
          >
            Demo: Cliente
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void runLogin("propietario@demo.com", "demo1234")}
            className="w-full rounded-lg border border-primary/40 py-2.5 text-sm font-medium text-primary opacity-80 hover:bg-primary/10 disabled:opacity-50"
          >
            Demo: Propietario
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void runLogin("admin@demo.com", "demo1234")}
            className="w-full rounded-lg border border-primary/40 py-2.5 text-sm font-medium text-primary opacity-80 hover:bg-primary/10 disabled:opacity-50"
          >
            Demo: Administrador
          </button>
        </div>

        <div className="flex justify-center gap-6 pt-2">
          <Link
            href="/auth/login/owner"
            className="font-body text-[0.8125rem] text-outline no-underline hover:underline"
          >
            ¿Eres propietario?
          </Link>
          <Link
            href="/auth/login/admin"
            className="font-body text-[0.8125rem] text-outline no-underline hover:underline"
          >
            Administrador
          </Link>
        </div>
      </form>
    </AuthFormLayout>
  );
}
