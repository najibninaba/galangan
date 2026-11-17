# Galangan

A harness app shell for building custom agent harnesses. TypeScript + Effect on
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). *Galangan* is Malay for shipyard.

The shell owns the parts every harness needs: a SQLite store that survives restarts, the Pi Harness lifecycle, model
selection and a CLI. A harness supplies only Pi extensions: tools, prompt sections, hooks and durable tasks. Galangan
sits alongside [Lunas](https://github.com/najibninaba/lunas), Kapitan's durable agent engine, and follows its stack and
conventions, on the latest stable Pi and Effect (see [Pins](#pins)).

## Quick start

```sh
npm ci
npm run check   # tsc
npm test        # node --test, faux model, no network
npm start -- --init                          # create the store (only this does)
npm start -- 'call tally {"label":"cups"}'   # tally: cups = 1 (run it again: 2)
npm start       # one message per stdin line
```

| Variable | Default | Meaning |
|---|---|---|
| `GALANGAN_HARNESS` | the first in `src/harnesses/index.ts` | Which harness to run |
| `GALANGAN_MODEL` | `faux` | `faux`, or `<provider>/<model id>` for a pi-ai built-in provider, e.g. `anthropic/claude-opus-4-6` with `ANTHROPIC_API_KEY` |
| `GALANGAN_DATA` | `~/.galangan` | Store directory; each harness gets `<name>.sqlite`. The default is the same from any working directory |

Only `--init` creates a store. Any other run on a missing store exits 78 and names the path it looked for, so a wrong
`GALANGAN_DATA` or working directory never starts the harness with an empty past. `--init` on an existing store says so
and leaves it unopened, so it never resumes that store's unfinished runs.

Upgrading from a build that defaulted to `./data`: your history is in `./data/<harness>.sqlite`. Set
`GALANGAN_DATA=./data`, or move the file to `~/.galangan/`, rather than running `--init`. A run from the directory that
holds the old store prints this hint when the new default is missing.

In stdin mode an unanswered line (bad tool arguments, a model error) prints `galangan: unanswered (...)` to stderr and
the session reads the next line. SIGINT or SIGTERM closes the Harness first, so running work goes back to pending and
the store's lock is released; a second signal exits at once.

Exit codes: 0 done, 1 failed (restart it), 75 store in use by another process (do not start a second one), 78 bad
configuration, including a missing store (needs a person), 130/143 stopped by SIGINT/SIGTERM.

## Build a harness

1. Copy [`src/harnesses/tally.ts`](src/harnesses/tally.ts) to `src/harnesses/<name>.ts`.
2. Put your tools, sections, hooks and tasks in its extensions, and give it a name with `defineHarness`.
3. List it in [`src/harnesses/index.ts`](src/harnesses/index.ts) and run it with `GALANGAN_HARNESS=<name> npm start`.

```ts
export const myHarness = defineHarness({
	name: "mine",
	extensions: [defineExtension({ name: "mine", tools: [myTool], sections: [section("mine", () => "You are ...")] })],
});
```

Keep state that must survive a restart in Pi documents (`defineDoc`) changed inside `api.commit`, as `tally` does, not
in module variables. Mark a tool `replay: "safe"` only when running it twice is harmless; otherwise a crash mid-call
gives the model an `interrupted` result. The Pi Durable README in `node_modules/@earendil-works/pi-durable/README.md`
covers the rest of the extension API.

To drive a harness from code instead of the CLI, provide `Shell.layer` to an Effect:

```ts
const answer = await Effect.runPromise(
	Effect.provide(Shell.use((shell) => shell.ask("hello")), Shell.layer({ harness, choice, store: "data/x.sqlite", create: true })),
);
```

Without `create: true` a missing store fails with `StoreMissing`; a store another process has open fails with
`StoreLocked`. `shell.harness` is the open Pi Harness, for anything the shell does not wrap (more conversations, `inspect`, `watch`).

## Layout

| Path | Role |
|---|---|
| `src/harness.ts` | The extension point: `HarnessSpec` and `defineHarness` |
| `src/shell.ts` | `Shell` service and layer: opens the Harness over SQLite (`synchronous = FULL`, exclusive lock), resumes unfinished work, closes it when the scope ends; `ask` submits to the root conversation |
| `src/models.ts` | `GALANGAN_MODEL` → model; the deterministic faux model and its script format |
| `src/main.ts` | CLI entry |
| `src/harnesses/` | Harnesses this build ships; `tally` is the example |
| `test/shell.test.ts` | The shell over a real SQLite file: tool state across a reopen, request ID dedup, missing and locked stores, model choice |
| `test/store.test.ts` | The CLI as processes: one default store from any directory, `--init` (once), the old `./data` hint, a second process refused |
| `test/main.test.ts` | The CLI as a child process: an unanswered line does not end the session; SIGINT/SIGTERM close the Harness |

## Pins

| Package | Pinned |
|---|---|
| `@earendil-works/pi-durable`, `pi-ai`, `chord`, `pi-schema` | `1.5.2` exactly; they move together |
| `effect` | `4.1.4` exactly |

Galangan tracks the latest stable releases, unlike Lunas, which is still on Pi 1.4.0 / Effect 4.0.6 under its own
[pin policy](https://github.com/najibninaba/lunas/blob/main/docs/pi-pin-policy.md). The 1.5 API differs from what Lunas
code uses: tool schemas come from `@earendil-works/pi-schema` (`obj({ n: num() })`, not TypeBox's `Type`), `onReport`
takes one `Report` tagged by `kind`, `harness.closed` ends with `{ kind }`, and state getters such as `viewState()` are
replaced by watches. Port a Lunas extension with those in mind. Pi Durable breaks its API every minor release and its
store migrations are one-way, so read its `CHANGELOG.md` before a bump.

## Limits

- One process per store, enforced: the shell holds SQLite's exclusive lock while open, so a second process exits 75
  within about half a second (it retries a few times, in case two processes started together), and a crash releases
  the lock with the process. The lock also shuts out read-only viewers; port Lunas's writer lease (`src/lease.ts`) if
  those are needed.
- The CLI talks to the root conversation only. Many conversations, an HTTP API and watching are a Harness away
  (`shell.harness`) but not wrapped yet.

## Licence

Apache-2.0. See `LICENSE`.
