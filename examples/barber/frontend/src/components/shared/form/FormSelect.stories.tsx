import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormSelect from "./FormSelect";

const meta: Meta<typeof FormSelect> = {
  title: "Shared/Form/FormSelect",
  component: FormSelect,
};
export default meta;
type Story = StoryObj<typeof FormSelect>;

const barrioOptions = [
  { value: "palermo", label: "Palermo" },
  { value: "belgrano", label: "Belgrano" },
  { value: "recoleta", label: "Recoleta" },
  { value: "san_telmo", label: "San Telmo" },
  { value: "caballito", label: "Caballito" },
];

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Barrio",
    value: "",
    options: barrioOptions,
    placeholder: "Seleccioná un barrio",
  },
};

export const WithValue: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "palermo");
    return <FormSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Barrio",
    value: "palermo",
    options: barrioOptions,
  },
};

export const WithError: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Sucursal",
    value: "",
    options: barrioOptions,
    placeholder: "Seleccioná una sucursal",
    error: "Debés seleccionar una sucursal",
  },
};

export const Disabled: Story = {
  args: {
    label: "Barrio",
    value: "recoleta",
    options: barrioOptions,
    disabled: true,
    onChange: () => {},
  },
};
