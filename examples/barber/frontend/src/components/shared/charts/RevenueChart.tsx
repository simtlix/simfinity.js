"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

interface RevenueChartProps {
  data: { date: string; revenue: number }[];
  loading?: boolean;
}

export function RevenueChart({ data, loading }: RevenueChartProps) {
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
        <LineChart data={data}>
          <CartesianGrid stroke="#4d463a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#998f81", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#998f81", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-surface-container-high, #2c2924)",
              border: "1px solid rgba(77,70,58,.2)",
              borderRadius: 12,
              color: "var(--color-on-surface, #ece0d0)",
            }}
            labelStyle={{ color: "var(--color-on-surface, #ece0d0)" }}
            formatter={(value) => [`$${Number(value).toLocaleString()}`, "Revenue"]}
          />
          <Line
            type="monotone"
            dataKey="revenue"
            stroke="#e6c487"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: "#e6c487", stroke: "#1c1a16", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
