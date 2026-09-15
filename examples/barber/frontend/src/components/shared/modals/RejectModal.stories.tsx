import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { RejectModal } from "./RejectModal";

const meta: Meta<typeof RejectModal> = {
  title: "Shared/Modals/RejectModal",
  component: RejectModal,
};
export default meta;
type Story = StoryObj<typeof RejectModal>;

export const Default: Story = {
  args: {
    open: true,
    title: "Rechazar solicitud",
    placeholder: "Describí el motivo del rechazo…",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};

export const ReviewRejection: Story = {
  args: {
    open: true,
    title: "Rechazar reseña",
    placeholder: "Motivo por el cual la reseña es inapropiada…",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};
