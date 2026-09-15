/**
 * Legacy global `fetch` patch for GraphQL auth.
 * Prefer `prepareHeaders` on `SimfinityClient` / `SimfinityClientProvider` `clientOptions` (see `providers.tsx`).
 */
export function installGraphqlAuthFetch(graphqlUrl: string) {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(graphqlUrl)) {
      const headers = new Headers(init?.headers);
      if (typeof window !== "undefined") {
        const token = localStorage.getItem("barberbooking_access_token");
        if (token) headers.set("Authorization", `Bearer ${token}`);
      }
      return original(input, { ...init, headers });
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}
