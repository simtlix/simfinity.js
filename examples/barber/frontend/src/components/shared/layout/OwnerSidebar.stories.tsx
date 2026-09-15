import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { AuthProvider } from "@/lib/authContext";
import OwnerSidebar from "./OwnerSidebar";

/**
 * OwnerSidebar uses useBarbershop() which falls back to the default
 * context value (selectedBarbershop: null → displays "Mi Barbería").
 * A BarbershopProvider is not mounted here because it requires
 * SimfinityClientProvider and a live GraphQL backend.
 */
const meta: Meta<typeof OwnerSidebar> = {
  title: "Shared/Layout/OwnerSidebar",
  component: OwnerSidebar,
  decorators: [
    (Story) => (
      <I18nProvider>
        <AuthProvider>
          <div style={{ width: 256, height: "100vh", position: "relative" }}>
            <Story />
          </div>
        </AuthProvider>
      </I18nProvider>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/dashboard" } },
  },
};
export default meta;
type Story = StoryObj<typeof OwnerSidebar>;

export const Default: Story = {};

export const BookingsActive: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/dashboard/bookings" } },
  },
};

export const ServicesActive: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/dashboard/services" } },
  },
};
