import type { Meta, StoryObj } from "@storybook/react";
import { PageHeader } from "./PageHeader";
import { Button } from "@/components/shared/ui";

const meta: Meta<typeof PageHeader> = {
  title: "Shared/Page/PageHeader",
  component: PageHeader,
};
export default meta;
type Story = StoryObj<typeof PageHeader>;

export const Default: Story = {
  args: {
    title: "Barberías",
    subtitle: "Gestión de todas las barberías registradas en la plataforma",
  },
};

export const WithBreadcrumbs: Story = {
  args: {
    title: "Crear barbería",
    subtitle: "Completá los datos para registrar una nueva barbería",
    breadcrumbs: [
      { label: "Panel", href: "/admin" },
      { label: "Barberías", href: "/admin/barbershops" },
      { label: "Crear" },
    ],
  },
};

export const WithActions: Story = {
  args: {
    title: "Profesionales",
    subtitle: "Equipo de profesionales de tu barbería",
    actions: (
      <Button type="button" variant="gold" size="form" className="text-on-primary px-5 py-2.5">
        + Agregar profesional
      </Button>
    ),
  },
};

export const TitleOnly: Story = {
  args: {
    title: "Dashboard",
  },
};
