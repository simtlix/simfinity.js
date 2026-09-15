import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import MapView from "./MapView";

const meta: Meta<typeof MapView> = {
  title: "Shared/Maps/MapView",
  component: MapView,
  decorators: [
    (Story) => (
      <div style={{ height: 500, width: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MapView>;

export const Default: Story = {
  args: {
    center: [-34.6037, -58.3816],
    zoom: 13,
    markers: [
      { lat: -34.6037, lng: -58.3816, label: "Barbería El Clásico" },
    ],
  },
};

export const MultipleMarkers: Story = {
  args: {
    center: [-34.6037, -58.3816],
    zoom: 12,
    markers: [
      { lat: -34.6037, lng: -58.3816, label: "Barbería El Clásico" },
      { lat: -34.5875, lng: -58.3972, label: "Cortes Premium Palermo" },
      { lat: -34.6158, lng: -58.3733, label: "Don Navaja - San Telmo" },
      { lat: -34.5986, lng: -58.4203, label: "The Groomed - Caballito" },
    ],
  },
};

export const Clickable: Story = {
  args: {
    center: [-34.6037, -58.3816],
    zoom: 14,
    markers: [],
    onClick: action("onClick"),
  },
};

export const CustomZoom: Story = {
  args: {
    center: [-34.6037, -58.3816],
    zoom: 16,
    markers: [
      { lat: -34.6037, lng: -58.3816, label: "Barbería El Clásico - Microcentro" },
    ],
  },
};
