"use client";

import * as React from "react";
import SimfinityClient from "@simtlix/simfinity-js-client";
import type {
  SimfinityClientInstance,
  SimfinityClientProviderOptions,
} from "./simfinityClientTypes";

const SimfinityClientContext = React.createContext<SimfinityClientInstance | null>(
  null,
);

export type SimfinityClientProviderProps = {
  endpoint: string;
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  errorFallback?: (error: Error) => React.ReactNode;
  clientOptions?: SimfinityClientProviderOptions;
};

export function SimfinityClientProvider({
  endpoint,
  children,
  loadingFallback,
  errorFallback,
  clientOptions,
}: SimfinityClientProviderProps) {
  const [client, setClient] = React.useState<SimfinityClientInstance | null>(null);
  const [initError, setInitError] = React.useState<Error | null>(null);
  const clientOptionsRef = React.useRef(clientOptions);

  React.useEffect(() => {
    clientOptionsRef.current = clientOptions;
  }, [clientOptions]);

  React.useEffect(() => {
    let cancelled = false;
    const c = new SimfinityClient(endpoint, {
      prepareHeaders(headers) {
        clientOptionsRef.current?.prepareHeaders?.(headers);
      },
    });
    c.init()
      .then(() => {
        if (!cancelled) setClient(c);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setInitError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  if (initError) {
    return (
      <>
        {errorFallback?.(initError) ?? (
          <div style={{ padding: 24, color: "red" }}>
            SimfinityClient initialization failed: {initError.message}
          </div>
        )}
      </>
    );
  }

  if (!client) {
    return (
      <>
        {loadingFallback ?? (
          <div
            style={{
              padding: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Initializing…
          </div>
        )}
      </>
    );
  }

  return (
    <SimfinityClientContext.Provider value={client}>
      {children}
    </SimfinityClientContext.Provider>
  );
}

export function useSimfinityClient(): SimfinityClientInstance {
  const client = React.useContext(SimfinityClientContext);
  if (!client) {
    throw new Error("useSimfinityClient must be used within SimfinityClientProvider");
  }
  return client;
}
