import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GoldTextField } from "./GoldTextField";

const meta: Meta<typeof GoldTextField> = {
  title: "Custom/GoldTextField",
  component: GoldTextField,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof GoldTextField>;

export const Default: Story = {
  args: {
    label: "Email",
    type: "email",
    placeholder: "tu@email.com",
  },
};

export const Password: Story = {
  args: {
    label: "Contraseña",
    type: "password",
  },
};

export const WithValue: Story = {
  args: {
    label: "Nombre",
    value: "Juan Pérez",
  },
};

export const FormGroup: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-6">
      <GoldTextField label="Nombre" />
      <GoldTextField label="Email" type="email" />
      <GoldTextField label="Contraseña" type="password" />
      <GoldTextField label="Teléfono (opcional)" type="tel" />
    </div>
  ),
};
