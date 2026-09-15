import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import {
  BusinessHoursEditor,
  type BusinessHourSlot,
} from "./BusinessHoursEditor";

const meta: Meta<typeof BusinessHoursEditor> = {
  title: "Shared/Hours/BusinessHoursEditor",
  component: BusinessHoursEditor,
};
export default meta;
type Story = StoryObj<typeof BusinessHoursEditor>;

const defaultSlots: BusinessHourSlot[] = [
  { dayOfWeek: 0, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 1, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 2, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 3, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 4, openTime: "10:00", closeTime: "22:00", isClosed: false },
  { dayOfWeek: 5, openTime: "10:00", closeTime: "18:00", isClosed: false },
  { dayOfWeek: 6, openTime: "09:00", closeTime: "18:00", isClosed: true },
];

const withBreaksSlots: BusinessHourSlot[] = [
  {
    dayOfWeek: 0,
    openTime: "09:00",
    closeTime: "20:00",
    isClosed: false,
    breakStartTime: "13:00",
    breakEndTime: "14:00",
  },
  {
    dayOfWeek: 1,
    openTime: "09:00",
    closeTime: "20:00",
    isClosed: false,
    breakStartTime: "13:00",
    breakEndTime: "14:00",
  },
  { dayOfWeek: 2, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 3, openTime: "09:00", closeTime: "20:00", isClosed: false },
  { dayOfWeek: 4, openTime: "10:00", closeTime: "22:00", isClosed: false },
  { dayOfWeek: 5, openTime: "10:00", closeTime: "18:00", isClosed: false },
  { dayOfWeek: 6, openTime: "09:00", closeTime: "18:00", isClosed: true },
];

export const Default: Story = {
  render: (args) => {
    const [slots, setSlots] = useState(args.value);
    return <BusinessHoursEditor {...args} value={slots} onChange={setSlots} />;
  },
  args: {
    value: defaultSlots,
  },
};

export const WithBreaks: Story = {
  render: (args) => {
    const [slots, setSlots] = useState(args.value);
    return <BusinessHoursEditor {...args} value={slots} onChange={setSlots} />;
  },
  args: {
    value: withBreaksSlots,
  },
};

export const Disabled: Story = {
  args: {
    value: defaultSlots,
    onChange: () => {},
    disabled: true,
  },
};

export const Empty: Story = {
  render: (args) => {
    const [slots, setSlots] = useState<BusinessHourSlot[]>(args.value);
    return <BusinessHoursEditor {...args} value={slots} onChange={setSlots} />;
  },
  args: {
    value: [],
  },
};
