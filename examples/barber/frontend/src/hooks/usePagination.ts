"use client";

import { useState, useCallback } from "react";

interface PaginationState {
  page: number;
  pageSize: number;
}

interface UsePaginationReturn extends PaginationState {
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  offset: number;
  reset: () => void;
}

export function usePagination(initialPageSize = 10): UsePaginationReturn {
  const [state, setState] = useState<PaginationState>({
    page: 1,
    pageSize: initialPageSize,
  });

  const setPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, page }));
  }, []);

  const setPageSize = useCallback((pageSize: number) => {
    setState({ page: 1, pageSize });
  }, []);

  const reset = useCallback(() => {
    setState({ page: 1, pageSize: initialPageSize });
  }, [initialPageSize]);

  return {
    ...state,
    setPage,
    setPageSize,
    offset: (state.page - 1) * state.pageSize,
    reset,
  };
}
