"use client";

import { useI18n } from "@/lib/simfinity";
import { useCallback } from "react";

/**
 * Returns a translation function scoped to an optional namespace.
 *
 * @example
 *   const t = useT("nav");
 *   t("dashboard"); // resolves key "nav.dashboard"
 *
 *   const t = useT();
 *   t("common.save"); // resolves key "common.save"
 */
export function useT(namespace?: string) {
  const { resolveLabel } = useI18n();

  const t = useCallback(
    (key: string, fallback?: string): string => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      const resolved = resolveLabel([fullKey], { entity: "" }, fallback ?? key);
      return resolved ?? fallback ?? key;
    },
    [namespace, resolveLabel],
  );

  return t;
}
