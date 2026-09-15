# Simfinity Barber — Frontend

Shared Next.js 16 app for the MongoDB and PostgreSQL barber examples: public discovery and booking, owner dashboard, and admin tools. UI is **custom** (Tailwind + shared components). **`@simtlix/simfinity-js-client`** powers GraphQL; **`SimfinityClientProvider`**, **`I18nProvider`**, and **`useSimfinityClient` / `useI18n`** live in **`src/lib/simfinity/`** (no `@simtlix/simfinity-fe-components`, no MUI).

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## Overview

- **Pages** under `src/app/` are hand-built routes that compose `src/components/shared/*` (forms, tables, layout, booking steps, maps, charts).
- **Data** goes through `useSimfinityClient()` → `client.find()`, `client.add()`, `client.update()`, `client.delete()`, `client.transition()`, etc. (`@simtlix/simfinity-js-client`).
- **Labels** load from `public/i18n/{locale}.json` via local `I18nProvider` and the `useT(namespace)` hook (`src/hooks/useT.ts`).
- **Auth** is app-level JWT in `localStorage`, wired with `prepareHeaders` on `SimfinityClientProvider` (`src/lib/authContext.tsx`, `src/app/providers.tsx`).

There is **no** `simfinitySetup/` folder, **no** `registerFormCustomization`, and **no** `/entities/*` generic CRUD in this project.

## Tech stack

| Layer | Technology | Notes |
|--------|------------|--------|
| Framework | Next.js 16 (App Router) | Turbopack in dev |
| Language | TypeScript 5 | strict |
| Primary UI | Tailwind CSS 4 | MD3-style tokens in `globals.css` / `@theme` |
| Charts / maps | Recharts, Leaflet + react-leaflet | Dynamic import where needed |
| Simfinity (runtime) | `src/lib/simfinity/` | `SimfinityClientProvider`, `I18nProvider`, hooks (mirrors former fe-components subset) |
| GraphQL client API | `@simtlix/simfinity-js-client` | ^1.1.0 |
| Component dev | Storybook 10 | `@storybook/nextjs-vite` |
| Tests | Vitest 4 (Storybook browser tests + `npm run test:unit`), Playwright | `src/lib/cn.test.ts` for class-merge helper |

## Getting started

Start either full stack with the [barber example instructions](../README.md). This frontend is a private, independent npm application outside the library workspaces. It uses the published GraphQL client from npm and does not select or import a database adapter.

For local frontend development, use Node.js 24 and run these commands from this directory with the selected backend already running:

```bash
npm ci
cp .env.example .env.local
npm run dev            # http://localhost:4401 (MongoDB defaults)
npm run storybook      # http://localhost:6006
```

For PostgreSQL, set `NEXT_PUBLIC_GRAPHQL_URL=http://localhost:4500/graphql` in `.env.local` and run `npm run dev -- -p 4501`.

The synthetic demo users are `admin@demo.com`, `propietario@demo.com`, and `cliente@demo.com`, all with password `demo1234`. Both backends seed the `barber-demo` shop, service “Corte clásico”, and professional “Alex Demo”.

## Environment

`NEXT_PUBLIC_GRAPHQL_URL` must be reachable from the browser. The MongoDB example uses `http://localhost:4400/graphql`; PostgreSQL uses `http://localhost:4500/graphql`.

Next.js embeds this public endpoint at build time. Each Compose file passes it as the frontend Docker build argument. Rebuild the frontend image after changing it. The Docker image listens on port 4301 internally; Compose exposes MongoDB's frontend on 4401 and PostgreSQL's on 4501.

`PLAYWRIGHT_BASE_URL`, `GRAPHQL_ENDPOINT`, and `DEMO_SHOP_SLUG` configure end-to-end tests. Export them in the shell or provide them on the command line; Playwright does not read `.env.local`.

## Project structure

```
src/
├── app/
│   ├── (client)/           # Public: home, search, barber profile, book flow, bookings, profile, favorites
│   ├── auth/               # login / register (client, owner, admin entry points)
│   ├── dashboard/          # OWNER shell: services, professionals, bundles, reviews, bookings, settings
│   ├── admin/              # PLATFORM_ADMIN shell
│   ├── onboarding/         # Owner barbershop onboarding
│   ├── layout.tsx
│   ├── providers.tsx       # SimfinityClientProvider, I18nProvider, AuthProvider (+ loading/error fallbacks)
│   └── globals.css         # Tailwind v4 + design tokens
├── components/
│   ├── shared/             # Tailwind UI library (ui/, form, layout, data, booking, maps, charts, modals, …)
│   └── custom/             # Auth layout / GoldTextField + stories
├── hooks/                  # useT, useFormState, usePagination, …
├── lib/                    # authContext, barbershopContext, simfinity/, initGuard (loading UI), …
├── theme/                  # barberTheme.ts (`tokens`), designTokens.ts
└── public/i18n/            # es.json, en.json (primary label source)
```

## Provider hierarchy

Defined in `src/app/providers.tsx`:

