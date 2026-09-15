import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import LocationPicker from "./LocationPicker";

const meta: Meta<typeof LocationPicker> = {
  title: "Shared/Maps/LocationPicker",
  component: LocationPicker,
};
export default meta;
type Story = StoryObj<typeof LocationPicker>;

export const Default: Story = {
  args: {
    value: null,
    onChange: () => {},
  },
};

export const WithInitialValue: Story = {
  args: {
    value: [-34.6037, -58.3816],
    onChange: () => {},
  },
};

function InteractiveWrapper() {
  const [coords, setCoords] = useState<[number, number] | null>(null);
  return <LocationPicker value={coords} onChange={(lat, lng) => setCoords([lat, lng])} />;
}

export const Interactive: Story = {
  render: () => <InteractiveWrapper />,
};
