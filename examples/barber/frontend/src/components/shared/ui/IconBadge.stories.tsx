import type { Meta, StoryObj } from '@storybook/react';

import { IconBadge } from './IconBadge';

const meta: Meta<typeof IconBadge> = {
  title: 'Shared/UI/IconBadge',
  component: IconBadge,
};
export default meta;

type Story = StoryObj<typeof IconBadge>;

export const Medium: Story = {
  args: {
    icon: 'calendar_month',
    size: 'md',
  },
};

export const LargeCircle: Story = {
  args: {
    icon: 'person',
    size: 'lg',
    variant: 'contained',
  },
};
