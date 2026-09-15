"use client";

import { useT } from "@/hooks/useT";
import { cn } from "@/lib/cn";

interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50],
}: PaginationBarProps) {
  const t = useT("common");

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pageNumbers = buildPageNumbers(page, totalPages);

  return (
    <div className="flex flex-col sm:flex-row justify-between items-center gap-3 px-4 py-3 text-sm text-on-surface-variant">
      <span>
        {t("showing", "Mostrando")} {start}–{end} {t("of", "de")} {total}
      </span>

      <div className="flex items-center gap-1">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="p-1.5 rounded-lg hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label={t("previousPage", "Página anterior")}
        >
          <span className="material-symbols-outlined text-lg">chevron_left</span>
        </button>

        {pageNumbers.map((n, i) =>
          n === null ? (
            <span key={`ellipsis-${i}`} className="px-1 text-on-surface-variant/40">
              …
            </span>
          ) : (
            <button
              key={n}
              onClick={() => onPageChange(n)}
              className={cn(
                "min-w-[32px] h-8 rounded-lg text-xs font-semibold transition-colors",
                n === page
                  ? "bg-primary text-on-primary"
                  : "hover:bg-surface-container-high text-on-surface-variant",
              )}
            >
              {n}
            </button>
          ),
        )}

        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="p-1.5 rounded-lg hover:bg-surface-container-high disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label={t("nextPage", "Página siguiente")}
        >
          <span className="material-symbols-outlined text-lg">chevron_right</span>
        </button>

        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="ml-3 bg-surface-container-high text-on-surface-variant rounded-lg px-2 py-1 text-xs border border-outline-variant/20 focus:outline-none focus:border-primary/40"
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt} / {t("page", "pág")}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function buildPageNumbers(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | null)[] = [1];

  if (current > 3) pages.push(null);

  const rangeStart = Math.max(2, current - 1);
  const rangeEnd = Math.min(total - 1, current + 1);

  for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);

  if (current < total - 2) pages.push(null);

  pages.push(total);
  return pages;
}
