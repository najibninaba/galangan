# my-harness

<!-- Harness half: what this harness is for, its tools and docs, its own commands and quirks. Replace this section. -->

A Galangan harness. `src/tally.ts` is the starting harness copied from Galangan's `examples/tally`; rename it to this
harness's own name and prefix. The name also names the store: until it changes, this repo shares
`~/.galangan/tally.sqlite` with every other unrenamed copy and with Galangan's own example.

<!-- Galangan half: copied from Galangan's template/AGENTS.md. Keep it in step with that file. A lesson learned in this
harness that every harness needs goes back there, and into Galangan itself if the shell should change. -->

## Galangan conventions

Galangan is the shell this harness runs on: the store, the Pi Harness lifecycle, model choice and the CLI. Its README
(`node_modules/galangan/README.md`) is the reference, and its `CHANGELOG.md` (`node_modules/galangan/CHANGELOG.md`)
has the upgrade steps.

### Commands

- `.agents/setup` installs dependencies (orbs run it) with `npm ci` from the committed `package-lock.json`, which the
  template ships. `npm run check` is tsc with no emit, and `npm test` is node --test,
  which also runs Galangan's conformance cases. `npm run ci` runs both; run it before every commit.
- `npm start -- --init` creates the store (only `--init` does); `npm start -- '<message>'` sends one message; `npm
  start` reads one message per stdin line. `GALANGAN_MODEL=real` uses a real model and needs `OPENAI_API_KEY`.
- Node runs the `.ts` files directly (type stripping). Keep TypeScript erasable: no enums, namespaces or parameter
  properties (`erasableSyntaxOnly`), and import local files with their `.ts` extension. Keep `skipLibCheck: true`: a
  dependency of pi-ai ships declarations that do not type-check.

### Boundaries

- Use only the public package exports in the pinned Galangan release.
- Propose missing shell capabilities to Galangan instead of patching around the shell here.
- Reserve `galangan.*` doc kinds and extension names and `galangan_` tool names for the shell and kit.
- Use your harness's own prefix, as tally uses `tally.`: Pi lets a later tool of the same name replace an earlier one.
- A kit extension whose docs have no migration declares its store format in `formats: { <extension>: <n> }` from its
  first release; changing or dropping it later is a format change.

### Durability

- Pi owns persisted execution; Effect structures services. State that must survive a restart lives in Pi documents
  (`defineDoc`) changed inside `api.commit`, never in module variables.
- Use Effect for services, layers, scoped resources and typed errors (`Data.TaggedError`). Do not wrap
  non-idempotent effects in `Effect.retry`.
- Mark a tool `replay: "safe"` only when running it twice is harmless; otherwise a crash mid-call gives the model an
  `interrupted` result, which is the safe default.

### Secrets

- Name every environment variable a tool needs, such as an API token, in `defineHarness({ secrets: [...] })`, and
  read it from `process.env` in the tool. The CLI then exits 78 at startup when one is unset or empty. The shell masks
  exact values in protected tool output and results through Pi's `afterTool` hook, using `[secret NAME]` or a shorter
  marker that fits the output. Pi stores diagnostics added after that hook unredacted. See the secrets notes in the
  [Galangan README](node_modules/galangan/README.md#build-a-harness) for compaction and history replay limits.
- Redaction matches exact values: never put a secret in tool arguments or an encoded form such as
  base64. Keep values in the environment, never in code, docs or the store.
- Amp project secrets reach only orbs of that project: run the harness live from a thread in its own project.

### Tests

- Tests use the faux model and real file-backed SQLite from `galangan/testing` (`fauxModels`, `FAUX_MODEL`,
  `tempStore(t)`). They never call a real model or the network. Each test should fail on a plausible break, such as
  lost durability or dropped request IDs.
- Keep `conformance(harness, { from: process.env.CONFORMANCE_FROM })` in the harness's test. Before an upgrade, stop
  the process, copy the store and its WAL, and run `CONFORMANCE_FROM=<copy> npm test`.

### Pins and upgrades

- Pins are exact (`.npmrc` `save-exact=true`, committed `package-lock.json`). Galangan is the npm
  package `galangan` at an exact release; Pi (`pi-durable`, `pi-ai`, `chord`, `pi-schema`) and `effect` are its exact
  peers and move with it.
- Upgrade by bumping `galangan` to a newer release, setting the peers to the versions its README's Pins table
  names, fixing `tsc` errors by the CHANGELOG's `Migration:` lines, and running conformance on a store backup before
  deploying. Pi store migrations are one-way: roll back by restoring the `<store>.<UTC time>.bak` the upgrade wrote.

### Style

- Tabs for indentation, double quotes, lines up to about 120 characters. Comments say why, at the top of each file.
