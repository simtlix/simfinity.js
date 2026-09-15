import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { AuthProvider } from "@/lib/authContext";
import AdminSidebar from "./AdminSidebar";

const meta: Meta<typeof AdminSidebar> = {
  title: "Shared/Layout/AdminSidebar",
  component: AdminSidebar,
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
    nextjs: { navigation: { pathname: "/admin" } },
  },
};
export default meta;
type Story = StoryObj<typeof AdminSidebar>;

export const Default: Story = {};

export const BarbershopsActive: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/admin/barbershops" } },
  },
};

export const UsersActive: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/admin/users" } },
  },
};
