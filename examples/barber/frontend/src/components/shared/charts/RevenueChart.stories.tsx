import type { Meta, StoryObj } from "@storybook/react";
import { RevenueChart } from "./RevenueChart";

const meta: Meta<typeof RevenueChart> = {
  title: "Shared/Charts/RevenueChart",
  component: RevenueChart,
  decorators: [
    (Story) => (
      <div style={{ width: "100%", maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof RevenueChart>;

const weeklyData = [
  { date: "Lun", revenue: 1200 },
  { date: "Mar", revenue: 980 },
  { date: "Mié", revenue: 1540 },
  { date: "Jue", revenue: 1780 },
  { date: "Vie", revenue: 2350 },
  { date: "Sáb", revenue: 3100 },
  { date: "Dom", revenue: 650 },
];

export const Default: Story = {
  args: {
    data: weeklyData,
  },
};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const SingleDataPoint: Story = {
  args: {
    data: [{ date: "Hoy", revenue: 2400 }],
  },
};

export const MonthlyTrend: Story = {
  args: {
    data: [
      { date: "Ene", revenue: 18500 },
      { date: "Feb", revenue: 21200 },
      { date: "Mar", revenue: 19800 },
      { date: "Abr", revenue: 24100 },
      { date: "May", revenue: 26300 },
      { date: "Jun", revenue: 28750 },
      { date: "Jul", revenue: 31200 },
      { date: "Ago", revenue: 29400 },
    ],
  },
};