```
SimfinityClientProvider (GraphQL init + endpoint + prepareHeaders for JWT; loading/error fallbacks)
└── ClientRefCapture (ref for non-React use)
    └── I18nProvider (loads public/i18n/{locale}.json)
        └── SpanishLocale (forces `es` for this app)
            └── AuthProvider
                └── {children}
```

## GraphQL usage (patterns)

- **Scalar filters**: `.where("name", "CONTAINS", value)` (three arguments).
- **Relation filters**: `.where("barbershop", [{ path: "id", operator: "EQ", value: shopId }])`.
- **Mutations — relation fields**: use `{ id: "..." }`, not a raw string, e.g. `owner: { id: userId }`, `category: { id: categoryId }`.
- **State transitions**: `client.transition("barbershop", "submitforreview", id)` (names match backend schema).

## Internationalization

- Add keys to `public/i18n/es.json` and `public/i18n/en.json`.
- In components: `const t = useT("dashboard");` then `t("services.title", "Fallback")`.
- `I18nProvider` loads JSON at runtime; keep keys consistent across locales.

## Shared components

`src/components/shared/` is organized by domain (`form/`, `layout/`, `data/`, `booking/`, `maps/`, …) plus **`ui/`** for Tailwind primitives (`Surface`, `Button`, `Eyebrow`, …). Prefer importing from `@/components/shared` or sub-barrels. Each piece has a Storybook story where applicable.

## Styling conventions

- **`cn()`** — class merging with Tailwind conflict resolution: `import { cn } from '@/lib/cn'`. Use for any conditional `className`.
- **Primitives** — reuse `@/components/shared/ui` instead of copy-pasting long utility strings: surfaces → `<Surface>`, gold CTAs → `<Button variant="gold">` (or `buttonVariants({ variant: "gold" })` on `<Link>`), editorial kickers → `<Eyebrow>` or constants from `@/theme/typography`. Avoid hand-rolled `bg-gradient-to-br from-primary to-primary-container` for primary actions.
- **Variants** — new multi-state UI blocks should use `tailwind-variants` (`tv`) like the files in `shared/ui/`.
- **When to extract** — if the same long class string appears twice in a file or three times in the app, extract a primitive or shared fragment.

**Before**

```tsx
<button
  type="button"
  className="bg-gold-gradient text-on-primary-container px-10 py-4 rounded-xl font-bold text-[11px] uppercase tracking-[0.2em] shadow-lg hover:opacity-90 active:scale-95 transition-all"
>
  Siguiente
</button>
```

**After**

```tsx
import { Button } from '@/components/shared/ui';

<Button type="button" variant="gold" size="lg">
  Siguiente
</Button>
```

## Theme

Tailwind tokens live in `globals.css` (`@theme`). `src/theme/barberTheme.ts` exports **`tokens`** (hex) for occasional inline styles; `designTokens.ts` mirrors colors for JS when needed.

## Storybook

```bash
npm run storybook        # dev server — visual review
npm run build-storybook  # production build — required gate when stories or documented components change
```

Global styles load from `src/app/globals.css`; **Material Symbols** load via **`src/app/layout.tsx`** (`<link>` to Google Fonts) so icon ligatures resolve in production. Storybook injects the same font in `.storybook/preview.tsx`. When you change a component under `src/components/shared/` or `src/components/custom/`, **update its colocated `*.stories.tsx`** so Storybook stays accurate; run **`npm run build-storybook`** before considering the change done.

## Backend compatibility

The same frontend targets both [MongoDB](../mongodb/) and [PostgreSQL](../postgres/) backends: JWT user on context, generated CRUD and transition mutations. ObjectIds and UUIDs remain opaque string IDs. The frontend calls the API explicitly from page-level code.

The owner dashboard reads review professionals through `booking.professional`; the admin dashboard uses the shop city/name fields shared by both GraphQL schemas.

## Verification

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run start          # production server on 4401; use -- -p 4501 for PostgreSQL
```

`typecheck` generates Next.js route types before strict TypeScript checking. Vitest's unit project runs the inherited class-merge helper tests. Storybook configuration, browser tests, and all component stories remain available via `npm run build-storybook` and `npx vitest run --project storybook` (requires a Playwright browser).

With the selected full stack running:

```bash
npx playwright install chromium
GRAPHQL_ENDPOINT=http://localhost:4400/graphql PLAYWRIGHT_BASE_URL=http://localhost:4401 DEMO_SHOP_SLUG=barber-demo npm run test:e2e
GRAPHQL_ENDPOINT=http://localhost:4500/graphql PLAYWRIGHT_BASE_URL=http://localhost:4501 DEMO_SHOP_SLUG=barber-demo npm run test:e2e
```

Playwright checks home and search pages, actual client login, a complete booking against the seeded API, and the mobile shop layout. It creates a real demo appointment for the next month's 15th using the first available slot, then validates the mutation response ID and confirmation screen. The booking screenshot is written to `test-results/booking-confirmed.png`. Run these tests only against disposable example data; repeated runs create additional bookings.

## License

Apache License 2.0 — see `LICENSE` in this folder.
