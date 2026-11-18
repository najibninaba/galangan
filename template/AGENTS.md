# my-harness

<!-- Harness half: what this harness is for, its tools and docs, its own commands and quirks. Replace this section. -->

A Galangan harness. `src/tally.ts` is the starting harness copied from Galangan's `examples/tally`; rename it to this
harness's own name and prefix. The name also names the store: until it changes, this repo shares
`~/.galangan/tally.sqlite` with every other unrenamed copy and with Galangan's own example.

<!-- Galangan half: copied from Galangan's template/AGENTS.md. Keep it in step with that file. A lesson learned in this
harness that every harness needs goes back there, and into Galangan itself if the shell should change. -->

## Galangan conventions

Galangan is the shell this harness runs on: the store, the Pi Harness lifecycle, model choice and the CLI. Its README
(`node_modules/galangan/README.md`) is the reference; its `CHANGELOG.md`, which has the upgrade steps, is in the
Galangan repository at the pinned tag.

### Commands

- `.agents/setup` installs dependencies (orbs run it): it first checks that Git can read the Galangan repository and
  runs `amp git-setup` when it cannot, then `npm install` the first time, which writes the `package-lock.json` to
  commit, then `npm ci`. `npm run check` is tsc with no emit, and `npm test` is node --test,
  which also runs Galangan's conformance cases. `npm run ci` runs both; run it before every commit. There is no CI
  workflow: the repository host has no runner with Amp git credentials to install Galangan.
- `npm start -- --init` creates the store (only `--init` does); `npm start -- '<message>'` sends one message; `npm
  start` reads one message per stdin line. `GALANGAN_MODEL=real` uses a real model and needs `OPENAI_API_KEY`.
- Node runs the `.ts` files directly (type stripping). Keep TypeScript erasable: no enums, namespaces or parameter
  properties (`erasableSyntaxOnly`), and import local files with their `.ts` extension. Keep `skipLibCheck: true`: a
  dependency of pi-ai ships declarations that do not type-check.

### Boundaries

- Import Galangan only as `galangan` and `galangan/testing`; everything else in it is internal. If the harness needs
  something the shell does not offer, propose it to Galangan instead of patching around the shell here.
- Doc kinds and extension names starting `galangan.`, and tool names starting `galangan_`, are the shell's. Use this
  harness's own prefix, as tally uses `tally.`: Pi does not check collisions, so a later tool of the same name silently
  replaces an earlier one.
- A kit extension whose docs have no migration declares its store format in `formats: { <extension>: <n> }` from its
  first release; changing or dropping it later is a format change.

### Durability

- Pi owns persisted execution; Effect structures services. State that must survive a restart lives in Pi documents
  (`defineDoc`) changed inside `api.commit`, never in module variables.
- Use Effect for services, layers, scoped resources and typed errors (`Data.TaggedError`). Do not wrap
  non-idempotent effects in `Effect.retry`.
- Mark a tool `replay: "safe"` only when running it twice is harmless; otherwise a crash mid-call gives the model an
  `interrupted` result, which is the safe default.

### Tests

- Tests use the faux model and real file-backed SQLite from `galangan/testing` (`fauxModels`, `FAUX_MODEL`,
  `tempStore(t)`). They never call a real model or the network. Each test should fail on a plausible break, such as
  lost durability or dropped request IDs.
- Keep `conformance(harness, { from: process.env.CONFORMANCE_FROM })` in the harness's test. Before an upgrade, stop
  the process, copy the store and its WAL, and run `CONFORMANCE_FROM=<copy> npm test`.

### Pins and upgrades

- Pins are exact (`.npmrc` `save-exact=true`, committed `package-lock.json`). Galangan is a git dependency pinned to a
  release tag; Pi (`pi-durable`, `pi-ai`, `chord`, `pi-schema`) and `effect` are its exact peers and move with it.
- Upgrade by bumping the Galangan tag to a newer release, setting the peers to the versions its README's Pins table
  names, fixing `tsc` errors by the CHANGELOG's `Migration:` lines, and running conformance on a store backup before
  deploying. Pi store migrations are one-way: roll back by restoring the `<store>.<UTC time>.bak` the upgrade wrote.

### Style

- Tabs for indentation, double quotes, lines up to about 120 characters. Comments say why, at the top of each file.
