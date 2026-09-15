import type { Meta, StoryObj } from '@storybook/react';

import { Surface } from './Surface';

const meta: Meta<typeof Surface> = {
  title: 'Shared/UI/Surface',
  component: Surface,
  decorators: [(Story) => <div className="max-w-md p-6 bg-background"><Story /></div>],
};
export default meta;

type Story = StoryObj<typeof Surface>;

export const Low: Story = {
  args: {
    tone: 'low',
    padding: 'md',
    radius: 'xl',
    children: <p className="text-on-surface">Low surface card</p>,
  },
};

export const Tip: Story = {
  args: {
    tone: 'tip',
    padding: 'md',
    children: <p className="text-sm italic text-on-surface/80">Tip accent panel</p>,
  },
};

export const Summary: Story = {
  args: {
    tone: 'summary',
    padding: 'lg',
    radius: 'xl',
    children: <p className="text-on-surface">Summary block with gold left rail</p>,
  },
};
