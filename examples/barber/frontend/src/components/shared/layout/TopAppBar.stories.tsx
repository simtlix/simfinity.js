import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { AuthProvider } from "@/lib/authContext";
import TopAppBar from "./TopAppBar";

const meta: Meta<typeof TopAppBar> = {
  title: "Shared/Layout/TopAppBar",
  component: TopAppBar,
  decorators: [
    (Story) => (
      <I18nProvider>
        <AuthProvider>
          <div className="bg-[#131315] min-h-[120px]">
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
type Story = StoryObj<typeof TopAppBar>;

export const Default: Story = {};
