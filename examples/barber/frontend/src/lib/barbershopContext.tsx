"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useSimfinityClient } from "@/lib/simfinity";
import { useAuth } from "@/lib/authContext";

export type BarbershopInfo = {
  id: string;
  name: string;
  slug: string;
  state?: string;
};

type BarbershopContextValue = {
  barbershops: BarbershopInfo[];
  selectedBarbershop: BarbershopInfo | null;
  setSelectedBarbershop: (shop: BarbershopInfo) => void;
  loading: boolean;
};

const BarbershopContext = createContext<BarbershopContextValue>({
  barbershops: [],
  selectedBarbershop: null,
  setSelectedBarbershop: () => {},
  loading: true,
});

const STORAGE_KEY = "selectedBarbershopId";

export function BarbershopProvider({ children }: { children: ReactNode }) {
  const client = useSimfinityClient();
  const { user } = useAuth();
  const [barbershops, setBarbershops] = useState<BarbershopInfo[]>([]);
  const [selectedBarbershop, setSelected] = useState<BarbershopInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    (async () => {
      try {
        const results = (await client
          .find("barbershop")
          .where("owner", [{ path: "id", operator: "EQ", value: user.id }])
          .fields("id name slug state")
          .exec()) as BarbershopInfo[];

        if (cancelled) return;
        setBarbershops(results);

        const savedId = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
        const saved = savedId ? results.find((s) => s.id === savedId) : null;
        setSelected(saved ?? results[0] ?? null);
      } catch {
        if (!cancelled) setBarbershops([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [client, user?.id]);

  const setSelectedBarbershop = useCallback((shop: BarbershopInfo) => {
    setSelected(shop);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, shop.id);
    }
  }, []);

  return (
    <BarbershopContext.Provider value={{ barbershops, selectedBarbershop, setSelectedBarbershop, loading }}>
      {children}
    </BarbershopContext.Provider>
  );
}

export function useBarbershop() {
  return useContext(BarbershopContext);
}
