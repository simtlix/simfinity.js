import type { Meta, StoryObj } from "@storybook/react";
import { StarRating } from "./StarRating";

const meta: Meta<typeof StarRating> = {
  title: "Shared/Data/StarRating",
  component: StarRating,
};
export default meta;

type Story = StoryObj<typeof StarRating>;

export const Default: Story = {
  args: {
    rating: 4.5,
  },
};

export const FullStars: Story = {
  args: {
    rating: 5,
    count: 128,
  },
};

export const HalfStar: Story = {
  args: {
    rating: 3.5,
    count: 42,
  },
};

export const LowRating: Story = {
  args: {
    rating: 1,
    count: 3,
  },
};

export const ZeroStars: Story = {
  args: {
    rating: 0,
  },
};

export const SmallSize: Story = {
  args: {
    rating: 4,
    count: 76,
    size: "sm",
  },
};

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <StarRating rating={4.5} count={128} size="sm" />
      <StarRating rating={4.5} count={128} size="md" />
    </div>
  ),
};
