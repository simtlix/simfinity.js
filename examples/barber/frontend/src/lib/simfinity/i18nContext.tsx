"use client";

import * as React from "react";

const REGISTRY_KEY = "__simfinity_i18n_registry__";

export type LabelContext = Record<string, unknown>;

export type ResolveLabelFn = (
  keys: string[],
  ctx: LabelContext,
  fallback?: string,
) => string | undefined;

export type I18nContextValue = {
  locale: string;
  setLocale: (locale: string) => void;
  resolveLabel: ResolveLabelFn;
};

const I18nContext = React.createContext<I18nContextValue | undefined>(undefined);

function getFunctionLabelsForLocale(
  locale: string,
): Record<string, string | ((ctx: LabelContext) => string)> {
  const g = globalThis as unknown as Record<string, Map<string, Record<string, unknown>>>;
  const map = g[REGISTRY_KEY];
  if (map instanceof Map) {
    const raw = map.get(locale) ?? {};
    return raw as Record<string, string | ((ctx: LabelContext) => string)>;
  }
  return {};
}

/**
 * Register function- or string-based labels for a locale (optional advanced API).
 * Merges with any existing labels for that locale.
 */
export function registerFunctionLabels(
  locale: string,
  labels: Record<string, string | ((ctx: LabelContext) => string)>,
): void {
  const g = globalThis as unknown as Record<string, Map<string, Record<string, unknown>>>;
  const map = g[REGISTRY_KEY] ?? new Map<string, Record<string, unknown>>();
  const existing = (map.get(locale) ?? {}) as Record<string, string | ((ctx: LabelContext) => string)>;
  map.set(locale, { ...existing, ...labels });
  g[REGISTRY_KEY] = map;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const defaultLocale =
    (typeof window !== "undefined" &&
      (navigator.language?.split("-")[0] || "en")) ||
    "en";
  const [locale, setLocale] = React.useState(defaultLocale);
  const [stringLabels, setStringLabels] = React.useState<Record<string, string>>({});
  const [funcLabels, setFuncLabels] = React.useState<
    Record<string, string | ((ctx: LabelContext) => string)>
  >({});

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/i18n/${locale}.json`)
      .then(async (res) => (res.ok ? res.json() : {}))
      .then((json) => {
        if (!cancelled && json && typeof json === "object") {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
            if (typeof v === "string") flat[k] = v;
          }
          setStringLabels(flat);
        }
      })
      .catch(() => {
        if (!cancelled) setStringLabels({});
      });

    if (!cancelled) {
      setFuncLabels(getFunctionLabelsForLocale(locale));
    }

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const resolveLabel = React.useCallback<ResolveLabelFn>(
    (keys, ctx, fallback) => {
      for (const key of keys) {
        const fv = funcLabels[key];
        if (typeof fv === "function") return fv(ctx);
        if (typeof fv === "string") return fv;
        const sv = stringLabels[key];
        if (typeof sv === "string") return sv;
      }
      return fallback;
    },
    [funcLabels, stringLabels],
  );

  const value = React.useMemo<I18nContextValue>(
    () => ({ locale, setLocale, resolveLabel }),
    [locale, setLocale, resolveLabel],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
