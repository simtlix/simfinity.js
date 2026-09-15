import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { TimeSlotGrid } from "./TimeSlotGrid";

const morningSlots = [
  { time: "09:00", available: true },
  { time: "09:30", available: true },
  { time: "10:00", available: false },
  { time: "10:30", available: true },
  { time: "11:00", available: true },
  { time: "11:30", available: false },
  { time: "12:00", available: true },
  { time: "12:30", available: true },
];

const fullDaySlots = [
  ...morningSlots,
  { time: "14:00", available: true },
  { time: "14:30", available: true },
  { time: "15:00", available: false },
  { time: "15:30", available: false },
  { time: "16:00", available: true },
  { time: "16:30", available: true },
  { time: "17:00", available: true },
  { time: "17:30", available: false },
  { time: "18:00", available: true },
  { time: "18:30", available: true },
];

const meta: Meta<typeof TimeSlotGrid> = {
  title: "Shared/Booking/TimeSlotGrid",
  component: TimeSlotGrid,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof TimeSlotGrid>;

export const Default: Story = {
  args: {
    slots: morningSlots,
    selectedTime: null,
    onSelect: action("onSelect"),
  },
};

export const WithSelection: Story = {
  args: {
    slots: morningSlots,
    selectedTime: "10:30",
    onSelect: action("onSelect"),
  },
};

export const FullDay: Story = {
  args: {
    slots: fullDaySlots,
    selectedTime: "16:00",
    onSelect: action("onSelect"),
  },
};

export const AllUnavailable: Story = {
  args: {
    slots: morningSlots.map((s) => ({ ...s, available: false })),
    selectedTime: null,
    onSelect: action("onSelect"),
  },
};

export const AllAvailable: Story = {
  args: {
    slots: morningSlots.map((s) => ({ ...s, available: true })),
    selectedTime: null,
    onSelect: action("onSelect"),
  },
};
