/**
 * MD3 Design Tokens — JS-side mirror of globals.css @theme values.
 * Use these when Tailwind classes are not applicable (e.g. inline styles, canvas).
 */

export const colors = {
  background: "#131315",
  surface: "#131315",
  surfaceDim: "#131315",
  surfaceBright: "#39393b",
  surfaceContainerLowest: "#0e0e10",
  surfaceContainerLow: "#1b1b1d",
  surfaceContainer: "#201f21",
  surfaceContainerHigh: "#2a2a2c",
  surfaceContainerHighest: "#353437",
  surfaceVariant: "#353437",
  surfaceTint: "#e4c285",

  primary: "#e6c487",
  primaryContainer: "#c9a96e",
  primaryFixed: "#ffdea4",
  primaryFixedDim: "#e4c285",
  onPrimary: "#412d00",
  onPrimaryContainer: "#543d0c",
  inversePrimary: "#745a27",

  secondary: "#d7c4a7",
  secondaryContainer: "#544731",
  secondaryFixed: "#f3e0c1",
  secondaryFixedDim: "#d7c4a7",
  onSecondary: "#3a2f1a",
  onSecondaryContainer: "#c8b699",

  tertiary: "#b8c8f2",
  tertiaryContainer: "#9dadd5",
  tertiaryFixed: "#d8e2ff",
  tertiaryFixedDim: "#b6c6ef",
  onTertiary: "#203051",
  onTertiaryContainer: "#314163",

  error: "#ffb4ab",
  errorContainer: "#93000a",
  onError: "#690005",
  onErrorContainer: "#ffdad6",

  onSurface: "#e5e1e4",
  onSurfaceVariant: "#d0c5b5",
  onBackground: "#e5e1e4",
  inverseSurface: "#e5e1e4",
  inverseOnSurface: "#313032",

  outline: "#998f81",
  outlineVariant: "#4d463a",

  success: "#4ade80",
  successDim: "#16a34a",
} as const;

export const fonts = {
  headline: "'Newsreader', Georgia, serif",
  body: "'Inter', system-ui, sans-serif",
  label: "'Inter', system-ui, sans-serif",
} as const;

export const gradients = {
  gold: "linear-gradient(135deg, #e6c487 0%, #c9a96e 100%)",
} as const;

export type DesignColors = typeof colors;
export type DesignFonts = typeof fonts;
