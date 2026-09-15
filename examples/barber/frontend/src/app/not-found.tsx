"use client";

import Image from "next/image";
import Link from "next/link";
import { buttonVariants } from "@/components/shared/ui";
import { cn } from "@/lib/cn";
import { useT } from "@/hooks/useT";
import { PLACEHOLDER_NOT_FOUND_ILLUSTRATION } from "@/lib/placeholders";

/**
 * Global 404 — uses static SVG from /public/placeholders/ so assets resolve locally
 * (avoids broken image requests in the browser network console).
 */
export default function NotFound() {
  const t = useT("common");

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 py-16 bg-background text-on-surface">
      <Image
        src={PLACEHOLDER_NOT_FOUND_ILLUSTRATION}
        alt=""
        width={480}
        height={320}
        priority
        className="max-w-full h-auto w-[min(100%,480px)] rounded-2xl border border-outline-variant/15 shadow-lg"
      />
      <h1 className="mt-10 font-headline text-3xl md:text-4xl italic font-bold text-on-surface text-center">
        {t("notFoundTitle", "Página no encontrada")}
      </h1>
      <p className="mt-3 text-on-surface-variant text-center max-w-md text-sm">
        {t(
          "notFoundMessage",
          "La página que buscás no existe o fue movida.",
        )}
      </p>
      <Link href="/" className={cn(buttonVariants({ variant: "gold", size: "md" }), "mt-8 no-underline")}>
        {t("goHome", "Ir al inicio")}
      </Link>
    </div>
  );
}
