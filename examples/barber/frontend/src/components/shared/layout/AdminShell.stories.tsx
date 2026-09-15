import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { AuthProvider } from "@/lib/authContext";
import AdminShell from "./AdminShell";

const meta: Meta<typeof AdminShell> = {
  title: "Shared/Layout/AdminShell",
  component: AdminShell,
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
    nextjs: { navigation: { pathname: "/admin" } },
  },
};
export default meta;
type Story = StoryObj<typeof AdminShell>;

export const Default: Story = {
  args: {
    children: (
      <div className="space-y-4">
        <h1 className="font-headline italic text-4xl text-on-surface">
          Panel de Administración
        </h1>
        <div className="w-16 h-0.5 bg-primary" />
        <p className="text-on-surface-variant text-sm">
          Contenido de ejemplo dentro del shell de administración.
        </p>
      </div>
    ),
  },
};
