import type { Meta, StoryObj } from "@storybook/react";
import FormSection from "./FormSection";

const meta: Meta<typeof FormSection> = {
  title: "Shared/Form/FormSection",
  component: FormSection,
};
export default meta;
type Story = StoryObj<typeof FormSection>;

export const Default: Story = {
  args: {
    title: "Información general",
    icon: "store",
    children: (
      <div className="space-y-4">
        <p className="text-sm text-on-surface-variant">
          Completá los datos de tu barbería para que los clientes puedan
          encontrarte.
        </p>
      </div>
    ),
  },
};

export const WithoutIcon: Story = {
  args: {
    title: "Horarios de atención",
    children: (
      <p className="text-sm text-on-surface-variant">
        Configurá los días y horarios en los que atendés.
      </p>
    ),
  },
};

export const WithMultipleChildren: Story = {
  args: {
    title: "Servicios",
    icon: "content_cut",
    children: (
      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-on-surface">Corte clásico</span>
          <span className="text-primary">$3.500</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-on-surface">Barba</span>
          <span className="text-primary">$2.000</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-on-surface">Corte + Barba</span>
          <span className="text-primary">$5.000</span>
        </div>
      </div>
    ),
  },
};
