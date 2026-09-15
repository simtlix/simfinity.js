"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useT } from "@/hooks/useT";
import { StarRating } from "@/components/shared/data/StarRating";
import { SearchBar } from "@/components/shared/form";
import { useSimfinityClient } from "@/lib/simfinity";
import { cn } from "@/lib/cn";

type BarbershopCard = {
  id: string;
  name: string;
  slug: string;
  coverImageUrl?: string | null;
  averageRating?: number | null;
  reviewCount?: number | null;
  address?: { city?: string | null } | null;
};

type SearchMode = "nombre" | "ciudad" | "cercaDeTi";

const HERO_BG =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuBi4LQZbWSc9i_HxqMad2eByU-rNRkuE6c6QDEOmV1IiJDoAfZ6_9Pxj_hbZ1CVjaZtSGhEjuJd7LZo5muHbhUpYfS5u7tfO_vnAcgxQ8PCwrsTfFm-vcQ5tvL0nFCtw6rHFB6Tirjsb3UXlb68P0H0a7QrDT4Zz44Xsuv7tpZnf2-mt-Fn52meGGVHJ54rPhb6K3oZ6_gn3oyA-7Vuq2g4xL3oRASKkkVwA1eBvJ1YpS_ZFoLUc2P_R8eTwZzesKrEV3btAGi6jP8";

const EDITORIAL_IMG =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuBurTifhbnIB_lxGoHmtkGowM-pmZ20ix68lrb_AY6tbmsbaQ0fXikhNFr9T7I13J__nDlJXWIRmT-lgDKMsmNgrVVOrtw7t8tDud1Z_nuzjE2CZ22Lx00gWPeNiY2W0wo9yqP656MKmheUw8g_sCMQP6B5KYSjnGonWtteOm3yVlp4W3FATBac_Vo2mpsJB3c8yMgQVYAwZjqzxwnyG-Hj2fu_fG4EYp2XqwAaij3wZ0MPOFO-9osbMVkJDQZ-tY1QLZrtxUzlDk0";

const defaultStats = [
  { value: "50+", labelKey: "statsShops" },
  { value: "200+", labelKey: "statsBarbers" },
  { value: "10K+", labelKey: "statsClients" },
];

