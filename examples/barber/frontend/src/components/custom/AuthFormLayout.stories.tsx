import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AuthFormLayout } from "./AuthFormLayout";
import { GoldTextField } from "@/components/custom/GoldTextField";
import { Button } from "@/components/shared/ui";

const meta: Meta<typeof AuthFormLayout> = {
  title: "Custom/AuthFormLayout",
  component: AuthFormLayout,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof AuthFormLayout>;

export const Default: Story = {
  args: {
    subtitle: "Iniciá sesión en tu cuenta",
    children: (
      <div className="flex max-w-md flex-col gap-6">
        <GoldTextField label="Email" type="email" />
        <GoldTextField label="Contraseña" type="password" />
        <Button type="button" variant="gold" size="form" className="w-full shadow-md">
          Iniciar Sesión
        </Button>
      </div>
    ),
  },
};

export const WithFooter: Story = {
  args: {
    subtitle: "Creá tu cuenta",
    children: (
      <div className="flex max-w-md flex-col gap-6">
        <GoldTextField label="Nombre" />
        <GoldTextField label="Email" type="email" />
        <GoldTextField label="Contraseña" type="password" />
        <Button type="button" variant="gold" size="form" className="w-full shadow-md">
          Crear cuenta
        </Button>
      </div>
    ),
    footer: (
      <p className="text-center font-body text-sm text-on-surface-variant">
        ¿Ya tenés cuenta? Iniciá sesión
      </p>
    ),
  },
};

export const CustomTitle: Story = {
  args: {
    title: "BARBER CLUB",
    subtitle: "Bienvenido de vuelta",
    children: (
      <div className="flex max-w-md flex-col gap-6">
        <GoldTextField label="Email" type="email" />
        <Button type="button" variant="gold" size="form" className="w-full shadow-md">
          Continuar
        </Button>
      </div>
    ),
  },
};
