"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useT } from "@/hooks/useT";
import { usePagination } from "@/hooks/usePagination";
import { StarRating } from "@/components/shared/data/StarRating";
import { PaginationBar } from "@/components/shared/data/PaginationBar";
import { EmptyState } from "@/components/shared/page/EmptyState";
import { SearchBar } from "@/components/shared/form";
import MapView from "@/components/shared/maps/MapView";
import { useSimfinityClient } from "@/lib/simfinity";
import { cn } from "@/lib/cn";

type BarbershopResult = {
  id: string;
  name: string;
  slug: string;
  coverImageUrl?: string | null;
  averageRating?: number | null;
  reviewCount?: number | null;
  address?: { street?: string | null; number?: string | null; city?: string | null; state?: string | null } | null;
  latitude?: number | null;
  longitude?: number | null;
};

type SearchMode = "nombre" | "ciudad" | "cercaDeTi";

const BUENOS_AIRES_CENTER: [number, number] = [-34.6037, -58.3816];

export default function SearchPage() {
  const t = useT("search");
  const searchParams = useSearchParams();
  const { page, pageSize, setPage, reset } = usePagination(9);

  const client = useSimfinityClient();

  const [rows, setRows] = useState<BarbershopResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [mode, setMode] = useState<SearchMode>(
    (searchParams.get("mode") as SearchMode) || "nombre",
  );

  const runSearch = useCallback(
    async (q: string, m: SearchMode) => {
      setError(null);
      setLoading(true);
      setSearched(true);
      try {
        const baseQuery = client
          .find("barbershop")
          .fields("id name slug coverImageUrl averageRating reviewCount address { street number city state } latitude longitude")
          .where("state", "EQ", "APPROVED");

        let results: BarbershopResult[];

        switch (m) {
          case "nombre": {
            const finder = q ? baseQuery.where("name", "LIKE", q) : baseQuery;
            results = (await finder.exec()) as BarbershopResult[];
            break;
          }
          case "ciudad": {
            const finder = q ? baseQuery.where("address.city", "LIKE", q) : baseQuery;
            results = (await finder.exec()) as BarbershopResult[];
            break;
          }
          case "cercaDeTi": {
            if (navigator.geolocation) {
              const pos = await new Promise<GeolocationPosition>(
                (resolve, reject) =>
                  navigator.geolocation.getCurrentPosition(resolve, reject, {
                    timeout: 8000,
                  }),
              );
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              let finder = baseQuery
                .where("latitude", "BTW", [lat - 0.09, lat + 0.09])
                .where("longitude", "BTW", [lng - 0.09, lng + 0.09]);
              if (q) finder = finder.where("name", "LIKE", q);
              results = (await finder.exec()) as BarbershopResult[];
            } else {
              const finder = q ? baseQuery.where("name", "LIKE", q) : baseQuery;
              results = (await finder.exec()) as BarbershopResult[];
            }
            break;
          }
        }

        setRows(results);
        reset();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("error", "Búsqueda fallida"),
        );
      } finally {
        setLoading(false);
      }
    },
    [client, reset, t],
  );

  useEffect(() => {
    const qParam = searchParams.get("q");
    const mParam = (searchParams.get("mode") as SearchMode) || "nombre";
    if (qParam) {
      setQuery(qParam);
      setMode(mParam);
      runSearch(qParam, mParam);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    runSearch(query, mode);
  };

  const paginatedRows = rows.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const searchModes = [
    { id: "nombre", label: t("tabName", "Nombre"), icon: "search" },
    { id: "ciudad", label: t("tabCity", "Ciudad"), icon: "location_on" },
    { id: "cercaDeTi", label: t("tabNearby", "Cerca de ti"), icon: "near_me" },
  ];

  return (
    <div className="pt-12 pb-20 px-6 md:px-12 max-w-7xl mx-auto">
      {/* ── Header ── */}
      <header className="mb-12">
        <h1 className="font-headline text-5xl italic font-bold tracking-tight text-on-surface mb-2">
          {t("title", "Encuentra tu estilo")}
        </h1>
        {searched && !loading && rows.length > 0 && (
          <p className="font-label text-on-surface-variant text-sm tracking-[0.1rem] uppercase">
            {rows.length} {t("resultsCount", "barberías encontradas")}
          </p>
        )}
      </header>

      {/* ── Search Bar ── */}
      <section className="mb-16">
        <SearchBar
          value={query}
          onChange={setQuery}
          onSearch={handleSearch}
          mode={mode}
          onModeChange={(m) => setMode(m as SearchMode)}
          modes={searchModes}
          placeholder={t("searchPlaceholder", "¿Qué estás buscando hoy?")}
          searchLabel={t("searchButton", "BUSCAR")}
        />
      </section>

      {/* ── View Toggle ── */}
      {searched && rows.length > 0 && (
        <div className="flex justify-end mb-6">
          <div className="flex bg-surface-container-high rounded-lg p-1">
            <button
              onClick={() => setShowMap(false)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-all",
                !showMap
                  ? "bg-primary text-on-primary"
                  : "text-on-surface/60 hover:text-on-surface",
              )}
            >
              <span className="material-symbols-outlined text-base">
                grid_view
              </span>
              {t("gridView", "Grilla")}
            </button>
            <button
              onClick={() => setShowMap(true)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-all",
                showMap
                  ? "bg-primary text-on-primary"
                  : "text-on-surface/60 hover:text-on-surface",
              )}
            >
              <span className="material-symbols-outlined text-base">map</span>
              {t("mapView", "Mapa")}
            </button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="mb-6 p-4 rounded-xl bg-error-container/20 border border-error/30 text-error text-sm">
          {error}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div className="flex justify-center py-20">
          <span className="material-symbols-outlined animate-spin text-primary text-4xl">
            progress_activity
          </span>
        </div>
      )}

      {/* ── Not yet searched ── */}
      {!searched && !loading && (
        <p className="text-on-surface-variant/70 text-sm py-4">
          {t(
            "searchPrompt",
            "Ingresá un criterio de búsqueda para ver barberías disponibles.",
          )}
        </p>
      )}

      {/* ── Empty state ── */}
      {searched && !loading && !error && rows.length === 0 && (
        <EmptyState
          icon="search_off"
          title={t("emptyTitle", "Sin resultados")}
          message={t(
            "emptyMessage",
            "No pudimos encontrar barberías que coincidan con tus criterios. Intenta con otros términos.",
          )}
        />
      )}

      {/* ── Map View ── */}
      {searched && !loading && showMap && rows.length > 0 && (
        <div className="h-[500px] rounded-2xl overflow-hidden mb-8 border border-outline-variant/10">
          <MapView
            center={BUENOS_AIRES_CENTER}
            zoom={12}
            markers={rows.map((shop) => ({
              lat: BUENOS_AIRES_CENTER[0],
              lng: BUENOS_AIRES_CENTER[1],
              label: shop.name,
              popupContent: (
                <Link
                  href={`/b/${shop.slug}`}
                  className="flex flex-col gap-1 text-sm"
                >
                  <span className="font-semibold text-on-surface">
                    {shop.name}
                  </span>
                  {shop.averageRating != null && (
                    <span className="flex items-center gap-1 text-xs text-primary">
                      <span className="material-symbols-outlined text-sm">
                        star
                      </span>
                      {shop.averageRating.toFixed(1)}
                    </span>
                  )}
                </Link>
              ),
            }))}
          />
        </div>
      )}

      {/* ── Results Grid ── */}
      {!loading && !showMap && paginatedRows.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            {paginatedRows.map((shop) => (
              <Link
                key={shop.id}
                href={`/b/${shop.slug}`}
                className="group cursor-pointer block"
              >
                <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-surface-container-high mb-5">
                  {shop.coverImageUrl ? (
                    <Image
                      src={shop.coverImageUrl}
                      alt={shop.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-surface-container-high">
                      <span className="material-symbols-outlined text-6xl text-on-surface-variant/20">
                        storefront
                      </span>
                    </div>
                  )}
                  <div className="absolute top-4 right-4 bg-emerald-500/90 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-widest backdrop-blur-sm">
                    {t("open", "Abierto")}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-start">
                    <h3 className="font-headline text-2xl italic text-on-surface">
                      {shop.name}
                    </h3>
                    {shop.averageRating != null && (
                      <div className="flex items-center gap-1 text-primary">
                        <span
                          className="material-symbols-outlined text-sm"
                          style={{
                            fontVariationSettings: "'FILL' 1",
                          }}
                        >
                          star
                        </span>
                        <span className="font-label text-sm font-semibold">
                          {shop.averageRating.toFixed(1)}
                        </span>
                      </div>
                    )}
                  </div>
                  {shop.address?.city && (
                    <p className="text-on-surface-variant text-sm font-light">
                      {[shop.address?.street, shop.address?.number, shop.address?.city]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* ── Pagination ── */}
          {rows.length > pageSize && (
            <div className="mt-12">
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={rows.length}
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      )}

      {/* ── Footer ── */}
      <footer className="mt-20 py-10 border-t border-outline-variant/10 text-center">
        <p className="text-outline text-xs tracking-widest uppercase">
          {t("footerText", "The Groomed © 2024 — Crafted for Gentlemen")}
        </p>
      </footer>
    </div>
  );
}
