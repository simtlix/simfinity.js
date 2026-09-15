import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormToggle from "./FormToggle";

const meta: Meta<typeof FormToggle> = {
  title: "Shared/Form/FormToggle",
  component: FormToggle,
};
export default meta;
type Story = StoryObj<typeof FormToggle>;

export const Default: Story = {
  render: (args) => {
    const [checked, setChecked] = useState(args.checked ?? false);
    return <FormToggle {...args} checked={checked} onChange={setChecked} />;
  },
  args: {
    label: "Acepta reservas online",
    checked: false,
  },
};

export const Checked: Story = {
  render: (args) => {
    const [checked, setChecked] = useState(args.checked ?? true);
    return <FormToggle {...args} checked={checked} onChange={setChecked} />;
  },
  args: {
    label: "Barbería activa",
    checked: true,
  },
};

export const Disabled: Story = {
  args: {
    label: "Notificaciones por email",
    checked: false,
    disabled: true,
    onChange: () => {},
  },
};

export const DisabledChecked: Story = {
  args: {
    label: "Cuenta verificada",
    checked: true,
    disabled: true,
    onChange: () => {},
  },
};
