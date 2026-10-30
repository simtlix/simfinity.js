# Barber examples

Run the same barbershop booking app with either MongoDB or PostgreSQL. Both backends demonstrate generated GraphQL operations, relationships, query scopes, JWT authorization, controllers, state machines, and MCP tools. A shared Next.js frontend provides customer booking, an owner dashboard, and administration screens.

These are independent, private npm applications in the Simfinity monorepo, each with its own manifest and lockfile. Both backends install released Simfinity runtime packages at exactly **3.19.0** from npm; the frontend pins the published GraphQL client to the same version. They are outside the `packages/*` workspaces and are not published with the libraries.

Searches match text without regard to case, including accented letters, while `%` and `_` remain literal characters. The owner's unanswered-review filter includes empty replies. Administrators reject a shop and save its reason in one state transition.

Dashboard totals use server aggregates. The booking calendar and the owner dashboard's chart/detail data load every page with a stable ID order, so they do not silently stop at 100 records. Separate pages are live reads, not an atomic snapshot under concurrent writes.

## Start with Docker

Install Docker with Compose v2. Run the commands from `examples/barber`; a root `npm install` is not required for this flow.

```sh
cd examples/barber
cp .env.example .env
```

Choose a stack, then create the synthetic demo accounts and shop. Run `seed:admin` right after the stack is up:

```sh
docker compose -f compose.mongodb.yaml up --build -d --wait
docker compose -f compose.mongodb.yaml exec backend npm run seed:admin
docker compose -f compose.mongodb.yaml exec backend npm run seed:demo
```

Or use PostgreSQL:

```sh
docker compose -f compose.postgres.yaml up --build -d --wait
docker compose -f compose.postgres.yaml exec backend npm run seed:admin
docker compose -f compose.postgres.yaml exec backend npm run seed:demo
```

`seed:admin` writes the platform admin `admin@demo.com` directly to the database. It never promotes an existing account: anyone can register an email through the public API, so when `admin@demo.com` already belongs to an account with another role, such as a client or owner, `seed:admin` exits with an error instead. To recover, reset the stack with `docker compose -f compose.<db>.yaml down --volumes` and start again. Another admin email does not help the demo: `seed:demo`, both contract tests, the browser tests and the login page's demo button all sign in as `admin@demo.com` / `demo1234`. When the admin already exists, `seed:admin` reactivates it and keeps its password.

