"use client";

import React from "react";
import SimfinityClient from "@simtlix/simfinity-js-client";

import { Button } from "@/components/shared/ui";
import { cn } from "@/lib/cn";

const viewportClass =
  "flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background";

export function LoadingFallback() {
  return (
    <div
      className={viewportClass}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Conectando</span>

      <div className="relative mb-8 h-[120px] w-[120px]">
        <div
          className={cn(
            "absolute inset-0 rounded-full border-[3px] border-transparent",
            "border-t-primary-container border-r-primary",
            "animate-[init-orbit_1.6s_linear_infinite]",
          )}
        />
        <div
          className={cn(
            "absolute inset-2 rounded-full border-2 border-transparent",
            "border-b-primary-container border-l-primary",
            "animate-[init-orbit_2.4s_linear_infinite_reverse]",
          )}
        />
        <div
          className={cn(
            "absolute inset-4 rounded-full bg-primary-container/10",
            "animate-[init-ring-pulse_2s_ease-in-out_infinite]",
          )}
        />
        <div
          className={cn(
            "absolute inset-5 flex items-center justify-center rounded-full border border-primary/25 bg-background",
            "animate-[init-pulse_2s_ease-in-out_infinite,init-gold-glow_2.5s_ease-in-out_infinite]",
          )}
        >
          <span
            className={cn(
              "select-none text-center font-headline text-base font-semibold italic leading-tight tracking-wide text-primary-container",
            )}
          >
            The
            <br />
            Groomed
          </span>
        </div>
      </div>

      <div className="mb-5 flex gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn(
              "h-2 w-2 rounded-full bg-gold-gradient",
              "animate-[init-bounce_1.2s_ease-in-out_infinite]",
            )}
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>

      <p
        className={cn(
          "m-0 animate-[init-fade-in-up_0.6s_ease-out_both]",
          "text-sm font-medium uppercase tracking-[0.12em] text-outline",
        )}
      >
        Conectando&hellip;
      </p>
    </div>
  );
}

export function ErrorFallback({ error }: { error: Error }) {
  return (
    <div
      className={viewportClass}
      role="alert"
      aria-live="assertive"
    >
      <div
        className={cn(
          "mb-7 flex h-24 w-24 items-center justify-center rounded-full",
          "animate-[init-shake_0.7s_ease-out,init-breath_2.5s_ease-in-out_0.7s_infinite]",
          "shadow-[0_8px_32px_rgba(239,83,80,0.25)]",
        )}
        style={{
          background: "linear-gradient(135deg, #EF5350, #D32F2F)",
        }}
      >
        <svg
          width="44"
          height="44"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </div>

      <h1
        className={cn(
          "mb-2 animate-[init-fade-in-up_0.5s_ease-out_0.3s_both]",
          "font-headline text-[26px] font-semibold italic text-[#EF5350]",
        )}
      >
        Error de Conexi&oacute;n
      </h1>

      <p
        className={cn(
          "mb-6 animate-[init-fade-in-up_0.5s_ease-out_0.45s_both]",
          "text-[15px] text-outline",
        )}
      >
        No se pudo conectar al servidor
      </p>

      <div
        className={cn(
          "mb-7 w-[90%] max-w-[440px] animate-[init-fade-in-up_0.5s_ease-out_0.55s_both]",
          "rounded-xl border border-error/20 bg-white/[0.04] px-5 py-3.5 backdrop-blur-sm",
        )}
      >
        <code className="break-words font-mono text-[13px] text-[#EF5350]">
          {error.message}
        </code>
      </div>

      <Button
        type="button"
        variant="gold"
        size="form"
        className={cn(
          "animate-[init-fade-in-up_0.5s_ease-out_0.65s_both]",
          "shadow-[0_6px_20px_rgba(201,169,110,0.25)] transition-transform hover:-translate-y-0.5",
          "hover:shadow-[0_10px_28px_rgba(201,169,110,0.35)]",
        )}
        onClick={() => window.location.reload()}
      >
        Reintentar
      </Button>
    </div>
  );
}

export function InitGuard({
  endpoint,
  children,
}: {
  endpoint: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const client = new SimfinityClient(endpoint);
    client
      .init()
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  if (status === "error" && error) return <ErrorFallback error={error} />;
  if (status === "loading") return <LoadingFallback />;
  return <>{children}</>;
}
