import type { Meta, StoryObj } from '@storybook/react';
import MapViewInner from './MapViewInner';

/**
 * Leaflet implementation used by `MapView` (dynamic `ssr: false` in production).
 */
const meta: Meta<typeof MapViewInner> = {
  title: 'Shared/Maps/MapViewInner',
  component: MapViewInner,
  decorators: [
    (Story) => (
      <div style={{ height: 500, width: '100%' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MapViewInner>;

export const Default: Story = {
  args: {
    center: [-34.6037, -58.3816],
    zoom: 13,
    markers: [{ lat: -34.6037, lng: -58.3816, label: 'Demo marker' }],
  },
};
