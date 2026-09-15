import type { Meta, StoryObj } from '@storybook/react';

import { TipCard } from './TipCard';

const meta: Meta<typeof TipCard> = {
  title: 'Shared/UI/TipCard',
  component: TipCard,
};
export default meta;

type Story = StoryObj<typeof TipCard>;

export const Default: Story = {
  args: {
    title: 'Consejo Editorial',
    children:
      '"El nombre es el primer aroma que percibe el cliente. Elige algo que evoque herencia y precisión."',
  },
};
