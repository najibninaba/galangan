# Galangan

A harness app shell on Pi Durable and Effect. Read `README.md` first for the layout and the harness extension point.

## Before you start

- Search this project's earlier Amp threads (`find_thread`) and Linear for the same or related work. Build on the
  decisions and open issues you find instead of redoing or contradicting them, and cite the thread or issue.
- Name the general problem behind the request and solve that, not only the instance reported. If the fix belongs in
  a shared layer, such as `src/shell.ts` or a Pi or Effect service, say so.

## Commands

- `npm ci` (orbs run `.agents/setup`), then `npm run check` (tsc, no emit, including the `.d.ts` build) and
  `npm test` (node --test). Run both before every commit.
- Node runs the `.ts` files directly (type stripping). Keep TypeScript erasable: no enums, namespaces or parameter
  properties (`erasableSyntaxOnly`), and import local files with their `.ts` extension.
- `dist/` is only for other repos: `prepare` builds it, including on `npm ci` here, and it goes stale as `src/` changes.
  Run files through the npm scripts, or with `node --conditions=galangan-source`, so `galangan` resolves to `src/`.

## Conventions

- Match Lunas (`najibninaba/lunas`) where it applies: its stack, pins, comment style and test approach.
- Pi owns persisted execution; Effect structures services. Durable state goes in Pi documents and tasks changed in
  commits, never in module variables. Use Effect for services, layers, scoped resources and typed errors
  (`Data.TaggedError`). Do not wrap non-idempotent effects in `Effect.retry`.
- Harnesses use only Galangan's public package exports (`test/boundary.test.ts` checks the examples).
- Kit extensions use Pi, not the shell. Reserve `galangan.*` doc kinds and extension names for the shell and kit.
- Change `src/shell.ts` only for something every harness needs.
- Pins are exact (`.npmrc` `save-exact=true`, committed `package-lock.json`) and track the latest stable releases.
  Pi packages (`pi-durable`, `pi-ai`, `chord`, `pi-schema`) move together; read Pi's `CHANGELOG.md` for every
  version crossed before a bump. Lunas is on an older Pi, so check its code against the Pi API pinned here before
  copying it.
- Tests use the faux model (`src/models.ts`) and real file-backed SQLite in a temp directory. They never call a real
  model or the network. Each test should fail on a plausible break, such as lost durability or dropped request IDs.
- Tabs for indentation, double quotes, lines up to about 120 characters. Comments say why, at the top of each file.
