import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormCurrencyInput from "./FormCurrencyInput";

const meta: Meta<typeof FormCurrencyInput> = {
  title: "Shared/Form/FormCurrencyInput",
  component: FormCurrencyInput,
};
export default meta;
type Story = StoryObj<typeof FormCurrencyInput>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(String(args.value ?? ""));
    return <FormCurrencyInput {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Precio del servicio",
    value: "",
    placeholder: "0.00",
  },
};

export const WithValue: Story = {
  render: (args) => {
    const [value, setValue] = useState(String(args.value ?? "3500"));
    return <FormCurrencyInput {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Precio del corte",
    value: "3500",
  },
};

export const Required: Story = {
  render: (args) => {
    const [value, setValue] = useState(String(args.value ?? ""));
    return <FormCurrencyInput {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Precio",
    value: "",
    placeholder: "0.00",
    required: true,
  },
};

export const WithError: Story = {
  render: (args) => {
    const [value, setValue] = useState(String(args.value ?? "-100"));
    return <FormCurrencyInput {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Precio del servicio",
    value: "-100",
    error: "El precio debe ser mayor a cero",
  },
};

export const Disabled: Story = {
  args: {
    label: "Precio fijo",
    value: "5000",
    disabled: true,
    onChange: () => {},
  },
};
