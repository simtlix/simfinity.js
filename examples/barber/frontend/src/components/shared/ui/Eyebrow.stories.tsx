import type { Meta, StoryObj } from '@storybook/react';

import { Eyebrow } from './Eyebrow';

const meta: Meta<typeof Eyebrow> = {
  title: 'Shared/UI/Eyebrow',
  component: Eyebrow,
};
export default meta;

type Story = StoryObj<typeof Eyebrow>;

export const Default: Story = {
  args: {
    children: 'Paso 1 de 4',
  },
};
