import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BookingReviewStep } from "./BookingReviewStep";

const meta: Meta<typeof BookingReviewStep> = {
  title: "Shared/Booking/BookingReviewStep",
  component: BookingReviewStep,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof BookingReviewStep>;

function Controlled(props: React.ComponentProps<typeof BookingReviewStep>) {
  const [notes, setNotes] = useState(props.notes);
  return <BookingReviewStep {...props} notes={notes} onNotesChange={setNotes} />;
}

export const Default: Story = {
  render: () => (
    <Controlled
      barbershopName="The Editorial"
      services={[
        { name: "Corte de Autor & Ritual Sensorial", price: 700, duration: 60 },
      ]}
      professional="Enzo M."
      date="Viernes 20 de Feb, 2026"
      time="14:00"
      totalPrice={700}
      notes=""
      onNotesChange={() => {}}
    />
  ),
};

export const ManyServices: Story = {
  render: () => (
    <Controlled
      barbershopName="Barba Roja Studio"
      services={[
        { name: "Corte Clásico", price: 350, duration: 30 },
        { name: "Arreglo de Barba", price: 250, duration: 20 },
        { name: "Tratamiento Capilar", price: 400, duration: 25 },
      ]}
      professional="Lucas Vega"
      date="Sábado 21 de Feb, 2026"
      time="10:30"
      totalPrice={1000}
      notes=""
      onNotesChange={() => {}}
    />
  ),
};

export const SingleService: Story = {
  render: () => (
    <Controlled
      barbershopName="The Editorial"
      services={[{ name: "Afeitado Clásico", price: 500, duration: 40 }]}
      professional="Marco"
      date="Lunes 23 de Feb, 2026"
      time="16:00"
      totalPrice={500}
      notes=""
      onNotesChange={() => {}}
    />
  ),
};

export const WithoutProfessional: Story = {
  render: () => (
    <Controlled
      barbershopName="The Editorial"
      services={[{ name: "Corte Moderno", price: 600, duration: 45 }]}
      date="Martes 24 de Feb, 2026"
      time="11:00"
      totalPrice={600}
      notes=""
      onNotesChange={() => {}}
    />
  ),
};
