import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import SearchBar, { type SearchBarProps } from "./SearchBar";

const defaultModes = [
  { id: "nombre", label: "Nombre", icon: "search" },
  { id: "ciudad", label: "Ciudad", icon: "location_on" },
  { id: "cercaDeTi", label: "Cerca de ti", icon: "near_me" },
];

function SearchBarControlled(props: Omit<SearchBarProps, "value" | "onChange" | "mode" | "onModeChange">) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState(props.modes[0]?.id ?? "");

  return (
    <SearchBar
      {...props}
      value={value}
      onChange={setValue}
      mode={mode}
      onModeChange={setMode}
    />
  );
}

const meta: Meta<typeof SearchBar> = {
  title: "Shared/Form/SearchBar",
  component: SearchBar,
  parameters: { layout: "padded" },
  render: (args) => <SearchBarControlled {...args} />,
};
export default meta;

type Story = StoryObj<typeof SearchBar>;

export const Default: Story = {
  args: {
    modes: defaultModes,
    placeholder: "¿Qué estás buscando hoy?",
    searchLabel: "BUSCAR",
    onSearch: () => console.log("search triggered"),
  },
};

export const CustomModes: Story = {
  args: {
    modes: [
      { id: "all", label: "Todos" },
      { id: "popular", label: "Populares", icon: "trending_up" },
      { id: "new", label: "Nuevos", icon: "fiber_new" },
    ],
    placeholder: "Buscar barberías...",
    searchLabel: "IR",
    onSearch: () => console.log("search triggered"),
  },
};

export const MinimalModes: Story = {
  args: {
    modes: [{ id: "search", label: "Buscar", icon: "search" }],
    placeholder: "Escribí tu búsqueda",
    onSearch: () => console.log("search triggered"),
  },
};
