import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormImageUpload from "./FormImageUpload";

const meta: Meta<typeof FormImageUpload> = {
  title: "Shared/Form/FormImageUpload",
  component: FormImageUpload,
};
export default meta;
type Story = StoryObj<typeof FormImageUpload>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormImageUpload {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Logo de la barbería",
    value: "",
    variant: "square",
  },
};

export const Wide: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormImageUpload {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Imagen de portada",
    value: "",
    variant: "wide",
    hint: "Subí una imagen en formato 21:9",
  },
};

export const WithHint: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormImageUpload {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Foto del profesional",
    value: "",
    variant: "square",
    hint: "Tamaño recomendado: 400x400px",
  },
};

export const Disabled: Story = {
  args: {
    label: "Logo de la barbería",
    value: "",
    disabled: true,
    onChange: () => {},
  },
};
