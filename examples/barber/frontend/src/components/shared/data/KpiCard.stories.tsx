import type { Meta, StoryObj } from "@storybook/react";
import { KpiCard } from "./KpiCard";

const meta: Meta<typeof KpiCard> = {
  title: "Shared/Data/KpiCard",
  component: KpiCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 280 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof KpiCard>;

export const Default: Story = {
  args: {
    label: "Turnos hoy",
    value: 24,
    icon: "calendar_month",
  },
};

export const WithPositiveTrend: Story = {
  args: {
    label: "Ingresos del mes",
    value: "$28.750",
    icon: "payments",
    trend: { value: "+12%", positive: true },
  },
};

export const WithNegativeTrend: Story = {
  args: {
    label: "Cancelaciones",
    value: 7,
    icon: "event_busy",
    trend: { value: "+3 vs ayer", positive: false },
  },
};

export const NoIcon: Story = {
  args: {
    label: "Nuevos clientes",
    value: 18,
    trend: { value: "+22%", positive: true },
  },
};

export const Gallery: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
      <KpiCard label="Turnos hoy" value={24} icon="calendar_month" trend={{ value: "+8%", positive: true }} />
      <KpiCard label="Ingresos del mes" value="$28.750" icon="payments" trend={{ value: "+12%", positive: true }} />
      <KpiCard label="Barberos activos" value={6} icon="content_cut" />
      <KpiCard label="Cancelaciones" value={3} icon="event_busy" trend={{ value: "-15%", positive: true }} />
    </div>
  ),
};