| Endpoint | MongoDB stack | PostgreSQL stack |
| --- | --- | --- |
| Frontend | [localhost:4401](http://localhost:4401) | [localhost:4501](http://localhost:4501) |
| GraphQL / GraphiQL | [localhost:4400/graphql](http://localhost:4400/graphql) | [localhost:4500/graphql](http://localhost:4500/graphql) |
| Health | [localhost:4400/health](http://localhost:4400/health) | [localhost:4500/health](http://localhost:4500/health) |
| MCP Streamable HTTP | `http://localhost:4400/mcp` | `http://localhost:4500/mcp` |
| Database host port | `57417` | `55441` |

The Compose projects are `simfinity-example-barber-mongodb` and `simfinity-example-barber-postgres`. Their ports, databases, and named volumes are separate, so both can run together. Inside each project's network, the backend listens on `4300` and the frontend on `4301`; those are container ports, not the default host ports.

MongoDB uses a single-node replica set initialized by its health check. PostgreSQL uses version 18 and waits for generated storage initialization before the API is ready.

## Try the demo

All three accounts use the password **`demo1234`**:

| Account | Role | Try |
| --- | --- | --- |
| `cliente@demo.com` | Client | Find the demo shop and book a service. |
| `propietario@demo.com` | Owner | Open the dashboard and manage the shop's catalog and bookings. |
| `admin@demo.com` | Platform administrator | Inspect users and the shop approval workflow. |

`seed:demo` creates the approved shop with slug `barber-demo`, the service “Corte clásico”, and the professional “Alex Demo”. It uses the running GraphQL API, so run `seed:admin` first and wait for a healthy backend. Each stack has its own data and generated IDs.

`seed:demo` finds the shop by its slug on the server, so the 100-row limit of an unpaged list does not matter however many shops exist. A rerun finishes a demo that an earlier run left incomplete: it adds a missing service or professional, submits a `DRAFT` shop for review and approves a `PENDING_REVIEW` shop as the admin. It stops with an error when the shop is `REJECTED` or `SUSPENDED`; it then needs an admin to make the shop `APPROVED` again.

It also stops when the slug belongs to another account, with `The shop <slug> belongs to another account; set DEMO_SHOP_SLUG to another slug`. Owners see other owners' shops only once they are `APPROVED`, so when the owner finds no shop with the slug, `seed:demo` looks again as `admin@demo.com`, who sees shops in every state. Another owner's `DRAFT`, `PENDING_REVIEW`, `REJECTED` or `SUSPENDED` shop therefore stops it too, instead of a duplicate-key error.

The accounts, passwords, addresses, and dataset are synthetic local demo fixtures. This MVP demonstrates application patterns; it is not a production deployment recipe. Payments are on site, and the reminder job is a stub.

Business hours store JavaScript day numbers (`0` = Sunday). Earlier frontend builds labeled every weekday in the hours editor one day late, and hours saved with them are not migrated automatically: review and re-save them, or reset and re-seed the stack.

## Shop lifecycle and upgrading existing shops

Every new shop starts in `PENDING_REVIEW`, whether created through onboarding, the admin page, GraphQL, MCP or the dataset loader. Both create pages use a single `addbarbershop` mutation; there is no second submission that can leave an incomplete draft. The owner dashboard shows the shop's state. Pending shops remain hidden from anonymous callers and clients until a platform admin approves them.

No data migration is needed for this change. Shops already stored as `DRAFT` keep that state. Their owner or a platform admin can still call `submitforreview_barbershop` to move them to `PENDING_REVIEW`; another owner cannot. The admin view keeps its submit button for those legacy drafts, and `seed:demo` still resumes them. A rejection saves its reason in the same state transition; resubmission and approval clear that reason.

## Booking rules

Bookings use optimistic concurrency. Reads include numeric `version: RecordVersion!`; a create starts at 1. Updates and state transitions must send the version the caller read, and each accepted write increments it once. Deletes require `deletebooking(id, version)`, and a nested booking deletion uses `{ id, version }`. Other entities, including barbershops, remain unprotected. GraphQL and MCP enforce the same preconditions.

A stale write returns `VERSION_CONFLICT` (409) and changes nothing. The edit, action, cancellation and reschedule pages keep the observed version and explain the conflict; reload to see the current record before deciding what to save. In particular, an owner cannot overwrite a client's newer reschedule by saving an older form. No page silently reads a newer version and retries an outdated payload.

### Upgrading an existing booking database

MongoDB documents without `version` read as version 1; no migration is needed. PostgreSQL refuses startup with `SCHEMA_MISMATCH` until an explicit migration adds the managed column. For the default `DATABASE_SCHEMA=barber`, the tested migration from that diagnostic is:

```sql
ALTER TABLE "barber"."booking" ADD COLUMN "version" bigint NOT NULL DEFAULT 1;
```

Use the actual schema name if configured differently. Stop old application instances and apply this migration immediately before starting the protected backend; old instances do not participate in version checks. Fresh databases create the column automatically. There is no automatic migration of existing tables. See the [concurrency guide](../../docs/guide/concurrency.md) for native writes and coordinated rollback requirements.


Both APIs check a confirmed booking when it is created and when an update changes its shop, date, start time, professional or services. They compare stored and new values, so an edit form can resend unchanged fields, for example to save notes on a booking already in progress:

- When it is created or moved to another date or start time, it needs a `scheduledDate` (`YYYY-MM-DD`) and a `startTime` (`HH:mm`), and it must start at least `minAdvanceHours` from now and at most `maxAdvanceDays` ahead, in the shop's `timezone` (UTC when the shop has none). The shop must be `APPROVED`, as it must be for a booking moved to another shop. A booking that keeps its time, for example one that gets another service, is checked only against the rules below.
- Its services plus the shop's `bufferMinutes` must fit that weekday's opening hours and avoid the break. A professional's own row for the weekday narrows the shop's: the day is closed when either row closes it, it opens at the later opening and closes at the earlier closing, and both breaks apply. Closed days reject bookings; a weekday on which neither the shop nor the professional has a row has no hour limits. A closing or break end of `24:00` means midnight.
- It must not overlap another confirmed booking of the same professional, buffer included. A booking without a professional holds the whole shop.

Each booking line must reference exactly one service or bundle of the booking's barbershop. A `durationMinutes` sent with it must be a whole, non-negative number, and a sent `price` a non-negative number. Otherwise the API rejects the create or line update with `INVALID_BOOKING_LINE`, as it does for a line that names another shop's service or bundle. The API then takes each line's values from the shop's catalog:

- **Duration:** the service's `durationMinutes`, or for a bundle the sum of its current services, each listing counted. A bundle without services, or none that still exist, keeps its own `totalDurationMinutes`. A sent duration is ignored.
- **Price:** a new line gets the catalog price. A line whose service or bundle the booking already has keeps its stored price, so rescheduling keeps the booked price after a catalog change. Only the barbershop's owner and platform admins may send another price: from 0 up to the catalog price, or the line's stored price.
- **Inactive items:** clients, and owners of other shops, cannot add a service or bundle whose `isActive` is `false` (`INVALID_BOOKING_LINE`). A booking that already has one keeps it when its lines are resent. The barbershop's owner and platform admins may book inactive items.

The API always stores `totalPrice` as the sum of the line prices (0 without lines). It recomputes it on every create and every update, state transitions included. It also always stores `endTime` as the start time plus the line durations (`24:00` for a booking that ends at midnight). A `totalPrice` or `endTime` sent to `addbooking` or `updatebooking` is ignored, so a client can neither change the price nor shorten or stretch the held time.

When the API creates a booking, it also sets `confirmationCode` and `createdAt`: a sent code is ignored, and `createdAt` is read-only, so the booking inputs and the MCP tool inputs do not have it. Only a MongoDB line whose reference no longer resolves keeps its captured duration and price, because MongoDB accepts dangling references, and only for the barbershop's owner or a platform admin; anyone else gets `INVALID_BOOKING_LINE`. The API also stores `startTime` as zero-padded 24-hour `HH:mm` (`9:00` becomes `09:00`). The same rules apply to bookings that the barbershop's owner adds through `updatebarbershop` with `bookings: { added: [...] }`; the MongoDB API used to reject those with a `CastError`.

Rejections use the codes `BOOKING_SLOT_UNAVAILABLE`, `BOOKING_OUTSIDE_HOURS`, `BOOKING_OUTSIDE_ADVANCE_WINDOW`, `INVALID_BOOKING_TIME`, `INVALID_BOOKING_LINE` and `INVALID_BOOKING_PROFESSIONAL`, plus `INVALID_BOOKING_BARBERSHOP`, a defensive check for a booking nested in a barbershop mutation that is linked to another shop (the generated nested booking input has no `barbershop` field, so clients cannot send one). Concurrent bookings for the same schedule are serialized inside the database transaction; when retries run out, both APIs return `BOOKING_SCHEDULE_BUSY` and the client can try again. See the backend READMEs.

Existing bookings are not revalidated or migrated. A total stored by an earlier version is corrected by the booking's next update. A line price stays while its line keeps the same service or bundle, and stored confirmation codes and creation times stay. When a booking is checked again, a negative line duration or price stored by an earlier version counts as zero.

Who books and edits a booking:

- `client` defaults to the signed-in user. The barbershop's owner may name a client, or leave it empty for a walk-in at their own shop, and a platform admin may name a client. Anyone else is the client, including an owner who books another owner's shop and an admin who names no client. Bookings that earlier versions saved without a client are not migrated; an admin can set their client.
- Clients change only their own `CONFIRMED` bookings, notes included. Completed and cancelled bookings are history that only the barbershop's owner or a platform admin edits; clients get `FORBIDDEN`.
- Clients cancel with `cancelbyclient_booking` instead of deleting: `deletebooking`, and `updateuser` with `bookings: { deleted: [...] }`, are `FORBIDDEN` for them. Only the barbershop's owner or a platform admin deletes a booking, and the owner only while no review references it (see below).
- A booking always keeps its barbershop: nobody clears it, and only a platform admin moves it to another shop. Moving it does not recheck its lines. Bookings without a shop, left by earlier versions or by an admin's delete on MongoDB (see below), stay that way until an admin sets their `barbershop`.
- Only the barbershop's owner or a platform admin clears a booking's `client`, which turns it into a walk-in.

Bookings and reviews keep the records they reference. The barbershop's owner cannot delete a shop while bookings or reviews reference it, nor a booking while a review references it. Both APIs answer `RESOURCE_IN_USE` (409), for root deletes and for deletes nested in another mutation; PostgreSQL would otherwise answer with its foreign key's `REFERENCE_CONSTRAINT_VIOLATION`, and MongoDB would leave those bookings and reviews pointing at nothing. Anyone else who is not a platform admin still gets `FORBIDDEN`. A platform admin's deletes are not checked:

- PostgreSQL's foreign keys refuse them with `REFERENCE_CONSTRAINT_VIOLATION`.
- MongoDB deletes the record. The bookings and reviews that referenced it keep the stored ID, which reads as `barbershop: null` or `booking: null`; see [reference integrity](#validate-changes).

Only bookings and reviews are checked. On MongoDB, the owner can still delete a shop that has no bookings or reviews but still has services, service categories, professionals, bundles or favorites; those keep its ID too. PostgreSQL's foreign keys refuse that delete.

Clients cannot read other clients' bookings, so the booking page reads taken times from the barbershop's `busyRanges` field. It requires a signed-in user and returns only the start time, end time and professional ID of the shop's confirmed bookings on a date, in clock order. `professionalId` narrows it to the ranges that block that professional. `excludeBookingId` leaves out one booking when the signed-in user is its client; other bookings are never left out. A shop that is not `APPROVED` takes no bookings: its owner and platform admins, who can read it, get `Barbershop is not available for booking`, and a shop the caller cannot read, or that does not exist, reads as `barbershop: null`. A malformed `excludeBookingId` returns `NOT_VALID_ID` from both APIs; a malformed shop ID fails in the generated `barbershop(id:)` query, with `NOT_VALID_ID` on PostgreSQL and `INVALID_FILTER_VALUE` on MongoDB. When the API rejects the chosen time, the page explains why, reloads the taken times and returns to the time step.

```graphql
query BusyTimes {
  barbershop(id: "<shop id>") {
    busyRanges(date: "2026-10-15") {
      startTime
      endTime
      professionalId
    }
  }
}
```

`busyRanges` is a [virtual field](../../docs/guide/queries.md#virtual-fields) with arguments on the barbershop type (`extensions: { virtual: true }`), not a custom root operation. The read goes through the generated `barbershop(id:)` query, so the barbershop's `get_by_id` scope and the field's own permission rule (`barbershop.busyRanges` in `auth/permissions.js`) apply, and it stays a read-only query. Its resolver reads bookings natively, outside the booking scope that shows clients only their own bookings, and returns no client or booking details. Neither backend stores the field: the barbershop table has no column for it and shop documents have no key for it. It is not part of the query language either: generated inputs leave it out, `barbershops`, `barbershops_aggregate` and `user.barbershops` have no `busyRanges` argument, so a client that sends one fails GraphQL validation (`Unknown argument "busyRanges"`), and a sort or aggregation path through it fails with `FORBIDDEN_FILTER_PATH`. Selected on a list of shops, it runs its reads once per shop. MCP agents read it through the [`barbershop_busyRanges` tool](#mcp). Earlier versions served the same read as the `bookingAvailability` mutation, because Simfinity registers custom mutations but not custom queries; that mutation and its MCP tool were removed.

To reschedule, the booking page calls `reschedule_booking` with its new date, time, professional and services. This `CONFIRMED -> CONFIRMED` action checks the booking's current state inside the transaction, then validates and moves its slot. Its overlap check ignores the booking itself, so the new time may overlap the old one. A rejected slot leaves the booking at its original time; if the shop has cancelled or completed it since the form loaded, the stale version is rejected with `VERSION_CONFLICT` and the page asks the client to reload. An action sent with the current version in a non-confirmed state still rejects with `BAD_REQUEST`. The booking keeps its ID and confirmation code. A booking already known to be non-confirmed when the page loads only prefills the form; confirming that form creates a new booking. Generic `updatebooking` remains available for historical-record edits by the barbershop's owner and platform admins; clients may change only their `CONFIRMED` bookings.

## Bundle rules

A bundle's price must be lower than the sum of its services' prices, and its `totalDurationMinutes` is the sum of their durations. Both count every listed service, so a service listed twice counts twice. Each service must exist and belong to the bundle's barbershop; otherwise the API answers `INVALID_BUNDLE_SERVICE`. The API checks this when a bundle is created, nested creates included, and when an update changes its services or moves it to another shop. Other edits of bundles saved by earlier versions still save. A bundle with services always derives its duration and ignores a sent value; a bundle without services keeps the duration its owner sets.

The stored total follows the services:

- When a listed service's `durationMinutes` changes or is cleared, through `updateservice` or a shop's `updatebarbershop` with `services: { updated: [...] }`, the API stores the new `totalDurationMinutes` of every bundle that lists the service, in the same transaction.
- On MongoDB, deleting a listed service recomputes those totals without it. PostgreSQL's foreign key refuses to delete a service that a bundle lists.
- A bundle none of whose services still exist keeps its stored total.
- Any other save of a bundle with services also stores their current total, so a total that an earlier version left behind a service edit is corrected by the bundle's next save, or by the next duration change of one of its services. Stored totals are not migrated.

Changing a service's price does not change the bundles that list it. Bookings use the current services' durations, and so do the booking page and the shop page; see the booking rules.

Moving a service to another of the owner's shops with `updateservice`, or deleting it on MongoDB, is not blocked. After that, the bundles that list the service can no longer be saved with their services (`INVALID_BUNDLE_SERVICE`). Bookings that list it get `INVALID_BOOKING_LINE` when their lines are resent.

## Review rules

A review rates an `APPROVED` barbershop through a `COMPLETED` booking that its author made there. For anyone but a platform admin, `addreview` checks, inside the review's transaction:

- The shop exists and is `APPROVED`; otherwise `INVALID_REVIEW_BARBERSHOP` (400).
- The shop is not the caller's own; otherwise `FORBIDDEN`.
- A booking is given; otherwise `REVIEW_BOOKING_REQUIRED` (400).
- The booking is the caller's own `COMPLETED` booking at that shop; otherwise `INVALID_REVIEW_BOOKING` (400). Every mismatch gets this one code, so the answer does not reveal other clients' bookings.
- The review's `client` is the caller; otherwise `FORBIDDEN`.

For everyone, admins included, a booking takes one review; a second one gets `REVIEW_ALREADY_EXISTS` (409). A platform admin may import a review without a booking. There is no lock. The review controller rewrites the shop's `averageRating` and `reviewCount` in the same transaction, so of two concurrent reviews of one booking, the later one conflicts, is retried and gets `REVIEW_ALREADY_EXISTS`. When the retries run out, the API answers `TRANSACTION_RETRY_EXCEEDED` (409).

Who writes what:

- The author writes the rating and the comment. On create and on update, the author cannot write the reply or the moderation flag (`isReported`), whether setting or clearing them. Once the review exists, the author cannot change or clear its booking.
- The barbershop's owner replies to an existing review, withdraws a reply (`reply: null`) and flags the review (`isReported: true`), with `updatereview` or through `updatebarbershop` with `reviews: { updated: [...] }`. The owner cannot change anything else and cannot clear a flag.
- Only a platform admin clears a flag and deletes a review, so an author cannot delete a flagged or answered review and post it again. The barbershop's owner cannot delete the reviewed booking or the shop either (`RESOURCE_IN_USE`; see the [booking rules](#booking-rules)).
- Nobody moves a review to another shop.
- `createdAt` is read-only and set by the API; `reviewInput` and the MCP tool inputs do not have it.

These checks reject a write with `FORBIDDEN`. As with bookings, a field counts as written only when it differs from the stored value, so an edit form or an agent can resend unchanged fields.

Existing reviews are not migrated or revalidated. Reviews from earlier versions without a booking, duplicates and self-reviews remain and still count in the ratings.

## Accounts and access

Sign in with the GraphQL `login` mutation, for example in GraphiQL:

```graphql
mutation SignIn {
  login(input: { email: "cliente@demo.com", password: "demo1234" }) {
    accessToken
    refreshToken
  }
}
```

Send the access token as `Authorization: Bearer <accessToken>` to GraphQL, MCP and uploads. It lasts 15 minutes; `refreshSession` exchanges the 7-day refresh token for a new pair. One request may run only one of `login`, `register`, `registerOwner` and `refreshSession`: a request that runs more, through aliases or fragments, fails validation with the code `AUTH_OPERATION_LIMIT`. For `application/json` requests, that error arrives with HTTP 200, in `errors`.

An admin suspends an account by setting its `status` to `SUSPENDED`. After that, `login` and `refreshSession` fail with `ACCOUNT_SUSPENDED` (403). A wrong password still gets `Invalid email or password`, so the answer does not reveal the suspension. Every authenticated GraphQL request, MCP tool call and upload reads the account by its ID, so access tokens already issued stop working at the next request. The same happens when an account is deleted, and to a token that is expired or fails verification:

- GraphQL treats such a token as anonymous, on purpose, so public pages still render; signed-in actions fail with `UNAUTHENTICATED`.
- Uploads answer 401.
- MCP tool calls fail with an error that names the cause; see [MCP](#mcp).

Reactivating the account restores access. The login pages show the server's English message, `This account is suspended`.

Requests also use the role stored in the database, not the role in the token. A promotion or demotion therefore applies to tokens already issued, and a demoted admin's earlier token cannot restore its role. Admins can still suspend or demote themselves. `seed:admin` reactivates a suspended admin, but it does not restore a demoted one; then only a reset recovers the admin.

Scopes decide what each caller sees:

- Anonymous callers and clients see `APPROVED` barbershops and their services, service categories, professionals, bundles and reviews.
- Owners see `APPROVED` barbershops plus their own shops in any state. Other owners' `DRAFT`, `PENDING_REVIEW`, `REJECTED` and `SUSPENDED` shops are hidden from lists, reads by ID, aggregates and MCP tools. Owners' catalog reads cover only their own shops, so another owner's shop page shows them the shop without its catalog.
- Clients see their own bookings. Owners see their shops' bookings plus the bookings they made as clients. Anonymous callers see no bookings.
- Platform admins see everything.

These backends install exact 3.19.0 registry packages. Relation filters through `user.barbershops` use the `Barbershop.find` frame scope and match only visible shops; the user scope still restricts non-admin callers to their own user row. Collection filters return each parent once, including counts and pagination. Keep `intersectScopeFilter` append-based and preserve client objects and markers; never wrap a marked condition in a trusted quantified group. A favorite, or a booking the owner made as a client, whose shop the caller cannot see resolves `barbershop: null`. A shop's `rejectionReason` is visible to its owner while the shop is `REJECTED`; resubmitting or approving the shop clears it. Shops that earlier versions approved keep a stale reason until it is cleared with `updatebarbershop` or the shop is resubmitted or approved again.

### Request limits

Each backend counts requests per minute, with a separate counter for each limit:

| Requests | Default per minute | Counted by | Environment variable |
| --- | --- | --- | --- |
| `/graphql` | 300 | Client IP | `GRAPHQL_RATE_LIMIT_MAX` |
| `/mcp` | 300 | Client IP | `MCP_RATE_LIMIT_MAX` |
| `POST /api/uploads`, before authentication | 100 | Client IP | `UPLOAD_IP_RATE_LIMIT_MAX` |
| `POST /api/uploads`, after authentication | 20 | Account | `UPLOAD_RATE_LIMIT_MAX` |

A value that is not a positive integer stops the server at startup. `/health` and stored files (`GET /api/uploads/...`) are not limited. Over a limit, GraphQL answers 429 with a plain-text message, MCP with a JSON-RPC error (code `-32000`), and uploads with `{ "error": "Demasiadas subidas, intenta de nuevo en un minuto" }`.

The counters live in each process's memory and use the client IP as Express sees it, without a trusted proxy. Behind Docker's port forwarding, NAT or a reverse proxy, many users can share one IP budget. The Compose files pass these variables through from the example's `.env`, with the defaults above when it does not set them (see [`.env.example`](.env.example)). A host process reads them from its shell or from the backend's `.env`.

## Uploads

Both backends store images through `POST /api/uploads` (`routes/upload.js`, the same file in both):

- Send `Authorization: Bearer <accessToken>` and a multipart body with exactly one part: a file named `file`. Any other field or part is rejected.
- The optional `?folder=` names a subfolder of up to 5 segments of letters, digits, `_` and `-`, each up to 64 characters. A repeated `?folder` gets 400.
- The API stores only JPEG, PNG, WebP and GIF images up to 5 MB. It reads the type from the file's first bytes: the declared type only has to be one of these four, and the client's file name and declared type are otherwise ignored. The file is stored as `<uuid>.jpg`, `.png`, `.webp` or `.gif`, after the detected type, and the response is `{ "filename": ..., "url": ... }`.
- SVG is refused as defense in depth. It can carry scripts, even though stored files are served inert.

Errors are JSON `{ "error": ... }`:

| Status | When |
| --- | --- |
| 400 | Not one of the four image types (`Solo se permiten imagenes (jpeg, png, webp, gif)`), no file (`No se envio ningun archivo`), another field or part (Multer's limit messages, such as `Too many fields`, `Too many files`, `Too many parts` or `Unexpected file field`), a malformed multipart body, or an invalid folder. |
| 401 | A missing token (`Token requerido`), or an expired or invalid token or one of a suspended or deleted account (`Token invalido`). |
| 408 | The body did not arrive within 60 seconds (`La subida tardo demasiado`); the server closes the connection. |
| 413 | A file above 5 MB, or a declared `Content-Length` above 5 MB plus 64 KiB, which is refused before authentication (`Archivo demasiado grande (max 5MB)`). |
| 429 | An upload rate limit; see [request limits](#request-limits). |
| 500 | The file could not be stored (`No se pudo guardar el archivo`), including when the staging folder cannot be created or written, for example on `EACCES`, `EMFILE` or `ENOSPC`. The server logs the cause; the answer names no server path. |
| 503 | The account could not be read (`No se pudo verificar la sesion`). |

An upload streams to `uploads/.incoming/` under a random name, so it is not held in memory, and is moved into place once its bytes are checked. Dot files and dot folders are never served. A rejected, failed, aborted or timed-out upload removes its staged file. When the server stops during an upload:

- Staged files that a crash or a forced kill leaves in `uploads/.incoming/` are removed at the next start, once they are older than the upload timeout (60 seconds) plus 60 seconds. The margin spares uploads still in flight on another server that shares the folder.
- On `SIGTERM` or `SIGINT`, the server stops accepting connections and gives requests in flight 5 seconds. It then closes their connections, which aborts a stalled upload, waits until the staged files are removed, and exits within Compose's default 10-second stop timeout.

Every stored file is served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Files that earlier versions stored under other extensions, such as `.html`, `.js` or `.css`, keep their URLs but are served as `Content-Type: application/octet-stream` attachments (`Content-Disposition: attachment`). A browser downloads them instead of showing them, and with nosniff it neither runs one through `<script src>` nor applies one through `<link rel="stylesheet">` on another page. SVG images that earlier versions accepted keep `image/svg+xml`, so pages still show them through `<img>`, which runs no script; opened directly they are sandboxed downloads. They are not migrated or deleted.

Disk usage grows without bound over time. There is no quota or cleanup of stored files, only the rate limits: 20 uploads of up to 5 MB per account per minute. `docker compose -f compose.<db>.yaml down --volumes` erases a stack's uploads.

The shared frontend's image fields accept the same four types. They preview the chosen file in the browser and do not call this route yet.

## MCP

Both APIs also expose `/mcp`. HTTP requests use the same bearer JWT context, permissions and scopes as GraphQL. The tools cover the GraphQL operations except `login`, `register`, `registerOwner` and `refreshSession`, which stay GraphQL-only over both HTTP and stdio; earlier versions published them as tools. Get an access token from the GraphQL `login` mutation, as shown in [accounts and access](#accounts-and-access), and renew it with `refreshSession`.

Agents read taken times through `barbershop_busyRanges`, the read tool that Simfinity generates for the virtual [`busyRanges`](#booking-rules) field, because its `date` argument is required. The tool takes the shop's `id` plus `date`, `professionalId` and `excludeBookingId`, runs `barbershop(id:) { busyRanges(...) }` with the same scope and permission rules as GraphQL, so it needs a signed-in user's token, and returns `{ barbershop: { busyRanges: [...] } }`, or `{ barbershop: null }` for a shop the caller cannot read. Its annotations mark it read-only. The `barbershop` tool does not select `busyRanges`, since generated tools never select a field with a required argument, and the list and aggregate tools have no `busyRanges` input. Earlier versions published the same read as the `bookingAvailability` mutation tool.

A tool call whose bearer token cannot sign in fails with a JSON-RPC error instead of running anonymously. Only a request without a bearer `Authorization` header runs as anonymous; the scheme is case-insensitive, and `Bearer` with no token fails verification. The error names the cause:

| Token | `error.message` | `error.data.code` |
| --- | --- | --- |
| Expired | `The access token expired at <ISO time>; renew it with GraphQL refreshSession` | `UNAUTHENTICATED` |
| Fails verification (malformed, empty or signed with another secret) | `Invalid access token; sign in again with GraphQL login` | `UNAUTHENTICATED` |
| Of a deleted account | `The account of this access token no longer exists` | `UNAUTHENTICATED` |
| Of a suspended account | `This account is suspended` | `ACCOUNT_SUSPENDED` |

So HTTP `/mcp` and `mcp:stdio` agree: neither runs an expired token as anonymous. GraphQL still treats these tokens as anonymous, and uploads answer them with 401; see [accounts and access](#accounts-and-access).

The endpoint serves `POST`; other methods, such as the `GET` an MCP client sends to open an event stream, receive `405` with `Allow: POST`. It answers a JSON-RPC batch (an array body) with HTTP 400 and the JSON-RPC error `-32600`, so one request is one call, and it has its own [rate limit](#request-limits). The `mcp:stdio` command provides a separate transport, signed in with the `MCP_BEARER` access token and optionally renewed with `MCP_REFRESH_TOKEN`; see the backend READMEs.

Request bodies that the endpoint cannot parse get a JSON-RPC error with `id: null`, as JSON:

- A body that is not JSON: HTTP 400 and `-32700` (`Parse error: the request body is not valid JSON`).
- A body over the 100 kB limit of Express's JSON parser: HTTP 413 and `-32000` (`Request body too large`).
- Another rejection by the parser, such as an unsupported charset: its own status and `-32000`.

Any other error that reaches Express, on any route, answers JSON `{ "error": ... }` without a stack trace or server paths. A client error keeps its status; anything else is logged and answers 500 `Internal server error`.

## Configure and develop

The example root [`.env.example`](.env.example) controls Compose host ports, bind address, public hostname, PostgreSQL password, JWT secrets, and [request rate limits](#request-limits). Ports bind to `127.0.0.1` by default. After changing ports or `PUBLIC_HOST`, rebuild the stack: Next.js embeds the browser's GraphQL URL at build time.

For host development, use Node.js 24 and install each app independently with `npm ci` in its directory. Each backend's `.env.example` supplies its host connection and API settings; the frontend uses `.env.local`.

- [MongoDB backend setup and commands](mongodb/README.md)
- [PostgreSQL backend setup, native APIs, and schema export](postgres/README.md)
- [Shared frontend setup and tests](frontend/README.md)

The root Compose `.env` and the app-specific environment files serve different processes. Keep connection strings and JWT secrets consistent when mixing a host process with Docker services.

## What to compare

| Concern | MongoDB backend | PostgreSQL backend |
| --- | --- | --- |
| Runtime dependency | `@simtlix/simfinity-js` | `@simtlix/simfinity-postgres`, shared core, and MCP |
| GraphQL identity | ObjectId represented as `ID` | UUID represented as `ID` |
| Native database work | Mongoose models, documents, and sessions | PostgreSQL models, plain records, and sessions |
| Relationships | Mongoose references and embedded documents | UUID foreign keys, JSONB values, and private owned tables for embedded references |
| Startup | Connect to the replica set and register the schema | Register the schema and await generated storage initialization |

The shared frontend treats IDs as opaque strings. Relationship metadata, role scopes, controller responsibilities, and state transitions express the same domain, while native database calls stay in their own backend. Choosing a Compose file selects an application; there is no runtime database switch or automatic data migration.

Start reading either backend at `application.js`, then inspect `types/`, `auth/`, `routes/`, and `database.js`. Entity files register GraphQL types; adjacent `.scopes.js`, `.controller.js`, and `.stateMachine.js` files hold behavior. The domain includes users, shops, categories, services, bundles, professionals, bookings, reviews, favorites, and notifications.

## Validate changes

Install and run each backend's unit suite from the repository root:

```sh
npm ci --prefix examples/barber/mongodb
npm test --prefix examples/barber/mongodb
npm ci --prefix examples/barber/postgres
npm test --prefix examples/barber/postgres
```

With a stack running and seeded, run its shared HTTP contract from the matching backend directory:

```sh
# In examples/barber/mongodb
GRAPHQL_ENDPOINT=http://localhost:4400/graphql npm run test:http

# In examples/barber/postgres
GRAPHQL_ENDPOINT=http://localhost:4500/graphql npm run test:http
```

Each `test:http` run stores one 1×1 PNG in the backend's `uploads/http-contract/` folder and makes 5 upload requests from one IP, 4 of them by its own new client account. It also sends about 118 GraphQL requests and 10 MCP requests. `test:query-mutations` sends about 200 GraphQL requests. With the default `GRAPHQL_RATE_LIMIT_MAX` of 300 per minute per IP, two `test:http` runs fit in one minute, but one run of each does not. Both contracts wait for the window to reset when the API answers 429 (up to three times), so a rerun, or the seeds in the same minute, slows a run down instead of failing it and leaving its records behind. To rerun without waiting, raise `GRAPHQL_RATE_LIMIT_MAX`, `UPLOAD_IP_RATE_LIMIT_MAX` and `MCP_RATE_LIMIT_MAX` for the backend under test; the Compose files pass them through from `.env`.

`test:http` creates its own accounts, a temporary approved shop with the slug `in-use-<uuid>` owned by its own owner account, and bookings, including two by the admin, and deletes them at the end. Its expired-token MCP check signs the token with `JWT_SECRET` from the contract's environment, or with the backend's built-in default when that is unset. A backend with another secret, such as a Compose stack, sees that token as invalid rather than expired, so without `JWT_SECRET` the check accepts either message. Export the backend's `JWT_SECRET` to check the expiry message too.

Run the filter, aggregation and nested-mutation matrix against each disposable API:

```sh
GRAPHQL_ENDPOINT=http://localhost:4400/graphql npm run test:query-mutations --prefix examples/barber/mongodb
GRAPHQL_ENDPOINT=http://localhost:4500/graphql npm run test:query-mutations --prefix examples/barber/postgres
```

Run these two commands from the repository root. The matrix creates its own synthetic users and catalog after `seed:admin`; it leaves them in the disposable database for diagnosis. It checks scalar/enum/null filters, nested AND/OR groups, relation paths, sorting/counts/pagination, COUNT/SUM/AVG/MIN/MAX with filters, scopes, nested create/update/delete, embedded replacement/clearing, authorization and transactional rollback. Set `CONTRACT_REPORT` to write a JSON result file. The dedicated CI runs it on both databases and saves the reports.

The scopes preserve caller filters and intersect them with server restrictions. For example, selecting one shop still returns only that shop when the owner can access several; a booking OR filter remains combined with the owner's access rule. A requested user ID outside the scope returns null or an empty list.

The catalog scopes (services, service categories, professionals, bundles and reviews) and the owner branch of the booking scope restrict through the `barbershop` relation. They use `barbershop.state` = `APPROVED` for anonymous callers and clients, and `barbershop.owner.id` = the caller for owners; the barbershop scope applies the same terms to the shop itself. The database applies the restriction in the same query that reads the records. Simfinity runs a scope for every parent row of a nested list and for every referenced record it resolves, so a scope must not load shop IDs itself. Earlier versions did, which added barbershop queries per row: for example, 401 barbershop reads for one nested catalog page with 106 shops on PostgreSQL. Referenced records whose type has a `get_by_id` scope are still read with one query per reference. The [MongoDB README](mongodb/README.md#application-layout) describes what the owner path costs there.

**Reference integrity differs:** PostgreSQL FKs reject an embedded reference to a nonexistent service and roll back the mutation. The MongoDB example uses the default integrity mode and can store that reference and resolve it to null on reads; Mongoose references are not foreign keys. The matrix checks this difference explicitly. Since 3.4.0, Simfinity offers an opt-in [transactional Mongo integrity adapter](../../docs/guide/mongodb-integrity.md); the MongoDB example does not enable it, so the matrix expects the dangling reference on 3.19.0 too.

These tests exercise login, scopes, booking rules and availability, and MCP against a real backend and create test records. The HTTP contract also covers:

- account suspension and role changes, including MCP calls with a suspended account's token, an expired token and an invalid one;
- uploads, rate-limit headers, and that the per-account upload limiter is mounted;
- the MCP tool catalog without auth tools, batch rejection, the JSON-RPC answer to a malformed body, and the single-auth-operation rule;
- review rules: reply, flag, delete and eligibility, including the owner's nested reply and flag;
- owner and admin defaults for a booking's client: an owner booking another owner's shop, the owner's walk-in, and an admin with and without a named client;
- the shop a booking keeps, and the deletes that bookings and reviews block (`RESOURCE_IN_USE`).

The query-mutation matrix also covers:

- owner visibility of shops, bookings and rejection reasons;
- derived booking fields;
- shop and inactive-item checks;
- kept line prices;
- edits of completed bookings;
- bookings nested in a shop;
- bundle rules for repeated services and shops;
- bundle durations that follow their services' durations, so they match what a new booking of the bundle holds.

Both backends also have real-database checks for transactions, derived domain values, review eligibility with a concurrent-review race, correction of legacy booking totals, account suspension, `seed:admin`, `mcp:stdio` and the number of reads that scopes cause, plus dataset loading and deletion with shop ratings. PostgreSQL adds storage, foreign-key, and frontend-query checks; see the backend READMEs. The frontend has its own unit, type, build, and browser checks.

The dedicated [Barber workflow](../../.github/workflows/barber.yml) owns these apps' validation, including a database matrix and browser checks against both backends. It also runs `npm run test:security` for each application, auditing both runtime and development dependencies in its own lockfile. Root library lint and Vitest discovery exclude `examples/`; root package release checks do not install or publish these apps. Example changes do not require an npm library release.

After updating dependencies, audit all three applications independently:

```sh
npm run test:security --prefix examples/barber/mongodb
npm run test:security --prefix examples/barber/postgres
npm run test:security --prefix examples/barber/frontend
```

Use Node.js 24 and the committed lockfiles. The MongoDB example requires Mongoose `^8.24.2`; both backends require Multer `^2.3.0` and GraphQL Yoga `^5.24.4`; Vitest and its browser/coverage packages require `^4.1.11`; the frontend requires Next.js `^16.3.8`. These minima exclude the reviewed vulnerable direct versions. The backends consume the exact released Simfinity 3.19.0 packages, whose MCP integration requires the `@modelcontextprotocol/sdk` peer at `^1.31.0`; both backend lockfiles resolve 1.32.1.

The backend lockfiles also include the security fixes in `@graphql-tools/utils` 12.0.3, `@fastify/busboy` 3.2.2, `proxy-addr` 2.0.8, `source-map-js` 1.2.2 and `@hono/node-server` 2.1.5. The frontend uses patched `sharp` 0.35.5 and `source-map-js` 1.2.2, plus a temporary dependency override for Next.js linting described in its [security notes](frontend/README.md#verification). Preserve these fixes when refreshing dependencies and run all three application audits before merging.

The upgrade from 3.3.0 left database selection, seeding, the generated PostgreSQL schema and GraphQL responses unchanged. Each backend's `index.yoga.js` changed in two places:

- Envelop's `useErrorHandler` passes `{ errors, context, phase }`, not an error, so the server logs each entry of `errors` through `buildErrorFormatter(console.error)` instead of passing the formatter to `useErrorHandler`. Given that object, the formatter now logs only `Unexpected error value`, without the errors; see [error formatting](../../docs/resources/compatibility.md#error-formatting). Each logged error now shows its own message and code.
- `/mcp` is mounted with `app.all`, so the handler answers methods other than `POST` with `405` and `Allow: POST`; with `app.post`, Express returned `404`, which MCP clients report as a transport error. See the [MCP Streamable HTTP handler](../../docs/resources/compatibility.md#mcp-streamable-http-handler) notes.

The upgrade from 3.5.9 to 3.7.0 needed no change to application code. Both backends keep the same GraphQL schema and MCP tools and answer with the same data and error codes, while sending fewer database reads and statements, as the [MongoDB](mongodb/README.md#application-layout) and [PostgreSQL](postgres/README.md#storage-and-native-apis) READMEs describe. Both backends leave 3.7.0's opt-in [batched collection reads](../../docs/guide/relationships.md#batched-collection-reads) (`batchedCollections`) off: on list pages of about a dozen shops with their collections, batching returned the same results with up to about 5 times fewer database calls but was not consistently faster on a local database, and the MongoDB backend would first need its own adapter and runtime instead of the package-root one.

The upgrade from 3.8.0 to 3.15.0 keeps the published GraphQL client compatible with the default introspection metadata. Collection filters now use correlated scopes and count each matching parent once; filters used only to select aggregate parents no longer multiply their facts. Existing transactional controllers continue to work. Optimistic concurrency, committed callbacks and the optional descriptor endpoint are available when explicitly configured; this dependency upgrade does not enable them on Barber types. Review the [library upgrade notes](../../docs/resources/compatibility.md#upgrade-to-3-15-0) when extending the example.

The upgrade from 3.15.0 to 3.18.0 needed no change to application code. The published GraphQL client receives the same introspection metadata; the only difference it sees is two more `QLOperator` values, `CONTAINS_ALL` and `IIN`, which the list and aggregate MCP tools also advertise. Existing filters, scopes and transactional controllers keep their results. The lifecycle helpers (`updateObject`, `deleteObject`, `transitionObject`), the opt-in generated `transaction` mutation, `valuePath` field comparisons and embedded object frames are available when explicitly used; this dependency upgrade does not adopt them. Review the [library upgrade notes](../../docs/resources/compatibility.md#upgrade-to-3-18-0) back to 3.16.0 when extending the example.

The upgrade to 3.19.0 aligns both backends and `@simtlix/simfinity-js-client` on the same exact published version. The client replaces 1.1.0 and supplies its own TypeScript declarations, so the frontend removes the local ambient module shim and uses typed query results on the booking screens. Initialization continues to use extended introspection and the existing JWT `prepareHeaders` callback. The backends retain 3.18.0 runtime behavior; no database migration or descriptor endpoint is required. See the [client migration guide](../../docs/guide/client.md).

The upgrade from 3.7.0 to 3.8.0 moved the booking page's taken-times read from the `bookingAvailability` custom mutation to 3.8.0's virtual fields: the `busyRanges` field described in [booking rules](#booking-rules) and its `barbershop_busyRanges` MCP tool. The mutation, its `BookingAvailabilityInput` and its MCP tool are gone; the rest of the GraphQL schema, the other MCP tools, the stored data and the PostgreSQL tables are unchanged, so databases created by earlier versions start without a migration.

## Stop or reset one stack

Stop the selected project while preserving its data:

```sh
docker compose -f compose.mongodb.yaml down
# Or:
docker compose -f compose.postgres.yaml down
```

To erase only the selected example's database and uploaded demo files, add `--volumes`:

```sh
docker compose -f compose.mongodb.yaml down --volumes
# Or:
docker compose -f compose.postgres.yaml down --volumes
```

Start and seed that stack again for a fresh demo. These commands target the named project in the selected Compose file.

`dataset:load` loads the larger synthetic fixture through GraphQL after `seed:admin`. Its sample bookings are dated two to eight days after the load, on open weekdays, so they satisfy the booking rules. Because those bookings are still upcoming, the platform admin imports the four sample reviews for their clients, without a booking. `dataset:delete` removes all records of the covered catalog and activity types at its configured endpoint, including records created through the UI, while retaining user accounts. Use these commands only against a disposable example database.

## Source and license

These examples were adapted from [`claudiojgonzalez/simfinity-barber`](https://github.com/claudiojgonzalez/simfinity-barber):

- MongoDB backend: commit [`00718c0195374ab1baaefd32d8a24e21a238b4c3`](https://github.com/claudiojgonzalez/simfinity-barber/tree/00718c0195374ab1baaefd32d8a24e21a238b4c3).
- PostgreSQL backend and shared frontend: local PostgreSQL port commit `d149c625100178f412b792d961a8ac4f42dc78b8` from the source checkout; this commit was not published in the original repository.

The monorepo uses the [Apache 2.0 License](../../LICENSE); the original [frontend license](frontend/LICENSE) is retained. Environment files, private uploads, dependency directories, local vendor archives, and generated schema exports are not part of the source examples.
