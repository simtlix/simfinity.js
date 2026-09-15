import type { Meta, StoryObj } from '@storybook/react';

import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Shared/UI/Button',
  component: Button,
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Gold: Story = {
  args: {
    variant: 'gold',
    size: 'lg',
    children: 'Continuar',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    size: 'md',
    children: 'Cancelar',
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    size: 'sm',
    children: 'Omitir',
  },
};
