"use client";

import { useEffect, useState, useMemo } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSimfinityClient } from "@/lib/simfinity";
import { useT } from "@/hooks/useT";
import { StarRating } from "@/components/shared/data";
import { MapView } from "@/components/shared/maps";
import { buttonVariants } from "@/components/shared/ui";
import { cn } from "@/lib/cn";

type Address = {
  street?: string | null;
  number?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};

type ContactInfo = {
  phone?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  instagramUrl?: string | null;
  facebookUrl?: string | null;
};

type BusinessHourSlot = {
  dayOfWeek?: number | null;
  openTime?: string | null;
  closeTime?: string | null;
  isClosed?: boolean | null;
};

type Barbershop = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  averageRating?: number | null;
  reviewCount?: number | null;
  address?: Address | null;
  contactInfo?: ContactInfo | null;
  businessHours?: BusinessHourSlot[] | null;
  services?: Service[] | null;
  professionals?: Professional[] | null;
  bundles?: Bundle[] | null;
  reviews?: Review[] | null;
};

type Service = {
  id: string;
  name: string;
  description?: string | null;
  price?: number | null;
  durationMinutes?: number | null;
  imageUrl?: string | null;
  category?: { id: string; name: string } | null;
};

type Professional = {
  id: string;
  name: string;
  bio?: string | null;
  photoUrl?: string | null;
  services?: { service?: { id: string; name: string } | null }[] | null;
};

type Bundle = {
  id: string;
  name: string;
  description?: string | null;
  price?: number | null;
  totalDurationMinutes?: number | null;
  services?: { service?: { id: string; name: string } | null }[] | null;
};

type Review = {
  id: string;
  rating: number;
  comment?: string | null;
  createdAt?: string | null;
  client?: {
    id: string;
    name?: string | null;
    email?: string | null;
  } | null;
};

const TAB_KEYS = ["servicios", "profesionales", "bundles", "reseñas"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const BARBERSHOP_FIELDS =
  "id name slug description logoUrl coverImageUrl latitude longitude averageRating reviewCount " +
  "address { street number city state zip country } " +
  "contactInfo { phone email whatsapp instagramUrl facebookUrl } " +
  "businessHours { dayOfWeek openTime closeTime isClosed } " +
  "services { id name description price durationMinutes imageUrl category { id name } } " +
  "professionals { id name bio photoUrl services { service { id name } } } " +
  "bundles { id name description price totalDurationMinutes services { service { id name } } } " +
  "reviews { id rating comment createdAt client { id name email } }";

function formatAddress(addr?: Address | null): string {
  if (!addr) return "";
  return [addr.street, addr.number, addr.city, addr.state]
    .filter(Boolean)
    .join(", ");
}

function ProfileSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-80 w-full bg-surface-container-high" />
      <div className="max-w-[1440px] mx-auto px-4 md:px-12 py-8">
        <div className="h-12 w-2/3 bg-surface-container-high rounded-lg mb-4" />
        <div className="h-6 w-1/3 bg-surface-container-high rounded-lg mb-4" />
        <div className="h-12 w-48 bg-surface-container-high rounded-xl" />
      </div>
    </div>
  );
}

/* ─── Tab Content Components ─── */

