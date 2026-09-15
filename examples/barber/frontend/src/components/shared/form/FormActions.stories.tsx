import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import FormActions from "./FormActions";

const meta: Meta<typeof FormActions> = {
  title: "Shared/Form/FormActions",
  component: FormActions,
};
export default meta;
type Story = StoryObj<typeof FormActions>;

export const Default: Story = {
  args: {
    onCancel: fn(),
    onSubmit: fn(),
    submitLabel: "Guardar barbería",
    cancelLabel: "Cancelar",
  },
};

export const SubmitOnly: Story = {
  args: {
    onSubmit: fn(),
    submitLabel: "Crear servicio",
  },
};

export const CancelOnly: Story = {
  args: {
    onCancel: fn(),
    cancelLabel: "Volver",
  },
};

export const Loading: Story = {
  args: {
    onCancel: fn(),
    onSubmit: fn(),
    submitLabel: "Guardar cambios",
    cancelLabel: "Cancelar",
    loading: true,
  },
};

export const Disabled: Story = {
  args: {
    onCancel: fn(),
    onSubmit: fn(),
    submitLabel: "Guardar",
    cancelLabel: "Cancelar",
    disabled: true,
  },
};

export const CustomLabels: Story = {
  args: {
    onCancel: fn(),
    onSubmit: fn(),
    submitLabel: "Confirmar turno",
    cancelLabel: "Descartar",
  },
};
