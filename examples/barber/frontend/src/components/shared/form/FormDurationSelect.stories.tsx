import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import FormDurationSelect from "./FormDurationSelect";

const meta: Meta<typeof FormDurationSelect> = {
  title: "Shared/Form/FormDurationSelect",
  component: FormDurationSelect,
};
export default meta;
type Story = StoryObj<typeof FormDurationSelect>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? 30);
    return <FormDurationSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Duración del servicio",
    value: 30,
  },
};

export const LongDuration: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? 120);
    return <FormDurationSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Duración del tratamiento",
    value: 120,
  },
};

export const CustomOptions: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value ?? 20);
    return <FormDurationSelect {...args} value={value} onChange={setValue} />;
  },
  args: {
    label: "Duración del turno",
    value: 20,
    options: [10, 20, 40, 60, 80],
  },
};

export const Disabled: Story = {
  args: {
    label: "Duración",
    value: 45,
    disabled: true,
    onChange: () => {},
  },
};
