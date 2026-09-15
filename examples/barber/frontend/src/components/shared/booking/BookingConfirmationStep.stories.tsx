import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { action } from "storybook/actions";
import { BookingConfirmationStep } from "./BookingConfirmationStep";

const meta: Meta<typeof BookingConfirmationStep> = {
  title: "Shared/Booking/BookingConfirmationStep",
  component: BookingConfirmationStep,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof BookingConfirmationStep>;

export const Default: Story = {
  args: {
    confirmationCode: "BBK-4F2A",
    barbershopName: "The Editorial",
    onViewBookings: action("onViewBookings"),
  },
};

export const LongCode: Story = {
  args: {
    confirmationCode: "TGR-8K2M-X9",
    barbershopName: "Barba Roja Studio",
    onViewBookings: action("onViewBookings"),
  },
};
