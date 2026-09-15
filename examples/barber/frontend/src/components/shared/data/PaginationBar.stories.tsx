import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { I18nProvider } from "@/lib/simfinity";
import { PaginationBar } from "./PaginationBar";

function PaginationBarControlled(
  props: Omit<React.ComponentProps<typeof PaginationBar>, "page" | "onPageChange" | "onPageSizeChange"> & {
    initialPage?: number;
    withPageSizeChanger?: boolean;
  },
) {
  const [page, setPage] = useState(props.initialPage ?? 1);
  const [pageSize, setPageSize] = useState(props.pageSize);

  return (
    <PaginationBar
      {...props}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={props.withPageSizeChanger ? setPageSize : undefined}
    />
  );
}

const meta: Meta<typeof PaginationBar> = {
  title: "Shared/Data/PaginationBar",
  component: PaginationBar,
  decorators: [
    (Story) => (
      <I18nProvider>
        <Story />
      </I18nProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof PaginationBar>;

export const Default: Story = {
  render: () => <PaginationBarControlled total={87} pageSize={10} />,
};

export const FewPages: Story = {
  render: () => <PaginationBarControlled total={23} pageSize={10} />,
};

export const ManyPages: Story = {
  render: () => (
    <PaginationBarControlled total={542} pageSize={10} initialPage={5} />
  ),
};

export const WithPageSizeChanger: Story = {
  render: () => (
    <PaginationBarControlled
      total={200}
      pageSize={10}
      withPageSizeChanger
      pageSizeOptions={[10, 25, 50]}
    />
  ),
};

export const SinglePage: Story = {
  render: () => <PaginationBarControlled total={7} pageSize={10} />,
};

export const EmptyResults: Story = {
  render: () => <PaginationBarControlled total={0} pageSize={10} />,
};
