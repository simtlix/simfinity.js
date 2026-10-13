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
| Tests | Vitest 4 (Storybook browser tests + `npm run test:unit`), Playwright | Unit tests for the class-merge, business-hours, booking-slot, booking-error and catalog helpers |

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

The pages follow the API's [booking rules](../README.md#booking-rules) and [bundle rules](../README.md#bundle-rules):

- The booking page lists only active services and bundles, and a reschedule also lists the inactive ones that are lines of the booking being moved. A `/book?bundle=` link preselects its bundle only while the bundle is active.
- The shop page shows inactive services and bundles as “No disponible”, without a booking link.
- Rescheduling keeps what the booking being moved already has, even when it is inactive now: its services, or its bundle when it is a booking of one bundle. A booking with services and a bundle, or with several bundles, which only the API creates, is rescheduled with its services only. A booking that only prefills the form, because it is not `CONFIRMED` or belongs to another shop, keeps only its active services and bundle.
- A reschedule keeps the prices the booking was made at, as the API does (`priceBookingLines` in `src/lib/catalog.ts`): each line takes the first unused stored line of the booking being moved with the same service or bundle and keeps its price (a negative one counts as 0); other lines take the catalog price. The cards, the summary, the review total and the lines sent use that price, so a booking made at 90 for a service that now costs 40 still shows and stores 90. The API keeps the sent price for the shop's owner and admins too. A booking that only prefills the form uses catalog prices.
- Unchecking a service of the selected bundle takes the bundle apart, and its services stay selected only where the page lists them. An active bundle can include an inactive service, which a client cannot book as a line of its own (`INVALID_BOOKING_LINE`) unless the booking being moved already has that line; a service the booking has only inside its bundle does not count.
- The booking page and the shop page compute a bundle's duration from its services' current durations, as the API does (`src/lib/catalog.ts`): a service listed twice counts twice, and a bundle none of whose services resolve uses its stored `totalDurationMinutes`. The booking page offers times for that duration.
- The dashboard's bundle edit page shows that duration read-only for a bundle with services and does not send it, since the API derives it. A bundle without services keeps its editable duration.
- The dashboard's new-booking page offers only the selected shop's services and professionals.
- Both booking pages explain booking rejections, including `INVALID_BOOKING_LINE`, through `src/lib/bookingErrors.ts`.

The admin “Reseñas Reportadas” page lists the reviews that shop owners flagged. It filters `isReported` with a boolean; earlier builds sent the string `'true'`, which both APIs reject, and showed an empty list. When the list cannot load, the page shows an error with a retry button instead of the empty state, and a failed dismiss or delete shows an alert.

The login pages show the server's message, such as the English `This account is suspended`.

Image fields (`FormImageUpload`) accept JPEG, PNG, WebP and GIF, the types the [upload API](../README.md#uploads) stores. They preview the chosen file in the browser and do not call `POST /api/uploads` yet.

## Verification

```bash
npm run test:security
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run start          # production server on 4401; use -- -p 4501 for PostgreSQL
```

`typecheck` generates Next.js route types before strict TypeScript checking. `test:unit` first checks the real Next.js lint rule against default and globbed application roots, then runs Vitest's class-merge, business-hours, booking-slot, booking-error and catalog helper tests. The catalog tests cover a bundle's duration from its services, which services and bundles clients can book on a new or moved booking, the prices a reschedule keeps, matched to the stored lines as the API matches them, and which services stay selected when a bundle is taken apart. Storybook configuration, browser tests, and all component stories remain available via `npm run build-storybook` and `npx vitest run --project storybook` (requires a Playwright browser).

The lockfile resolves `sharp` 0.35.5 and `source-map-js` 1.2.2 for their security fixes. Next.js 16, React 19 and the existing ESLint rules are retained. `@next/eslint-plugin-next@16.1.7` depends on `fast-glob`, whose `micromatch` dependency pulls in the unpatched `braces` stack-exhaustion vulnerability. A temporary override replaces **only that plugin version's** `fast-glob` with the registry package `tinyglobby@0.2.15`. The plugin uses only `globSync(pattern, { onlyDirectories: true })` to discover application roots; this is not a general replacement for the fast-glob API.

This app leaves `settings.next.rootDir` unset, so the plugin uses ESLint's current working directory without globbing. Tests also cover wildcard, brace and array root patterns. **Do not add literal directory paths to `settings.next.rootDir` while this override is in place:** tinyglobby expands literal directories recursively, unlike fast-glob. Use an explicit glob if custom roots are needed, and recheck this workaround when changing the plugin version. Remove the override once its upstream dependency chain has a supported fix.

With the selected full stack running:

```bash
npx playwright install chromium
GRAPHQL_ENDPOINT=http://localhost:4400/graphql PLAYWRIGHT_BASE_URL=http://localhost:4401 DEMO_SHOP_SLUG=barber-demo npm run test:e2e
GRAPHQL_ENDPOINT=http://localhost:4500/graphql PLAYWRIGHT_BASE_URL=http://localhost:4501 DEMO_SHOP_SLUG=barber-demo npm run test:e2e
```

Playwright checks home and search pages, actual client login, a complete booking against the seeded API, a reschedule, the mobile shop layout, inactive bundles, reschedule prices, bundles taken apart and review moderation. It finds the demo shop by `DEMO_SHOP_SLUG` with a filter on the server, so the API's 100-row limit for unpaged lists does not matter. It creates a real demo appointment for the next month's 15th using the first available slot, then validates the mutation response ID and confirmation screen. The reschedule test books the next month's 16th through the API, lets a second client take the time chosen on the page, and checks that the rejected `reschedule_booking` leaves the booking unchanged and that the next choice moves the same booking; it also cancels the original booking after the form loads and checks that the page reports the state change instead of confirming an unreserved time. It deletes its bookings and the second client afterwards. Four more tests check:

- **Inactive bundles:** the owner adds an inactive bundle through the API. The shop page shows it as “No disponible” without a booking link, and the client's `/book?bundle=` link to it neither lists nor selects it.
- **Reschedule prices:** the owner adds a service at 90, the client books it on the next month's 18th through the API, and the owner lowers its price to 40. The reschedule page shows 90 in the summary and the review, sends 90, and the moved booking keeps a total of 90.
- **Bundles taken apart:** the owner adds an active bundle of an inactive and an active service. The client selects the bundle and unchecks the active service; the inactive service is not listed or left selected, so the page cannot continue to a booking the API refuses.
- **Review moderation:** a client books the next month's 17th at the first free time, the owner completes the booking, the client reviews it and the owner flags the review. The admin's moderation page then lists the review.

These tests delete what they create. The booking screenshot is written to `test-results/booking-confirmed.png`. Run these tests only against disposable example data; repeated runs create additional bookings.

## License

Apache License 2.0 — see `LICENSE` in this folder.