function ServicesContent({
  services,
  shopId,
  t,
}: {
  services: Service[];
  shopId: string;
  t: (key: string, fallback?: string) => string;
}) {
  const [selectedCategory, setSelectedCategory] = useState("Todos");

  const categories = useMemo(() => {
    const cats = new Set<string>();
    services.forEach((s) => {
      if (s.category?.name) cats.add(s.category.name);
    });
    return ["Todos", ...Array.from(cats)];
  }, [services]);

  const filtered = useMemo(() => {
    if (selectedCategory === "Todos") return services;
    return services.filter((s) => s.category?.name === selectedCategory);
  }, [services, selectedCategory]);

  if (!services.length) {
    return (
      <p className="text-on-surface/50 text-center py-8">
        {t("noServices", "No hay servicios disponibles.")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {categories.length > 2 && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                "px-5 py-2 rounded-full text-xs font-bold tracking-widest uppercase whitespace-nowrap transition-all",
                cat === selectedCategory
                  ? "bg-primary/10 border border-primary/20 text-primary"
                  : "bg-surface-container-high text-on-surface/60 hover:bg-surface-container-highest",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-4">
        {filtered.map((svc) => (
          <div
            key={svc.id}
            className="group bg-surface-container-low p-6 rounded-xl flex justify-between items-center hover:bg-surface-container-high transition-all duration-300"
          >
            <div className="space-y-1 min-w-0">
              <h3 className="text-xl font-headline italic font-semibold text-on-surface">
                {svc.name}
              </h3>
              <div className="flex items-center gap-3 text-sm text-on-surface/50">
                {svc.durationMinutes != null && (
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">
                      schedule
                    </span>
                    {svc.durationMinutes} min
                  </span>
                )}
                {svc.category?.name && (
                  <>
                    <span>•</span>
                    <span className="text-primary font-medium tracking-wide uppercase">
                      {svc.category.name}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-8 shrink-0">
              {svc.price != null && (
                <span className="text-xl font-headline text-primary font-bold">
                  $
                  {svc.price.toLocaleString("es-AR", {
                    minimumFractionDigits: 2,
                  })}
                </span>
              )}
              <Link
                href={`/book?barbershop=${shopId}&service=${svc.id}`}
                className="bg-surface-container-highest text-on-surface px-6 py-2.5 rounded-lg text-sm font-semibold border border-outline-variant/20 hover:bg-primary hover:text-on-primary transition-all"
              >
                {t("book", "Agendar")}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfessionalsContent({
  professionals,
  t,
}: {
  professionals: Professional[];
  t: (key: string, fallback?: string) => string;
}) {
  if (!professionals.length) {
    return (
      <p className="text-on-surface/50 text-center py-8">
        {t("noProfessionals", "No hay profesionales disponibles.")}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {professionals.map((pro) => (
        <div
          key={pro.id}
          className="bg-surface-container-low rounded-xl overflow-hidden hover:bg-surface-container-high transition-all group"
        >
          <div className="relative aspect-square overflow-hidden">
            {pro.photoUrl ? (
              <Image
                src={pro.photoUrl}
                alt={pro.name}
                fill
                unoptimized
                sizes="(max-width: 768px) 50vw, 33vw"
                className="object-cover group-hover:scale-105 transition-transform duration-500"
              />
            ) : (
              <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-on-surface/20">
                  person
                </span>
              </div>
            )}
          </div>
          <div className="p-4 space-y-1">
            <h3 className="font-headline italic font-semibold text-on-surface">
              {pro.name}
            </h3>
            {pro.bio && (
              <p className="text-xs text-on-surface/50 line-clamp-2">
                {pro.bio}
              </p>
            )}
            {pro.services && pro.services.length > 0 && (
              <p className="text-xs text-primary font-medium">
                {pro.services.length} {t("services", "servicios")}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BundlesContent({
  bundles,
  shopId,
  t,
}: {
  bundles: Bundle[];
  shopId: string;
  t: (key: string, fallback?: string) => string;
}) {
  if (!bundles.length) {
    return (
      <p className="text-on-surface/50 text-center py-8">
        {t("noBundles", "No hay paquetes disponibles.")}
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {bundles.map((b) => (
        <div
          key={b.id}
          className="group bg-surface-container-low p-6 rounded-xl flex justify-between items-start hover:bg-surface-container-high transition-all duration-300"
        >
          <div className="space-y-2 min-w-0 flex-1">
            <h3 className="text-xl font-headline italic font-semibold text-on-surface">
              {b.name}
            </h3>
            {b.description && (
              <p className="text-sm text-on-surface/50">{b.description}</p>
            )}
            {b.services && b.services.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {b.services.map((item, i) => (
                  <span
                    key={item.service?.id ?? i}
                    className="px-2.5 py-0.5 bg-primary/10 rounded-full text-xs font-semibold text-primary"
                  >
                    {item.service?.name ?? "Servicio"}
                  </span>
                ))}
              </div>
            )}
            {b.totalDurationMinutes != null && (
              <p className="text-xs text-outline">
                {b.totalDurationMinutes} min en total
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0 ml-4">
            <span className="text-xl font-headline text-primary font-bold">
              ${b.price?.toLocaleString("es-AR", { minimumFractionDigits: 2 }) ?? "—"}
            </span>
            <Link
              href={`/book?barbershop=${shopId}&bundle=${b.id}`}
              className="bg-surface-container-highest text-on-surface px-6 py-2.5 rounded-lg text-sm font-semibold border border-outline-variant/20 hover:bg-primary hover:text-on-primary transition-all"
            >
              {t("book", "Agendar")}
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewsContent({
  reviews,
  t,
}: {
  reviews: Review[];
  t: (key: string, fallback?: string) => string;
}) {
  if (!reviews.length) {
    return (
      <p className="text-on-surface/50 text-center py-8">
        {t("noReviews", "Aún no hay reseñas.")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {reviews.map((review) => {
        const userName =
          review.client?.name ||
          review.client?.email ||
          "Anónimo";
        const dateStr = review.createdAt
          ? new Date(review.createdAt).toLocaleDateString("es-AR", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "";

        return (
          <div
            key={review.id}
            className="bg-surface-container-low p-6 rounded-xl space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center">
                  <span className="material-symbols-outlined text-on-surface/40">
                    person
                  </span>
                </div>
                <div>
                  <p className="font-medium text-on-surface text-sm">
                    {userName}
                  </p>
                  {dateStr && (
                    <p className="text-xs text-on-surface/40">{dateStr}</p>
                  )}
                </div>
              </div>
              <StarRating rating={review.rating} size="sm" />
            </div>
            {review.comment && (
              <p className="text-on-surface/70 text-sm leading-relaxed">
                {review.comment}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Sidebar Components ─── */

function LocationCard({
  shop,
  address,
  t,
}: {
  shop: Barbershop;
  address: string;
  t: (key: string, fallback?: string) => string;
}) {
  const [geocoded, setGeocoded] = useState<[number, number] | null>(null);

  const hasDbCoords = shop.latitude != null && shop.longitude != null;

  useEffect(() => {
    if (hasDbCoords || !address) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
        );
        const data = await res.json();
        if (!cancelled && data.length > 0) {
          setGeocoded([parseFloat(data[0].lat), parseFloat(data[0].lon)]);
        }
      } catch {
        /* geocoding is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [hasDbCoords, address]);

  const coords: [number, number] | null = hasDbCoords
    ? [shop.latitude!, shop.longitude!]
    : geocoded;

  if (!coords && !address) return null;

  return (
    <div className="bg-surface-container-low rounded-xl overflow-hidden shadow-xl border border-outline-variant/5">
      {coords && (
        <div className="h-48">
          <MapView
            center={coords}
            zoom={15}
            markers={[
              { lat: coords[0], lng: coords[1], label: shop.name },
            ]}
            className="w-full h-full"
          />
        </div>
      )}
      {address && (
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-primary">
              location_on
            </span>
            <div>
              <p className="font-bold text-on-surface">
                {shop.address?.street} {shop.address?.number}
              </p>
              <p className="text-sm text-on-surface/50">
                {shop.address?.city}, {shop.address?.state}
              </p>
            </div>
          </div>
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-3 bg-surface-container-high rounded-lg text-on-surface/80 text-sm font-medium hover:bg-surface-container-highest transition-all flex justify-center items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">
              directions
            </span>
            {t("directions", "Cómo llegar")}
          </a>
        </div>
      )}
    </div>
  );
}

function BusinessHoursCard({
  hours,
  t,
}: {
  hours: BusinessHourSlot[];
  t: (key: string, fallback?: string) => string;
}) {
  const todayDow = new Date().getDay();

  const sorted = useMemo(() => {
    return [...hours].sort((a, b) => {
      const orderA = a.dayOfWeek === 0 ? 7 : (a.dayOfWeek ?? 99);
      const orderB = b.dayOfWeek === 0 ? 7 : (b.dayOfWeek ?? 99);
      return orderA - orderB;
    });
  }, [hours]);

  if (!sorted.length) return null;

  return (
    <div className="bg-surface-container-low p-6 rounded-xl border border-outline-variant/5 space-y-6">
      <h4 className="font-headline italic text-xl font-bold text-on-surface">
        {t("hours", "Horarios")}
      </h4>
      <div className="space-y-3">
        {sorted.map((h) => {
          const dow = h.dayOfWeek ?? 0;
          const isToday = dow === todayDow;
          const dayName = t(`dayLong${dow}`, "");

          if (h.isClosed) {
            return (
              <div
                key={dow}
                className={cn(
                  "flex justify-between text-sm",
                  isToday
                    ? "text-primary font-bold bg-primary/5 p-2 rounded-md -mx-2"
                    : "text-error/60",
                )}
              >
                <span>
                  {dayName}
                  {isToday ? ` (${t("today", "Hoy")})` : ""}
                </span>
                <span>{t("closed", "Cerrado")}</span>
              </div>
            );
          }

          return (
            <div
              key={dow}
              className={cn(
                "flex justify-between text-sm",
                isToday
                  ? "text-primary font-bold bg-primary/5 p-2 rounded-md -mx-2"
                  : "text-on-surface/50",
              )}
            >
              <span>
                {dayName}
                {isToday ? ` (${t("today", "Hoy")})` : ""}
              </span>
              <span>
                {h.openTime} - {h.closeTime}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContactCard({
  contactInfo,
  t,
}: {
  contactInfo: ContactInfo;
  t: (key: string, fallback?: string) => string;
}) {
  if (!contactInfo.phone && !contactInfo.email && !contactInfo.whatsapp) {
    return null;
  }

  return (
    <div className="bg-surface-container-low p-6 rounded-xl border border-outline-variant/5 space-y-4">
      <h4 className="font-headline italic text-xl font-bold text-on-surface">
        {t("contact", "Contacto")}
      </h4>
      <div className="space-y-3">
        {contactInfo.phone && (
          <a
            href={`tel:${contactInfo.phone}`}
            className="flex items-center gap-3 text-sm text-on-surface hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-on-surface-variant">
              call
            </span>
            {contactInfo.phone}
          </a>
        )}
        {contactInfo.email && (
          <a
            href={`mailto:${contactInfo.email}`}
            className="flex items-center gap-3 text-sm text-on-surface hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-on-surface-variant">
              mail
            </span>
            {contactInfo.email}
          </a>
        )}
        {contactInfo.whatsapp && (
          <a
            href={`https://wa.me/${contactInfo.whatsapp.replace(/\D/g, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 text-sm text-on-surface hover:text-[#25D366] transition-colors"
          >
            <span className="material-symbols-outlined text-[#25D366]">
              chat
            </span>
            {contactInfo.whatsapp}
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page Component ─── */

export default function BarbershopProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const client = useSimfinityClient();
  const t = useT("barbershop");

  const [shop, setShop] = useState<Barbershop | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("servicios");

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const results = await client
          .find("barbershop")
          .where("slug", "EQ", decodeURIComponent(slug))
          .fields(BARBERSHOP_FIELDS)
          .exec();
        const items = Array.isArray(results) ? results : [];
        if (!cancelled && items.length > 0) setShop(items[0] as Barbershop);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Error loading barbershop",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, slug]);

  const services = shop?.services ?? [];
  const professionals = shop?.professionals ?? [];
  const bundles = shop?.bundles ?? [];
  const reviews = shop?.reviews ?? [];

  if (loading) return <ProfileSkeleton />;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="material-symbols-outlined text-5xl text-error">
          error
        </span>
        <p className="text-on-surface/70">{error}</p>
        <Link href="/search" className="text-primary underline text-sm">
          {t("backToSearch", "Volver a buscar")}
        </Link>
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="material-symbols-outlined text-5xl text-on-surface/30">
          storefront
        </span>
        <p className="text-on-surface/70">
          {t("notFound", "Barbería no encontrada")}
        </p>
        <Link href="/search" className="text-primary underline text-sm">
          {t("backToSearch", "Volver a buscar")}
        </Link>
      </div>
    );
  }

  const address = formatAddress(shop.address);

  const tabLabels: Record<TabKey, string> = {
    servicios: t("tabs.services", "Servicios"),
    profesionales: t("tabs.professionals", "Profesionales"),
    bundles: t("tabs.bundles", "Bundles"),
    reseñas: t("tabs.reviews", "Reseñas"),
  };

  return (
    <>
      {/* Hero Section */}
      <section className="relative">
        <div className="relative h-80 w-full overflow-hidden">
          {shop.coverImageUrl ? (
            <Image
              src={shop.coverImageUrl}
              alt={shop.name}
              fill
              priority
              unoptimized
              sizes="100vw"
              className="object-cover"
            />
          ) : (
            <div className="w-full h-full bg-surface-container-high" />
          )}
        </div>
        {shop.logoUrl && (
          <div className="absolute -bottom-10 left-4 md:left-12">
            <div className="relative w-24 h-24 rounded-full border-4 border-background bg-surface-container-low overflow-hidden shadow-2xl">
              <Image
                src={shop.logoUrl}
                alt={`${shop.name} logo`}
                fill
                unoptimized
                sizes="96px"
                className="object-cover"
              />
            </div>
          </div>
        )}
      </section>

      {/* Main content area */}
      <div
        className={cn(
          "max-w-[1440px] mx-auto px-4 md:px-12 pb-12 flex flex-col lg:flex-row gap-10",
          shop.logoUrl ? "pt-14" : "pt-8",
        )}
      >
        {/* Left Column */}
        <section className="w-full lg:w-[70%] space-y-8">
          {/* Profile Info & Actions */}
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
            <div className="space-y-2">
              <h1 className="font-headline text-4xl md:text-5xl font-bold italic tracking-tight text-on-surface">
                {shop.name}
              </h1>
              <div className="flex items-center gap-2 flex-wrap">
                {shop.averageRating != null && (
                  <>
                    <StarRating rating={shop.averageRating} />
                    <span className="font-medium text-primary">
                      {shop.averageRating.toFixed(1)}
                    </span>
                    {shop.reviewCount != null && (
                      <span className="text-on-surface/40 text-sm">
                        ({shop.reviewCount.toLocaleString()}{" "}
                        {t("reviews", "reseñas")})
                      </span>
                    )}
                    {(shop.address?.city || shop.address?.state) && (
                      <span className="mx-2 text-on-surface/20">|</span>
                    )}
                  </>
                )}
                {(shop.address?.city || shop.address?.state) && (
                  <span className="text-on-surface/60 text-sm">
                    {[shop.address?.city, shop.address?.state]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-4 max-w-full">
              <button className="bg-surface-container-high p-4 rounded-xl text-primary hover:bg-surface-container-highest transition-all active:scale-95">
                <span className="material-symbols-outlined">favorite</span>
              </button>
              <Link
                href={`/book?barbershop=${shop.id}`}
                className={cn(buttonVariants({ variant: "gold", size: "lg" }), "no-underline px-4 sm:px-10")}
              >
                <span className="material-symbols-outlined">
                  calendar_today
                </span>
                {t("bookNow", "Reservar Ahora")}
              </Link>
            </div>
          </div>

          {/* Horizontal Tabs */}
          <div className="border-b border-outline-variant/10">
            <div className="flex gap-6 sm:gap-10 overflow-x-auto font-body text-sm font-medium tracking-wide">
              {TAB_KEYS.map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    "pb-4 shrink-0 whitespace-nowrap transition-colors",
                    activeTab === key
                      ? "text-primary border-b-2 border-primary"
                      : "text-on-surface/50 hover:text-on-surface",
                  )}
                >
                  {tabLabels[key]}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="py-2">
            {activeTab === "servicios" && (
              <ServicesContent
                services={services}
                shopId={shop.id}
                t={t}
              />
            )}
            {activeTab === "profesionales" && (
              <ProfessionalsContent professionals={professionals} t={t} />
            )}
            {activeTab === "bundles" && (
              <BundlesContent
                bundles={bundles}
                shopId={shop.id}
                t={t}
              />
            )}
            {activeTab === "reseñas" && (
              <ReviewsContent reviews={reviews} t={t} />
            )}
          </div>
        </section>

        {/* Right Sidebar */}
        <aside className="w-full lg:w-[30%] space-y-8 lg:sticky lg:top-24 self-start">
          <LocationCard shop={shop} address={address} t={t} />

          {shop.businessHours && shop.businessHours.length > 0 && (
            <BusinessHoursCard hours={shop.businessHours} t={t} />
          )}

          {shop.contactInfo && <ContactCard contactInfo={shop.contactInfo} t={t} />}
        </aside>
      </div>

      {/* Mobile Floating CTA */}
      <div className="md:hidden fixed bottom-20 right-6 z-40">
        <Link
          href={`/book?barbershop=${shop.id}`}
          className="w-16 h-16 rounded-full bg-primary text-on-primary shadow-2xl flex items-center justify-center"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontVariationSettings: "'opsz' 40" }}
          >
            calendar_today
          </span>
        </Link>
      </div>
    </>
  );
}
