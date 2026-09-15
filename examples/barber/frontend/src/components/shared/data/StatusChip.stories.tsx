import type { Meta, StoryObj } from "@storybook/react";
import { StatusChip } from "./StatusChip";

const meta: Meta<typeof StatusChip> = {
  title: "Shared/Data/StatusChip",
  component: StatusChip,
};
export default meta;

type Story = StoryObj<typeof StatusChip>;

export const Default: Story = {
  args: {
    status: "CONFIRMED",
  },
};

export const Pending: Story = {
  args: {
    status: "PENDING",
  },
};

export const Cancelled: Story = {
  args: {
    status: "CANCELLED",
  },
};

export const Active: Story = {
  args: {
    status: "ACTIVE",
  },
};

export const Suspended: Story = {
  args: {
    status: "SUSPENDED",
  },
};

export const UnknownStatus: Story = {
  args: {
    status: "IN_REVIEW",
  },
};

export const CustomColorMap: Story = {
  args: {
    status: "VIP",
    colorMap: {
      VIP: { text: "text-purple-400", bg: "bg-purple-400/10" },
    },
  },
};

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {["ACTIVE", "CONFIRMED", "COMPLETED", "PENDING", "DRAFT", "CANCELLED", "REJECTED", "SUSPENDED", "INACTIVE"].map(
        (s) => (
          <StatusChip key={s} status={s} />
        ),
      )}
    </div>
  ),
};
