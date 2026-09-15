import type { Meta, StoryObj } from '@storybook/react';

import { InfoBanner } from './InfoBanner';

const meta: Meta<typeof InfoBanner> = {
  title: 'Shared/UI/InfoBanner',
  component: InfoBanner,
};
export default meta;

type Story = StoryObj<typeof InfoBanner>;

export const Default: Story = {
  args: {
    icon: 'info',
    title: 'Proceso de revisión',
    children:
      'Una vez enviado, nuestro equipo revisará tu solicitud en un plazo de 24 a 48 horas.',
  },
};
