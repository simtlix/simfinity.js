import type { Meta, StoryObj } from '@storybook/react';

import { cn } from '@/lib/cn';

function Demo() {
  return (
    <div className="space-y-4 text-on-surface">
      <p className={cn('text-sm', 'text-primary', false && 'hidden')}>
        cn() merges utilities: conflicting padding is resolved (last wins).
      </p>
      <code className="block rounded-lg bg-surface-container-high p-3 text-xs">
        {cn('px-4 py-2', 'px-6')}
      </code>
    </div>
  );
}

const meta: Meta<typeof Demo> = {
  title: 'Shared/Lib/cn',
  component: Demo,
};
export default meta;

type Story = StoryObj<typeof Demo>;

export const MergeExample: Story = {
  render: () => <Demo />,
};
