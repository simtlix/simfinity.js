import type { Meta, StoryObj } from "@storybook/react";
import { DataTable, type Column } from "./DataTable";

const meta: Meta<typeof DataTable> = {
  title: "Shared/Data/DataTable",
  component: DataTable,
};
export default meta;

type Story = StoryObj<typeof DataTable>;

const columns: Column[] = [
  { key: "name", label: "Barbero", sortable: true },
  { key: "specialty", label: "Especialidad" },
  { key: "bookings", label: "Turnos hoy", sortable: true },
  {
    key: "rating",
    label: "Rating",
    render: (value) => `⭐ ${value}`,
  },
];

const barberData = [
  { name: "Martín López", specialty: "Corte clásico", bookings: 8, rating: 4.8 },
  { name: "Carlos Ruiz", specialty: "Barba & Afeitado", bookings: 6, rating: 4.5 },
  { name: "Diego Fernández", specialty: "Coloración", bookings: 4, rating: 4.9 },
  { name: "Lucas García", specialty: "Corte + Barba", bookings: 7, rating: 4.3 },
  { name: "Andrés Moreno", specialty: "Alisado", bookings: 3, rating: 4.7 },
];

export const Default: Story = {
  args: {
    columns,
    data: barberData,
    sortKey: "name",
    sortDir: "asc",
  },
};

export const Empty: Story = {
  args: {
    columns,
    data: [],
    emptyMessage: "No hay barberos registrados",
  },
};

export const Loading: Story = {
  args: {
    columns,
    data: [],
    loading: true,
  },
};

export const WithActions: Story = {
  args: {
    columns,
    data: barberData,
    actions: (row) => (
      <button className="text-xs text-primary hover:underline">
        Ver perfil de {row.name as string}
      </button>
    ),
  },
};

export const Clickable: Story = {
  args: {
    columns,
    data: barberData,
    onRowClick: (row) => alert(`Seleccionaste a ${row.name}`),
  },
};
