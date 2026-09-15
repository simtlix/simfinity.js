import type { Meta, StoryObj } from "@storybook/react";
import FormSidePanel from "./FormSidePanel";

const meta: Meta<typeof FormSidePanel> = {
  title: "Shared/Form/FormSidePanel",
  component: FormSidePanel,
};
export default meta;
type Story = StoryObj<typeof FormSidePanel>;

export const Default: Story = {
  args: {
    children: (
      <div className="space-y-4">
        <h4 className="text-xs uppercase tracking-widest text-primary font-semibold">
          Resumen
        </h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Corte clásico</span>
            <span className="text-on-surface">$3.500</span>
          </div>
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Barba</span>
            <span className="text-on-surface">$2.000</span>
          </div>
          <div className="flex justify-between border-t border-outline-variant/20 pt-2 font-semibold">
            <span className="text-on-surface">Total</span>
            <span className="text-primary">$5.500</span>
          </div>
        </div>
      </div>
    ),
  },
};

export const WithMultipleSections: Story = {
  args: {
    children: (
      <>
        <div>
          <h4 className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">
            Profesional
          </h4>
          <p className="text-sm text-on-surface">Carlos Méndez</p>
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">
            Sucursal
          </h4>
          <p className="text-sm text-on-surface">Palermo — Av. Santa Fe 3200</p>
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">
            Horario
          </h4>
          <p className="text-sm text-on-surface">Martes 14:30 hs</p>
        </div>
      </>
    ),
  },
};
