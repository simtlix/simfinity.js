import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { addDays, startOfDay } from "date-fns";
import { CalendarPicker } from "./CalendarPicker";

const today = startOfDay(new Date());

const meta: Meta<typeof CalendarPicker> = {
  title: "Shared/Booking/CalendarPicker",
  component: CalendarPicker,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof CalendarPicker>;

function CalendarControlled(
  props: Omit<React.ComponentProps<typeof CalendarPicker>, "selectedDate" | "onSelect">,
) {
  const [date, setDate] = useState<Date | null>(null);
  return <CalendarPicker {...props} selectedDate={date} onSelect={setDate} />;
}

export const Default: Story = {
  render: () => <CalendarControlled />,
};

export const WithMinDate: Story = {
  render: () => <CalendarControlled minDate={today} />,
};

export const WithAvailableDates: Story = {
  render: () => (
    <CalendarControlled
      minDate={today}
      availableDates={[
        addDays(today, 1),
        addDays(today, 2),
        addDays(today, 4),
        addDays(today, 5),
        addDays(today, 8),
        addDays(today, 9),
        addDays(today, 11),
        addDays(today, 15),
      ]}
    />
  ),
};

export const PreSelected: Story = {
  args: {
    selectedDate: addDays(today, 3),
    onSelect: () => {},
    minDate: today,
  },
};
