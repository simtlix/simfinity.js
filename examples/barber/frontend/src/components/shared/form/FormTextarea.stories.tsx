import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormTextarea from "./FormTextarea";

const meta: Meta<typeof FormTextarea> = {
  title: "Shared/Form/FormTextarea",
  component: FormTextarea,
};
export default meta;
type Story = StoryObj<typeof FormTextarea>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormTextarea {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Descripción de la barbería",
    value: "",
    placeholder: "Contanos sobre tu barbería...",
  },
};

export const WithValue: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormTextarea {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Descripción de la barbería",
    value:
      "Barbería clásica con más de 20 años de experiencia. Especialistas en cortes degradados, afeitado con navaja y tratamientos capilares.",
  },
};

export const WithError: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormTextarea {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Notas del turno",
    value: "",
    error: "Las notas no pueden estar vacías",
  },
};

export const CustomRows: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? "");
    return <FormTextarea {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Observaciones",
    value: "",
    placeholder: "Agregá observaciones breves...",
    rows: 2,
  },
};

export const Disabled: Story = {
  args: {
    label: "Política de cancelación",
    value: "El turno puede cancelarse hasta 2 horas antes sin cargo.",
    disabled: true,
    onChange: () => {},
  },
};
