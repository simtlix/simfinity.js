import type { Meta, StoryObj } from "@storybook/react";
import { Breadcrumb } from "./Breadcrumb";

const meta: Meta<typeof Breadcrumb> = {
  title: "Shared/Page/Breadcrumb",
  component: Breadcrumb,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Breadcrumb>;

export const Default: Story = {
  args: {
    items: [
      { label: "Turnos", href: "/dashboard/bookings" },
      { label: "Detalle" },
    ],
  },
};

export const ThreeLevels: Story = {
  args: {
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Servicios", href: "/dashboard/services" },
      { label: "Editar" },
    ],
  },
};

export const SingleItem: Story = {
  args: {
    items: [{ label: "Inicio" }],
  },
};
