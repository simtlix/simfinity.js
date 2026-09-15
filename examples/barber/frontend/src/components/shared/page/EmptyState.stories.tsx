import type { Meta, StoryObj } from "@storybook/react";
import { action } from "storybook/actions";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Shared/Page/EmptyState",
  component: EmptyState,
};
export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  args: {
    icon: "storefront",
    title: "No hay barberías registradas",
    message:
      "Todavía no se registraron barberías en la plataforma. Creá la primera para empezar.",
    actionLabel: "Crear barbería",
    onAction: action("onAction"),
  },
};

export const WithoutAction: Story = {
  args: {
    icon: "calendar_month",
    title: "Sin reservas",
    message: "No hay reservas para la fecha seleccionada.",
  },
};

export const WithoutIcon: Story = {
  args: {
    title: "No se encontraron resultados",
    message: "Intentá con otros filtros de búsqueda.",
  },
};

export const ServicesEmpty: Story = {
  args: {
    icon: "content_cut",
    title: "Sin servicios",
    message:
      "Todavía no agregaste servicios a tu barbería. Los clientes no podrán reservar hasta que cargues al menos uno.",
    actionLabel: "Agregar servicio",
    onAction: action("onAction"),
  },
};
