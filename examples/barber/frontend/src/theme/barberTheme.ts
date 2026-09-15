/**
 * Design tokens (hex) for inline styles where Tailwind theme classes are awkward.
 * Prefer Tailwind semantic colors (`bg-surface-container-low`, `text-primary`, …) in JSX.
 */
export const tokens = {
  primary: "#e6c487",
  primaryContainer: "#c9a96e",
  onPrimary: "#412d00",
  onPrimaryContainer: "#543d0c",
  secondary: "#d7c4a7",
  secondaryContainer: "#544731",
  tertiary: "#b8c8f2",
  surface: "#131315",
  surfaceDim: "#131315",
  surfaceContainerLowest: "#0e0e10",
  surfaceContainerLow: "#1b1b1d",
  surfaceContainer: "#201f21",
  surfaceContainerHigh: "#2a2a2c",
  surfaceContainerHighest: "#353437",
  surfaceBright: "#39393b",
  surfaceVariant: "#353437",
  background: "#131315",
  onSurface: "#e5e1e4",
  onSurfaceVariant: "#d0c5b5",
  onBackground: "#e5e1e4",
  outline: "#998f81",
  outlineVariant: "#4d463a",
  error: "#ffb4ab",
  errorContainer: "#93000a",
  inverseSurface: "#e5e1e4",
  inversePrimary: "#745a27",
} as const;
