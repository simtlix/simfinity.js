"use client";

import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSimfinityClient } from "@/lib/simfinity";
import { RequireAuth } from "@/lib/requireAuth";
import { useT } from "@/hooks/useT";
import { EmptyState } from "@/components/shared/page";
import { ConfirmModal } from "@/components/shared/modals";
import { Button } from "@/components/shared/ui";

type FavoriteBarbershop = {
  id: string;
  name?: string;
  slug?: string;
  coverImageUrl?: string | null;
  address?: {
    street?: string;
    number?: string;
    city?: string;
  } | null;
  averageRating?: number | null;
  description?: string | null;
};

type FavoriteData = {
  id: string;
  barbershop?: FavoriteBarbershop;
};

function buildAddress(shop?: FavoriteBarbershop): string {
  if (!shop) return "—";
  const parts: string[] = [];
  if (shop.address?.street) {
    parts.push(
      shop.address.number
        ? `${shop.address.street} ${shop.address.number}`
        : shop.address.street,
    );
  }
  if (shop.address?.city) parts.push(shop.address.city);
  return parts.join(", ") || "—";
}

function FavoritesContent() {
  const router = useRouter();
  const client = useSimfinityClient();
  const t = useT("favorites");

  const [favorites, setFavorites] = useState<FavoriteData[]>([]);
  const [loading, setLoading] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<FavoriteData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await client
          .find("favorite")
          .fields("id barbershop { id name slug coverImageUrl averageRating description address { street number city } }")
          .exec();
        if (!cancelled) setFavorites(result as FavoriteData[]);
      } catch {
        if (!cancelled) setFavorites([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const handleRemove = useCallback(
    async (fav: FavoriteData) => {
      try {
        await client.delete("favorite", fav.id, "id");
        setFavorites((prev) => prev.filter((f) => f.id !== fav.id));
      } catch {
        /* silent */
      } finally {
        setRemoveTarget(null);
      }
    },
    [client],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-12 py-8">
      <h1 className="font-headline italic text-4xl lg:text-5xl text-on-surface mb-2 leading-tight">
        {t("title", "Mis Favoritos")}
      </h1>
      <p className="text-on-surface-variant text-sm mb-10">
        {t(
          "subtitle",
          "Accedé rápidamente a tus barberías y salones de confianza.",
        )}
      </p>

      {favorites.length === 0 ? (
        <EmptyState
          icon="favorite"
          title={t("noFavorites", "No tenés favoritos guardados")}
          message={t(
            "noFavoritesMessage",
            "Explorá barberías y guardá las que más te gusten.",
          )}
          actionLabel={t("explore", "Explorar Barberías")}
          onAction={() => router.push("/search")}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {favorites.map((fav) => {
            const shop = fav.barbershop;
            return (
              <div
                key={fav.id}
                className="bg-surface-container-low rounded-2xl border border-outline-variant/10 overflow-hidden group"
              >
                {/* Image */}
                <div className="relative h-44 bg-surface-container-high overflow-hidden">
                  {shop?.coverImageUrl ? (
                    <Image
                      src={shop.coverImageUrl}
                      alt={shop.name ?? ""}
                      fill
                      unoptimized
                      sizes="(max-width: 768px) 100vw, 33vw"
                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="material-symbols-outlined text-on-surface-variant/30 text-5xl">
                        storefront
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(fav)}
                    className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center hover:bg-black/60 transition-colors"
                  >
                    <span
                      className="material-symbols-outlined text-red-400 text-lg"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      favorite
                    </span>
                  </button>
                </div>

                {/* Info */}
                <div className="p-5">
                  <h3 className="font-semibold text-on-surface text-lg mb-1">
                    {shop?.name ?? "—"}
                  </h3>
                  <p className="text-sm text-on-surface-variant mb-3 flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">
                      location_on
                    </span>
                    {buildAddress(shop)}
                  </p>

                  {shop?.averageRating != null && shop.averageRating > 0 && (
                    <div className="flex items-center gap-1 mb-4">
                      <span
                        className="material-symbols-outlined text-primary text-sm"
                        style={{ fontVariationSettings: "'FILL' 1" }}
                      >
                        star
                      </span>
                      <span className="text-sm font-semibold text-on-surface">
                        {shop.averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="gold"
                    size="form"
                    className="w-full py-2.5 text-on-primary"
                    onClick={() =>
                      router.push(
                        `/b/${shop?.slug ?? shop?.id ?? ""}`,
                      )
                    }
                  >
                    {t("reserve", "Reservar")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && handleRemove(removeTarget)}
        title={t("removeFavorite", "Quitar de favoritos")}
        message={t(
          "removeFavoriteMessage",
          "¿Querés quitar esta barbería de tus favoritos?",
        )}
        confirmLabel={t("remove", "Quitar")}
        cancelLabel={t("cancel", "Cancelar")}
        variant="danger"
      />
    </div>
  );
}

export default function FavoritesPage() {
  return (
    <RequireAuth role="CLIENT">
      <FavoritesContent />
    </RequireAuth>
  );
}
