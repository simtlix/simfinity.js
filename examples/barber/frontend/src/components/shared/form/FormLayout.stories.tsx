import type { Meta, StoryObj } from "@storybook/react";
import FormLayout from "./FormLayout";

const meta: Meta<typeof FormLayout> = {
  title: "Shared/Form/FormLayout",
  component: FormLayout,
};
export default meta;
type Story = StoryObj<typeof FormLayout>;

export const Default: Story = {
  args: {
    children: (
      <div className="bg-surface-container-low rounded-2xl p-8 space-y-4">
        <h3 className="text-xs uppercase tracking-widest text-primary font-semibold">
          Datos de la barbería
        </h3>
        <p className="text-sm text-on-surface-variant">
          Contenido principal del formulario.
        </p>
      </div>
    ),
  },
};

export const WithSidebar: Story = {
  args: {
    children: (
      <div className="bg-surface-container-low rounded-2xl p-8 space-y-4">
        <h3 className="text-xs uppercase tracking-widest text-primary font-semibold">
          Datos de la barbería
        </h3>
        <p className="text-sm text-on-surface-variant">
          Contenido principal del formulario con sidebar visible.
        </p>
      </div>
    ),
    sidebar: (
      <div className="bg-surface-container-low rounded-2xl p-6 space-y-4">
        <h4 className="text-xs uppercase tracking-widest text-primary font-semibold">
          Vista previa
        </h4>
        <p className="text-sm text-on-surface-variant">
          Panel lateral con información complementaria.
        </p>
      </div>
    ),
  },
};
