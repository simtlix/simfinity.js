import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { AuthProvider } from "@/lib/authContext";
import OwnerShell from "./OwnerShell";

/**
 * OwnerShell composes OwnerSidebar + TopAppBar. useBarbershop() falls
 * back to the default context (displays "Mi Barbería") because
 * BarbershopProvider requires a live SimfinityClient / GraphQL backend.
 */
const meta: Meta<typeof OwnerShell> = {
  title: "Shared/Layout/OwnerShell",
  component: OwnerShell,
  decorators: [
    (Story) => (
      <I18nProvider>
        <AuthProvider>
          <Story />
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
type Story = StoryObj<typeof OwnerShell>;

export const Default: Story = {
  args: {
    children: (
      <div className="space-y-4">
        <h1 className="font-headline italic text-4xl text-on-surface">
          Mi Barbería
        </h1>
        <div className="w-16 h-0.5 bg-primary" />
        <p className="text-on-surface-variant text-sm">
          Contenido de ejemplo dentro del shell del propietario.
        </p>
      </div>
    ),
  },
};