export default function HomePage() {
  const router = useRouter();
  const t = useT("home");
  const client = useSimfinityClient();
  const [shops, setShops] = useState<BarbershopCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("nombre");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await client.find('barbershop')
          .fields('id name slug coverImageUrl averageRating reviewCount address { city }')
          .where('state', 'EQ', 'APPROVED')
          .sort('averageRating', 'DESC')
          .page(1, 6)
          .exec();
        if (!cancelled) setShops(result as BarbershopCard[]);
      } catch {
        if (!cancelled) setShops([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const handleSearch = useCallback(() => {
    const params = new URLSearchParams();
    if (searchQuery) params.set("q", searchQuery);
    if (searchMode !== "nombre") params.set("mode", searchMode);
    const qs = params.toString();
    router.push(qs ? `/search?${qs}` : "/search");
  }, [searchQuery, searchMode, router]);

  const searchModes = [
    { id: "nombre", label: t("tabName", "Nombre"), icon: "search" },
    { id: "ciudad", label: t("tabCity", "Ciudad"), icon: "location_on" },
    { id: "cercaDeTi", label: t("tabNearby", "Cerca de ti"), icon: "near_me" },
  ];

  return (
    <>
      {/* ── Hero Section ── */}
      <section className="relative h-[870px] flex flex-col items-center justify-center px-4 overflow-hidden -mt-20">
        <div className="absolute inset-0 z-0">
          <Image
            src={HERO_BG}
            alt={t("heroAlt", "Premium barbershop")}
            fill
            className="object-cover object-[center_30%]"
            priority
            sizes="100vw"
          />
          {/* Readable text without crushing the photo */}
          <div
            className={cn(
              "pointer-events-none absolute inset-0",
              "bg-gradient-to-b from-background/55 via-background/20 to-background",
            )}
          />
          <div
            className={cn(
              "pointer-events-none absolute inset-0",
              "bg-[radial-gradient(ellipse_85%_50%_at_50%_0%,rgba(230,196,135,0.08),transparent_55%)]",
            )}
          />
        </div>

        <div className="relative z-10 mx-auto max-w-4xl space-y-6 text-center">
          <h1 className="text-5xl md:text-7xl font-headline font-bold text-on-surface tracking-tight leading-tight">
            {t("heroTitle", "Encontrá tu")}{" "}
            <span className="italic text-primary">
              {t("heroTitleAccent", "barbería ideal")}
            </span>
          </h1>
          <p className="text-lg md:text-xl text-on-surface/70 font-body max-w-2xl mx-auto">
            {t(
              "heroSubtitle",
              "Reservá tu turno en segundos y disfrutá de una experiencia de grooming editorial en las mejores manos.",
            )}
          </p>

          {/* Search bar */}
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            onSearch={handleSearch}
            mode={searchMode}
            onModeChange={(m) => setSearchMode(m as SearchMode)}
            modes={searchModes}
            placeholder={t("searchPlaceholder", "¿A qué barbero o local buscas?")}
            searchLabel={t("searchButton", "BUSCAR")}
            className="mt-12 w-full max-w-3xl mx-auto backdrop-blur-md bg-surface-container-low/80"
          />
        </div>
      </section>

      {/* ── Featured Barbershops ── */}
      <section className="max-w-7xl mx-auto px-6 md:px-12 py-24 space-y-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="space-y-2">
            <span className="text-xs font-label tracking-[0.2em] text-primary">
              {t("discoverLabel", "DESCUBRIR")}
            </span>
            <h2 className="text-4xl font-headline font-bold italic tracking-tight">
              {t("nearbyTitle", "Cerca de ti")}
            </h2>
          </div>
          <Link
            href="/search"
            className="text-primary font-label text-sm tracking-widest hover:underline decoration-primary/30 underline-offset-8"
          >
            {t("viewAll", "VER TODAS")}
          </Link>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <span className="material-symbols-outlined animate-spin text-primary text-4xl">
              progress_activity
            </span>
          </div>
        ) : shops.length === 0 ? (
          <p className="text-center text-on-surface-variant py-12">
            {t("noShops", "No hay barberías disponibles")}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {shops.map((shop) => (
              <Link
                key={shop.id}
                href={`/b/${shop.slug}`}
                className="group bg-surface-container-low rounded-xl p-6 transition-all hover:bg-surface-container-high hover:-translate-y-1 duration-300"
              >
                <div className="flex items-start justify-between mb-6">
                  <div className="w-16 h-16 rounded-full border-2 border-primary/20 p-1 group-hover:border-primary transition-colors">
                    <div className="w-full h-full rounded-full bg-surface-container-highest overflow-hidden">
                      {shop.coverImageUrl ? (
                        <Image
                          src={shop.coverImageUrl}
                          alt={shop.name}
                          width={56}
                          height={56}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-primary text-lg font-headline font-bold">
                          {shop.name.charAt(0)}
                        </div>
                      )}
                    </div>
                  </div>
                  <span className="px-3 py-1 bg-green-900/30 text-green-400 text-[10px] font-label font-bold tracking-widest rounded-full border border-green-500/20">
                    {t("open", "ABIERTO")}
                  </span>
                </div>

                <div className="space-y-4">
                  <div>
                    <h3 className="text-xl font-headline font-bold text-on-surface group-hover:text-primary transition-colors">
                      {shop.name}
                    </h3>
                    {shop.address?.city && (
                      <p className="text-sm text-on-surface/50">{shop.address.city}</p>
                    )}
                  </div>

                  {shop.averageRating != null && (
                    <div className="flex items-center gap-2">
                      <StarRating
                        rating={shop.averageRating}
                        count={shop.reviewCount ?? undefined}
                        size="sm"
                      />
                    </div>
                  )}

                  <span className="block w-full py-3 bg-surface-container-highest text-on-surface text-sm font-label font-semibold tracking-widest rounded-lg text-center transition-colors group-hover:bg-primary group-hover:text-on-primary">
                    {t("bookButton", "RESERVAR TURNO")}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Editorial Banner ── */}
      <section className="max-w-7xl mx-auto px-6 md:px-12 py-24">
        <div className="bg-surface-container-high rounded-2xl overflow-hidden flex flex-col md:flex-row items-center border border-outline-variant/10">
          <div className="flex-1 p-12 space-y-8">
            <h2 className="text-4xl md:text-5xl font-headline font-bold italic text-on-surface leading-tight">
              {t("editorialTitle", "La excelencia")}
              <br />
              {t("editorialTitleLine2", "está en el detalle.")}
            </h2>
            <p className="text-on-surface/60 font-body leading-relaxed max-w-md">
              {t(
                "editorialBody",
                "Nuestra red exclusiva conecta a los maestros del oficio con quienes valoran la perfección. No es solo un corte, es un ritual.",
              )}
            </p>
            <div className="flex gap-4">
              {defaultStats.map((stat, i) => (
                <div
                  key={stat.labelKey}
                  className={cn(
                    "text-center px-4 py-2",
                    i < defaultStats.length - 1 &&
                      "border-r border-outline-variant/20",
                  )}
                >
                  <p className="text-2xl font-headline font-bold text-primary">
                    {stat.value}
                  </p>
                  <p className="text-[10px] font-label tracking-widest text-on-surface/40">
                    {t(stat.labelKey, stat.value)}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 w-full h-[400px] md:h-auto self-stretch relative">
            <Image
              src={EDITORIAL_IMG}
              alt={t("editorialImgAlt", "Barber working")}
              fill
              className="object-cover"
            />
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="bg-surface-container-low border-t border-outline-variant/5 py-12 px-6 md:px-12 mt-24">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
          <div className="space-y-4">
            <span className="text-xl font-headline font-bold text-primary italic">
              The Groomed
            </span>
            <p className="text-sm text-on-surface/40 font-body">
              {t("footerCopyright", "Simfinity Barber © 2026")}
            </p>
          </div>
          <div className="flex gap-8 text-xs font-label tracking-widest text-on-surface/50">
            <a href="#" className="hover:text-primary transition-colors">
              {t("footerTerms", "TÉRMINOS")}
            </a>
            <a href="#" className="hover:text-primary transition-colors">
              {t("footerPrivacy", "PRIVACIDAD")}
            </a>
            <Link href="/search" className="hover:text-primary transition-colors">
              {t("footerShops", "BARBERÍAS")}
            </Link>
            <a href="#" className="hover:text-primary transition-colors">
              {t("footerHelp", "AYUDA")}
            </a>
          </div>
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-primary hover:text-on-primary transition-all cursor-pointer">
              <span className="material-symbols-outlined text-sm">share</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-primary hover:text-on-primary transition-all cursor-pointer">
              <span className="material-symbols-outlined text-sm">mail</span>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
