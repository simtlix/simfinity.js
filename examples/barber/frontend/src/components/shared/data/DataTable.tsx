"use client";

import { EmptyState } from "../page/EmptyState";
import { cn } from "@/lib/cn";

export interface Column {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (value: unknown, row: Record<string, unknown>) => React.ReactNode;
}

interface DataTableProps {
  columns: Column[];
  data: Record<string, unknown>[];
  loading?: boolean;
  emptyMessage?: string;
  onSort?: (key: string, dir: "asc" | "desc") => void;
  sortKey?: string;
  sortDir?: "asc" | "desc";
  actions?: (row: Record<string, unknown>) => React.ReactNode;
  onRowClick?: (row: Record<string, unknown>) => void;
}

export function DataTable({
  columns,
  data,
  loading,
  emptyMessage,
  onSort,
  sortKey,
  sortDir,
  actions,
  onRowClick,
}: DataTableProps) {
  function handleSort(col: Column) {
    if (!col.sortable || !onSort) return;
    const nextDir = sortKey === col.key && sortDir === "asc" ? "desc" : "asc";
    onSort(col.key, nextDir);
  }

  if (loading) {
    return (
      <div className="bg-surface-container-low rounded-2xl overflow-hidden">
        <div className="flex items-center justify-center py-20">
          <span className="material-symbols-outlined text-primary text-3xl animate-spin">
            progress_activity
          </span>
        </div>
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="bg-surface-container-low rounded-2xl overflow-hidden">
        <EmptyState
          icon="search_off"
          title={emptyMessage ?? "Sin resultados"}
        />
      </div>
    );
  }

  const hasActions = !!actions;

  return (
    <div className="bg-surface-container-low rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-surface-container-high">
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col)}
                  className={cn(
                    "text-left text-xs uppercase tracking-widest text-on-surface-variant px-6 py-4 font-semibold",
                    col.sortable && "cursor-pointer select-none hover:text-on-surface",
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && sortKey === col.key && (
                      <span className="material-symbols-outlined text-primary text-sm">
                        {sortDir === "asc" ? "arrow_upward" : "arrow_downward"}
                      </span>
                    )}
                  </span>
                </th>
              ))}
              {hasActions && (
                <th className="text-right text-xs uppercase tracking-widest text-on-surface-variant px-6 py-4 font-semibold">
                  &nbsp;
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  "border-b border-outline-variant/10 hover:bg-surface-container transition-colors",
                  onRowClick && "cursor-pointer",
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-6 py-4 text-sm text-on-surface">
                    {col.render
                      ? col.render(row[col.key], row)
                      : (row[col.key] as React.ReactNode) ?? "—"}
                  </td>
                ))}
                {hasActions && (
                  <td className="px-6 py-4 text-right">{actions(row)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
