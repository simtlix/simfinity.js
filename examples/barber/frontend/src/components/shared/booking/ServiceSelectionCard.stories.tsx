import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { ServiceSelectionCard } from "./ServiceSelectionCard";

const meta: Meta<typeof ServiceSelectionCard> = {
  title: "Shared/Booking/ServiceSelectionCard",
  component: ServiceSelectionCard,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof ServiceSelectionCard>;

export const Default: Story = {
  args: {
    name: "Corte clásico",
    description: "Corte de pelo tradicional con máquina y tijera, incluye lavado.",
    duration: 30,
    price: 5500,
    selected: false,
    onToggle: action("onToggle"),
  },
};

export const Selected: Story = {
  args: {
    ...Default.args,
    selected: true,
  },
};

export const WithoutDescription: Story = {
  args: {
    name: "Barba completa",
    duration: 20,
    price: 4000,
    selected: false,
    onToggle: action("onToggle"),
  },
};

export const Disabled: Story = {
  args: {
    name: "Alisado de keratina",
    description: "Tratamiento profesional de alisado con keratina brasileña.",
    duration: 90,
    price: 18000,
    selected: false,
    disabled: true,
    onToggle: action("onToggle"),
  },
};

export const LongContent: Story = {
  args: {
    name: "Corte + Barba + Cejas + Tratamiento capilar premium",
    description:
      "Combo completo que incluye corte de pelo personalizado, perfilado de barba con navaja, diseño de cejas y un tratamiento capilar hidratante con productos de primera línea.",
    duration: 120,
    price: 15500,
    selected: false,
    onToggle: action("onToggle"),
  },
};
