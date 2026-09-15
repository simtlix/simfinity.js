import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { BookingCard } from "./BookingCard";

const meta: Meta<typeof BookingCard> = {
  title: "Shared/Booking/BookingCard",
  component: BookingCard,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof BookingCard>;

export const Default: Story = {
  args: {
    confirmationCode: "BK-2025-0412",
    barbershopName: "El Padrino Barbershop",
    serviceName: "Corte clásico",
    professionalName: "Martín López",
    date: "Vie 4 de abril",
    time: "10:30",
    status: "CONFIRMED",
    onView: action("onView"),
    onReschedule: action("onReschedule"),
    onCancel: action("onCancel"),
  },
};

export const Pending: Story = {
  args: {
    ...Default.args,
    status: "PENDING",
    confirmationCode: "BK-2025-0413",
  },
};

export const Completed: Story = {
  args: {
    ...Default.args,
    status: "COMPLETED",
    confirmationCode: "BK-2025-0301",
    date: "Lun 3 de marzo",
    time: "14:00",
  },
};

export const Cancelled: Story = {
  args: {
    ...Default.args,
    status: "CANCELLED",
    confirmationCode: "BK-2025-0280",
    date: "Mié 26 de febrero",
    time: "11:00",
  },
};

export const WithoutProfessional: Story = {
  args: {
    confirmationCode: "BK-2025-0414",
    barbershopName: "BarberKing",
    serviceName: "Barba completa",
    date: "Sáb 5 de abril",
    time: "16:00",
    status: "CONFIRMED",
    onView: action("onView"),
    onCancel: action("onCancel"),
  },
};

export const ViewOnly: Story = {
  args: {
    confirmationCode: "BK-2025-0200",
    barbershopName: "Studio 54 Barber",
    serviceName: "Fade moderno",
    professionalName: "Carlos Rodríguez",
    date: "Jue 20 de febrero",
    time: "09:30",
    status: "COMPLETED",
    onView: action("onView"),
  },
};
