import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { action } from "storybook/actions";
import { ProfessionalSelectionCard } from "./ProfessionalSelectionCard";

const meta: Meta<typeof ProfessionalSelectionCard> = {
  title: "Shared/Booking/ProfessionalSelectionCard",
  component: ProfessionalSelectionCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="grid grid-cols-4 gap-6 max-w-3xl">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ProfessionalSelectionCard>;

export const Default: Story = {
  args: {
    name: "Enzo",
    specialty: "Maestro Barbero",
    bio: "Con más de 12 años de experiencia en el arte de la barbería tradicional.",
    photoUrl: "https://i.pravatar.cc/300?u=enzo",
    selected: false,
    onToggle: action("onToggle"),
  },
};

export const Selected: Story = {
  args: {
    ...Default.args,
    selected: true,
  },
};

export const WithoutPhoto: Story = {
  args: {
    name: "Lucas Vega",
    specialty: "Estilista Senior",
    selected: false,
    onToggle: action("onToggle"),
  },
};

export const WithoutSpecialty: Story = {
  args: {
    name: "Marco",
    photoUrl: "https://i.pravatar.cc/300?u=marco",
    selected: false,
    onToggle: action("onToggle"),
  },
};

export const Grid: Story = {
  render: () => (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-3xl">
      <ProfessionalSelectionCard
        name="Enzo"
        specialty="Maestro Barbero"
        photoUrl="https://i.pravatar.cc/300?u=enzo"
        selected
        onToggle={action("enzo")}
      />
      <ProfessionalSelectionCard
        name="Lucas"
        specialty="Estilista Senior"
        photoUrl="https://i.pravatar.cc/300?u=lucas"
        selected={false}
        onToggle={action("lucas")}
      />
      <ProfessionalSelectionCard
        name="Marco"
        specialty="Especialista en Barba"
        photoUrl="https://i.pravatar.cc/300?u=marco"
        selected={false}
        onToggle={action("marco")}
      />
      <ProfessionalSelectionCard
        name="Diego"
        specialty="Colorista"
        selected={false}
        onToggle={action("diego")}
      />
    </div>
  ),
};
