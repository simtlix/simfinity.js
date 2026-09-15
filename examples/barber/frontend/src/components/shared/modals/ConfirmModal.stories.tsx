import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { ConfirmModal } from "./ConfirmModal";

const meta: Meta<typeof ConfirmModal> = {
  title: "Shared/Modals/ConfirmModal",
  component: ConfirmModal,
};
export default meta;
type Story = StoryObj<typeof ConfirmModal>;

export const Default: Story = {
  args: {
    open: true,
    title: "Confirmar eliminación",
    message:
      "¿Estás seguro de que querés eliminar este servicio? Esta acción no se puede deshacer.",
    confirmLabel: "Eliminar",
    cancelLabel: "Cancelar",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};

export const Danger: Story = {
  args: {
    open: true,
    title: "Eliminar barbería",
    message:
      "Esta acción eliminará permanentemente la barbería y todos sus datos asociados. ¿Deseás continuar?",
    confirmLabel: "Sí, eliminar",
    cancelLabel: "No, volver",
    variant: "danger",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};

export const Closed: Story = {
  args: {
    open: false,
    title: "No se muestra",
    message: "No se muestra",
    onClose: action("onClose"),
    onConfirm: action("onConfirm"),
  },
};
