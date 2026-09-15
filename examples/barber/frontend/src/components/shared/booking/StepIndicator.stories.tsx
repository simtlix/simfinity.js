import type { Meta, StoryObj } from "@storybook/react";
import { StepIndicator } from "./StepIndicator";

const bookingSteps = [
  { id: "service", label: "Servicio" },
  { id: "professional", label: "Profesional" },
  { id: "datetime", label: "Fecha y hora" },
  { id: "confirm", label: "Confirmar" },
];

const meta: Meta<typeof StepIndicator> = {
  title: "Shared/Booking/StepIndicator",
  component: StepIndicator,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof StepIndicator>;

export const Default: Story = {
  args: {
    steps: bookingSteps,
    currentStep: "professional",
  },
};

export const FirstStep: Story = {
  args: {
    steps: bookingSteps,
    currentStep: "service",
  },
};

export const LastStep: Story = {
  args: {
    steps: bookingSteps,
    currentStep: "confirm",
  },
};

export const AllCompleted: Story = {
  args: {
    steps: bookingSteps,
    currentStep: "done",
  },
};

export const TwoSteps: Story = {
  args: {
    steps: [
      { id: "select", label: "Seleccionar" },
      { id: "confirm", label: "Confirmar" },
    ],
    currentStep: "confirm",
  },
};
