import type { Meta, StoryObj } from "@storybook/react";
import { BookingsByServiceChart } from "./BookingsByServiceChart";

const meta: Meta<typeof BookingsByServiceChart> = {
  title: "Shared/Charts/BookingsByServiceChart",
  component: BookingsByServiceChart,
  decorators: [
    (Story) => (
      <div style={{ width: "100%", maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof BookingsByServiceChart>;

const serviceData = [
  { service: "Corte clásico", count: 142 },
  { service: "Barba", count: 87 },
  { service: "Corte + Barba", count: 115 },
  { service: "Coloración", count: 34 },
  { service: "Alisado", count: 21 },
];

export const Default: Story = {
  args: {
    data: serviceData,
  },
};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const SingleService: Story = {
  args: {
    data: [{ service: "Corte clásico", count: 58 }],
  },
};

export const ManyServices: Story = {
  args: {
    data: [
      { service: "Corte clásico", count: 142 },
      { service: "Barba", count: 87 },
      { service: "Corte + Barba", count: 115 },
      { service: "Coloración", count: 34 },
      { service: "Alisado", count: 21 },
      { service: "Tratamiento capilar", count: 15 },
      { service: "Diseño de cejas", count: 42 },
      { service: "Afeitado clásico", count: 63 },
    ],
  },
};
