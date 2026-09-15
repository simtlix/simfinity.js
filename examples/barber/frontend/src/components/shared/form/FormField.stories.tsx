import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormField from "./FormField";

const meta: Meta<typeof FormField> = {
  title: "Shared/Form/FormField",
  component: FormField,
};
export default meta;
type Story = StoryObj<typeof FormField>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormField {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Nombre de la barbería",
    value: "",
    placeholder: "Ej: Barbería El Clásico",
  },
};

export const WithValue: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormField {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Nombre de la barbería",
    value: "Barbería El Clásico",
  },
};

export const Required: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormField {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Email del profesional",
    value: "",
    placeholder: "correo@ejemplo.com",
    required: true,
  },
};

export const WithError: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormField {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Teléfono de contacto",
    value: "abc",
    error: "El teléfono debe contener solo números",
  },
};

export const Disabled: Story = {
  args: {
    label: "Dirección",
    value: "Av. Corrientes 1234, CABA",
    disabled: true,
    onChange: () => {},
  },
};

export const Password: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormField {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Contraseña",
    value: "",
    type: "password",
    placeholder: "Ingresá tu contraseña",
    required: true,
  },
};
