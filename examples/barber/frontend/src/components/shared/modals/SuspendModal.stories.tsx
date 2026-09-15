import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { SuspendModal } from "./SuspendModal";

const meta: Meta<typeof SuspendModal> = {
  title: "Shared/Modals/SuspendModal",
  component: SuspendModal,
};
export default meta;
type Story = StoryObj<typeof SuspendModal>;

export const Default: Story = {
  args: {
    open: true,
    title: "Suspender cuenta",
    userName: "Carlos Mendoza",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};

export const WithoutUserName: Story = {
  args: {
    open: true,
    title: "Suspender cuenta de usuario",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};
