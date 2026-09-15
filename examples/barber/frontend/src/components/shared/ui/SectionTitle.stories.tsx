import type { Meta, StoryObj } from '@storybook/react';

import { SectionTitle } from './SectionTitle';

const meta: Meta<typeof SectionTitle> = {
  title: 'Shared/UI/SectionTitle',
  component: SectionTitle,
};
export default meta;

type Story = StoryObj<typeof SectionTitle>;

export const WithEyebrowAndSubtitle: Story = {
  args: {
    eyebrow: 'Onboarding',
    heading: 'Tu Barbería',
    subtitle: 'Definí identidad visual y nombre.',
  },
};

export const HeadingOnly: Story = {
  args: {
    heading: 'Dashboard',
  },
};
