"use client";

import * as React from "react";
import {
  I18nProvider,
  SimfinityClientProvider,
  useI18n,
  useSimfinityClient,
} from "@/lib/simfinity";
import { setSimfinityClient } from "@/lib/simfinityClientRef";
import { ErrorFallback, LoadingFallback } from "@/lib/initGuard";
import { AuthProvider } from "@/lib/authContext";

const GRAPHQL_URL =
  process.env.NEXT_PUBLIC_GRAPHQL_URL || "http://localhost:4400/graphql";

const simfinityClientOptions = {
  prepareHeaders(headers: Record<string, string>) {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("barberbooking_access_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  },
};

function ClientRefCapture({ children }: { children: React.ReactNode }) {
  const client = useSimfinityClient();
  React.useEffect(() => {
    setSimfinityClient(client);
  }, [client]);
  return <>{children}</>;
}

function SpanishLocale({ children }: { children: React.ReactNode }) {
  const { locale, setLocale } = useI18n();
  React.useEffect(() => {
    if (locale !== "es") setLocale("es");
  }, [locale, setLocale]);
  return <>{children}</>;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SimfinityClientProvider
      endpoint={GRAPHQL_URL}
      clientOptions={simfinityClientOptions}
      loadingFallback={<LoadingFallback />}
      errorFallback={(err) => <ErrorFallback error={err} />}
    >
      <ClientRefCapture>
        <I18nProvider>
          <SpanishLocale>
            <AuthProvider>{children}</AuthProvider>
          </SpanishLocale>
        </I18nProvider>
      </ClientRefCapture>
    </SimfinityClientProvider>
  );
}
