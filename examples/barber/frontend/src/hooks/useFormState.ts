"use client";

import { useState, useCallback } from "react";

type FormErrors<T> = Partial<Record<keyof T, string>>;

interface UseFormStateReturn<T extends Record<string, unknown>> {
  values: T;
  errors: FormErrors<T>;
  setValue: <K extends keyof T>(field: K, value: T[K]) => void;
  setValues: (patch: Partial<T>) => void;
  setError: (field: keyof T, message: string) => void;
  clearError: (field: keyof T) => void;
  clearErrors: () => void;
  reset: () => void;
  isDirty: boolean;
}

export function useFormState<T extends Record<string, unknown>>(
  initialValues: T,
): UseFormStateReturn<T> {
  const [values, setValuesState] = useState<T>(initialValues);
  const [errors, setErrors] = useState<FormErrors<T>>({});
  const [isDirty, setIsDirty] = useState(false);

  const setValue = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setValuesState((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const setValues = useCallback((patch: Partial<T>) => {
    setValuesState((prev) => ({ ...prev, ...patch }));
    setIsDirty(true);
  }, []);

  const setError = useCallback((field: keyof T, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }));
  }, []);

  const clearError = useCallback((field: keyof T) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const clearErrors = useCallback(() => {
    setErrors({});
  }, []);

  const reset = useCallback(() => {
    setValuesState(initialValues);
    setErrors({});
    setIsDirty(false);
  }, [initialValues]);

  return {
    values,
    errors,
    setValue,
    setValues,
    setError,
    clearError,
    clearErrors,
    reset,
    isDirty,
  };
}
