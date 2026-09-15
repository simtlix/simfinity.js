import type { Meta, StoryObj } from "@storybook/react";
import { BookingSummaryCard } from "./BookingSummaryCard";

const meta: Meta<typeof BookingSummaryCard> = {
  title: "Shared/Booking/BookingSummaryCard",
  component: BookingSummaryCard,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof BookingSummaryCard>;

export const Default: Story = {
  args: {
    barbershopName: "El Padrino Barbershop",
    services: [
      { name: "Corte clásico", price: 5500, duration: 30 },
      { name: "Barba completa", price: 4000, duration: 20 },
    ],
    professional: "Martín López",
    date: "Viernes 4 de abril, 2025",
    time: "10:30",
    totalPrice: 9500,
  },
};

export const SingleService: Story = {
  args: {
    barbershopName: "BarberKing",
    services: [{ name: "Fade moderno", price: 6000, duration: 40 }],
    professional: "Carlos Rodríguez",
    date: "Sábado 5 de abril, 2025",
    time: "14:00",
    totalPrice: 6000,
  },
};

export const WithoutProfessional: Story = {
  args: {
    barbershopName: "El Padrino Barbershop",
    services: [{ name: "Corte clásico", price: 5500, duration: 30 }],
    totalPrice: 5500,
  },
};

export const PartialInfo: Story = {
  args: {
    barbershopName: "El Padrino Barbershop",
    services: [
      { name: "Corte clásico", price: 5500, duration: 30 },
      { name: "Cejas", price: 2000, duration: 10 },
    ],
    professional: "Martín López",
    totalPrice: 7500,
  },
};

export const ManyServices: Story = {
  args: {
    barbershopName: "Studio 54 Barber",
    services: [
      { name: "Corte clásico", price: 5500, duration: 30 },
      { name: "Barba completa", price: 4000, duration: 20 },
      { name: "Cejas", price: 2000, duration: 10 },
      { name: "Tratamiento capilar", price: 3500, duration: 15 },
    ],
    professional: "Luciano Fernández",
    date: "Lunes 7 de abril, 2025",
    time: "09:00",
    totalPrice: 15000,
  },
};
