"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { useState } from "react";

interface BookingsByServiceChartProps {
  data: { service: string; count: number }[];
  loading?: boolean;
}

export function BookingsByServiceChart({ data, loading }: BookingsByServiceChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center rounded-2xl bg-surface-container-low p-6">
        <span className="material-symbols-outlined animate-spin text-3xl text-primary">
          progress_activity
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-surface-container-low p-6">
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data}>
          <CartesianGrid stroke="#4d463a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="service"
            tick={{ fill: "#998f81", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#998f81", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-surface-container-high, #2c2924)",
              border: "1px solid rgba(77,70,58,.2)",
              borderRadius: 12,
              color: "var(--color-on-surface, #ece0d0)",
            }}
            labelStyle={{ color: "var(--color-on-surface, #ece0d0)" }}
            formatter={(value) => [String(value), "Bookings"]}
            cursor={{ fill: "rgba(230,196,135,.08)" }}
          />
          <Bar
            dataKey="count"
            radius={[6, 6, 0, 0]}
            onMouseEnter={(_, index) => setActiveIndex(index)}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {data.map((_, index) => (
              <Cell
                key={index}
                fill={activeIndex === index ? "#c9a96e" : "#e6c487"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
