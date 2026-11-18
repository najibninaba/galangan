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
| `GALANGAN_HARNESS` | the first passed to `runCli` | Which harness to run |
| `GALANGAN_MODEL` | `faux` | Offline `faux`; `real` selects `openai/gpt-6.1-terra`; or use `<provider>/<model id>` from pi-ai's built-in catalog |
| `GALANGAN_THINKING` | `medium` when supported, otherwise the first supported level (`off` for non-reasoning models) | Pi thinking level; explicitly unsupported levels are configuration errors (exit 78), never silently clamped |
| `GALANGAN_DATA` | `~/.galangan` | Store directory; each harness gets `<name>.sqlite`. The default is the same from any working directory |

### Real models

The default **real** model is OpenAI Terra 6.1 at `medium`. The no-configuration default stays `faux`, so a quick start
does not spend money. Set `OPENAI_API_KEY` in the environment (an `sk-` API key), then run
`GALANGAN_MODEL=real npm start -- 'Count one cup'`. Explicitly selecting `openai/gpt-6.1-terra` is equivalent.
Other providers use their usual key variables, such as `ANTHROPIC_API_KEY`.

The shell validates effort against the selected model's catalog, applies model and effort to the root on **every
open**, then resumes work. Existing faux stores therefore switch to the requested real model without losing history.
Reopening with a different model or effort switches subsequent generations of an unfinished root run partway through;
an in-flight helper child keeps its own model and effort.
The stdin banner includes the configured effort. Effort changes use OpenAI Responses `configuration_update` items;
Sign in with ChatGPT tokens reject those items, so use an API key for this path.

`npm run smoke:real` is a separate, paid integration check (requires the environment key). It creates a fresh store
under the OS temporary directory, runs Terra's tally tool, exits that Node process, reopens the same store in another
process, checks the persisted count, and forces one Sol helper call with a smoke-only provider hook. It also probes a
change from medium to high effort on the existing transcript. It prints each committed generation's model, Pi and
provider efforts, token usage and estimated USD cost, plus per-model totals from `harness.usage()`.
Supply a fresh directory as `npm run smoke:real -- <directory>`
to keep its store at a specific path. It refuses an existing smoke store. `npm test` remains faux-only with no network.

`npm run smoke:recovery` is a separate paid SIGKILL experiment on four fresh temporary stores: during Terra streaming,
after a tally increment but before its result commits, during Sol streaming, and after Sol's answer commits but before
delegate's result commits. A parent process verifies each boundary, sends SIGKILL, then reopens in another process.
Smoke-only hooks force the initial tool call, not the model's response to an interrupted tool. Production retry policy
is unchanged (Pi 1.5.2 defaults to three retries). The script reports outcomes rather than assuming every crash answers.
It writes `events.jsonl` and `summary.json` beside its temporary stores, including request counts, stored generations
(also aborted), tool errors, budgets, task restarts, reports and usage. It caps each request at 1,024 output tokens and
reserves estimated input plus maximum output cost before dispatch, stopping before reservations exceed $0.25.
Killed requests can cost money without recorded usage; the printed Pi cost is not an invoice. A stream gate proves
the host was still consuming the response, not that OpenAI had not finished generating server-side. An optional fresh
directory works as for `smoke:real`; keep transcripts outside the checkout.

Only `--init` creates a store. Any other run on a missing store exits 78 and names the path it looked for, so a wrong
`GALANGAN_DATA` or working directory never starts the harness with an empty past. `--init` on an existing store says so
and leaves it unopened, so it never resumes that store's unfinished runs. `--init` takes no other arguments, and a store
path that is not a file (a directory, say) exits 78 too.

Every open stamps the store with the Galangan and Pi versions that wrote it (a `galangan_store` table) and the kit
formats it was written with. Pi's schema migrations are one-way, so a build older than the stamp or the schema exits
78 naming both versions instead of opening the store. An open that upgrades a store (a newer Galangan or Pi, or a Pi
schema migration) first copies it to `<store>.<UTC time>.bak` beside it and says so on stderr; to roll back, restore
that copy and run the old build on it. Backups are never deleted by Galangan. If the copy fails (a full disk, say), the
open exits 78 and leaves the store as it was; the copy is written under a temporary name first, so a `.bak` file is
always whole.

Upgrading from a build that defaulted to `./data`: your history is in `./data/<harness>.sqlite`. Set
`GALANGAN_DATA=./data`, or move the file to `~/.galangan/`, rather than running `--init`. A run from the directory that
holds the old store prints this hint when the new default is missing.

In stdin mode an unanswered line (bad tool arguments, a model error) prints `galangan: unanswered (...)` to stderr and
the session reads the next line. SIGINT or SIGTERM closes the Harness first, so running work goes back to pending and
the store's lock is released; a second signal exits at once.

Exit codes: 0 done, 1 failed (restart it), 75 store in use by another process (do not start a second one), 78 bad
configuration, including a missing store or one a newer build wrote (needs a person), 130/143 stopped by SIGINT/SIGTERM.

## Build a harness

A harness uses Galangan's public package entries: `galangan` (the shell, `runCli`, `defineHarness`, `helper`, model
choice and errors), `galangan/testing` (the faux model, `tempStore(t)` and `conformance`), and `galangan/kit/memory`
(opt-in transcript tools). Everything else under `src/` is internal; `exports` in `package.json` refuses deep imports.
[`examples/tally/`](examples/tally) is the reference harness and follows that rule (a test checks it).

A new harness repo starts as a copy of [`template/`](template): this release's pins, the tsconfig, an AGENTS.md
with these conventions, `.agents/setup`, `npm run ci` (check, then test with conformance) and tally as its starting
harness in `src/`. Copy it from the release tag it pins, not from `main`: between releases `main` can carry peers or
shell API that the last tag lacks. Copy `template/.`, not `template/*`, so the dotfiles (`.npmrc`, `.gitignore`,
`.agents/`) come too. The template ships its `package-lock.json`, so `.agents/setup` runs `npm ci`; commit the lockfile
with the rest:

```sh
git clone --quiet --depth 1 --branch v<version> https://github.com/najibninaba/galangan.git /tmp/galangan
mkdir my-harness && cp -r /tmp/galangan/template/. my-harness/
cd my-harness && git init && ./.agents/setup && npm run ci
```

In an Amp thread on this repository, the `spinning-off-harnesses` skill (`.agents/skills/`) does all of this. It also
renames tally, writes the harness half of AGENTS.md, checks the CLI, and, with your approval, creates the Amp project
and adds the harness to `HARNESSES.md`.

1. Start from tally in the template's `src/` (or copy [`examples/tally/`](examples/tally): `tally.ts`, `main.ts` and
   `tally.test.ts`), and rename it to your harness.
2. Put your tools, sections, hooks and tasks in its extensions, and give it a name with `defineHarness`.
3. `main.ts` passes your harnesses to `runCli([...])`, which is the whole CLI above; `GALANGAN_HARNESS` picks among
   them.
4. Keep `conformance(myHarness, { from: process.env.CONFORMANCE_FROM })` in its test, as `tally.test.ts` does.

`conformance(spec)` from `galangan/testing` registers the shell's durability promise as node:test cases over real
SQLite and the faux model, run through your harness's own extensions plus a probe extension: committed tool state
survives a close and reopen, every commit is written with `synchronous = FULL`, a repeated request ID is one input
even after a reopen, a tool that is not replay-safe, cut off mid-call, returns `interrupted` and is not run again,
and no secret's value reaches the store file from a tool's result or thrown error (the cases set made-up values for
the harness's `secrets`, so they need none of the real ones).
Before an upgrade, run it on the backup of production's store, taken with the process stopped: each case copies that
file (and its WAL) and never opens the original, and one more case checks that the copy starts from its history. To
pass the path without editing the test, keep it as `conformance(myHarness, { from: process.env.CONFORMANCE_FROM })`
and run `CONFORMANCE_FROM=<backup> npm test`. When a harness finds a way to lose durability,
the fix adds a case here, so every harness runs it on its next bump.

Doc kinds and extension names starting `galangan.`, and tool names starting `galangan_`, are reserved for the shell
and kit, because Pi does not check collisions (a later extension's tool silently replaces an earlier one of the same
name); use your harness's own prefix, as tally uses `tally.`. Pi, pi-ai, chord, pi-schema and Effect are exact peer
dependencies, so a harness gets the same copies the shell runs on.

A harness repo installs Galangan from npm at an exact release, plus the exact peers from [Pins](#pins):

```sh
npm install --save-exact galangan@0.2.5 \
  @earendil-works/pi-durable@1.5.2 @earendil-works/pi-ai@1.5.2 @earendil-works/chord@1.5.2 \
  @earendil-works/pi-schema@1.5.2 effect@4.1.4
npm install --save-dev @types/node   # galangan/testing's types use node:test
```

Copy `tsconfig.json`'s `skipLibCheck: true` too: a dependency of pi-ai ships declarations that do not type-check.

Node does not strip types under `node_modules`, so the published package is the build (`npm run build`, tsc into
`dist/` with `.d.ts`, which `npm publish` runs through `prepare`); the harness repo itself still runs `.ts` with no
build step. Inside
this repository the npm scripts set `--conditions=galangan-source`, which points `galangan` back at `src/`: no build
is needed, and tests that import both `../src` and `galangan` share one copy of `Shell` and its errors. Run a file
directly with `node --conditions=galangan-source ...`; without it `galangan` loads `dist/`, a second copy that
`npm ci` built and that is stale once `src/` changes. `npm run check` also type-checks the `.d.ts` build, so a
declaration error fails there rather than in a harness repo's install.

```ts
export const myHarness = defineHarness({
	name: "mine",
	extensions: [defineExtension({ name: "mine", tools: [myTool], sections: [section("mine", () => "You are ...")] })],
});
```

A kit extension whose docs have no migration declares its store format in `formats: { <extension>: <n> }`. The stamp
records a format for every extension, 0 for one that declares none, and a store written with another number fails at
open with the wipe step, rather than reading the old docs as empty. Declare a format from the extension's first
release: declaring one later, or dropping it, is a format change. An extension the store has no record of may start
at any format.

A tool that calls an outside service names the environment variables it needs in `secrets`, and keeps reading them
from `process.env` itself:

```ts
export const myHarness = defineHarness({ name: "mine", secrets: ["TODOIST_API_TOKEN"], extensions: [...] });
```

`runCli` then exits 78 at startup, naming the variable, when one is unset or empty, instead of starting a session whose
tool fails only when the model calls it. Galangan wraps tools in their installed extensions, so redaction follows
the tools through helper recovery, forks and conversation configuration. The wrapper redacts live output, details
and diagnostics before Pi receives them. A final tool hook redacts exact values in results, including diagnostic
codes and handoffs. A stream holds a possible secret prefix until it can match it and masks a remaining prefix
when the tool throws or is interrupted. Returning a result preserves incomplete prefixes, including when the
result reports an error. With redaction active, Pi bounds output after redaction and callers receive no source-side
tail window. A tool reading retained output sees the text accepted by Pi so far. A structured result built from
that snapshot can omit a trailing prefix that appears in the final streamed output.

Tools and hooks must keep secrets out of arguments (including values added by hooks and nested calls), their own
commits and memos, prompts, and spill files. Use secret-free payloads for schema-validated fields because a
redaction can change the value's shape. Encoded credentials are outside the exact-value policy. Amp project
secrets reach only the orbs of that project. `Shell.layer({ ..., env })` lets tests supply their own values.

Keep state that must survive a restart in Pi documents (`defineDoc`) changed inside `api.commit`, as `tally` does, not
in module variables. Mark a tool `replay: "safe"` only when running it twice is harmless; otherwise a crash mid-call
gives the model an `interrupted` result. The Pi Durable README in `node_modules/@earendil-works/pi-durable/README.md`
covers the rest of the extension API.

To drive a harness from code instead of the CLI, provide `Shell.layer` to an Effect:

```ts
const answer = await Effect.runPromise(
	Effect.provide(
		Shell.use((shell) => shell.ask("hello")),
		Shell.layer({ harness, choice, store: "data/x.sqlite", create: true }),
	),
);
```

Without `create: true` a missing store fails with `StoreMissing`, as does a path that is not a file (`notFile`); a store
another process has open fails with `StoreLocked`, and one a newer build wrote, or with another kit format, fails
with `StoreIncompatible`. A failed backup before an upgrade is `StoreBackupFailed`. `shell.harness` is the open Pi
Harness, for anything the shell does not wrap (more conversations, `inspect`, `watch`).

### Opt-in reasoning helper

Add `helper()` from `galangan` to a harness's `extensions` to offer `delegate({ task })`. It defaults to
`openai/gpt-6.1-sol` at `high`. With an OpenAI root, the provider registered for Terra also registers Sol, using the same
key. A faux or other-provider root must explicitly register the helper's provider in its `choice.models` and configure
that provider's credentials, or inject another registered helper model. Errors distinguish unregistered providers or
models, unsupported effort, and missing credentials.
Sol returns findings to Terra, and Terra writes the user-facing answer; delegation never switches the root model.
The example tally harness does not opt in, since counting is deterministic work.

The foreground helper is task-owned and replay-safe, reusing its child and `subagent:<taskId>` request after a restart.
The child gets no extensions by default: no parent tools, prompt sections or hooks. Opt in to child capabilities with
`helper({ extensions: [readOnlyExtension] })`; those extensions must also be installed in the harness's `extensions`.
The helper itself is excluded, so the child cannot delegate recursively. A persisted budget permits three helper
calls per answer across rounds, parallel calls and restarts, including failed children; the next answer gets a fresh
budget. Aborting the parent also aborts its helper. This prevents duplicate children/submissions,
not duplicate provider billing if a crash interrupts a generation.

For offline harness tests inject a registered faux model and its supported effort:
`helper({ model: FAUX_MODEL, thinkingLevel: "off" })`. Tool arguments use closed pi-schema schemas: extra properties
are errors, not silently removed.

### Opt-in transcript memory

```ts
import { defineHarness } from "galangan";
import { memory, memoryFormats } from "galangan/kit/memory";

export const myHarness = defineHarness({
	name: "mine",
	extensions: [memory()],
	formats: { ...memoryFormats },
});
```

`memory()` adds two replay-safe tools over the current conversation's raw history. They can read text that Pi's stock
compaction removed from active context, including inherited messages up through a fork point. They read user and
assistant text, not thinking, images, tool results, or Pi's context markers.

- `recall({ regex })` searches with a case-insensitive JavaScript regular expression and returns excerpts newest
  first, each with its `zoom` call. `before` continues below an exclusive entry ID.
- `zoom({ entry })` opens one entry. `zoom({ range: { from, to } })` opens both endpoints inclusively, oldest first.
  For long results, copy the continuation footer's arguments, including any `offset`.

The extension name and format key are both `galangan.memory`; spread `memoryFormats` from the first install to stamp
format **1**. The stable tool names are `recall` and `zoom`; don't install a later extension with either name. This
mode owns no documents or tasks and does not change compaction. It does not build a summary tree.

## Layout

| Path | Role |
|---|---|
| `src/harness.ts` | The extension point: `HarnessSpec` and `defineHarness` |
| `src/shell.ts` | `Shell` service and layer: opens the Harness over SQLite (`synchronous = FULL`, exclusive lock), resumes unfinished work, closes it when the scope ends; `ask` submits to the root conversation |
| `src/models.ts` | `GALANGAN_MODEL` → model; the deterministic faux model and its script format |
| `src/index.ts`, `src/testing.ts` | The shell and test entries, `galangan` and `galangan/testing` |
| `src/kit/memory/` | `galangan/kit/memory`: opt-in tools for Pi's raw history |
| `tsconfig.build.json` | `npm run build` (run by `prepare`): `src/` to `dist/` JS and `.d.ts`, what `exports` gives other repos |
| `src/cli.ts` | `runCli(harnesses)`: the CLI, harness selection, exit codes and signals |
| `examples/tally/` | The reference harness: `tally.ts`, its CLI `main.ts` (`npm start`) and its test, on public entries only |
| `template/` | The starter a new harness repo copies: pins, tsconfig, AGENTS.md, `.agents/setup` and tally in `src/` |
| `src/helper.ts` | Opt-in bounded foreground helper (Sol high by default) |
| `src/secrets.ts` | `HarnessSpec.secrets`: startup validation, tool wrappers and result redaction |
| `test/shell.test.ts` | The shell over a real SQLite file: missing and locked stores, model changes, the stamp and backups, model choice |
| `test/conformance.test.ts` | `conformance` on a copy of an existing store, which it leaves untouched (tally's own test runs it on new stores) |
| `test/store.test.ts` | The CLI as processes: one default store from any directory, `--init` (once), the old `./data` hint, a second process refused, a newer store refused |
| `test/main.test.ts` | The CLI as a child process: an unanswered line does not end the session; SIGINT/SIGTERM close the Harness; a missing secret exits 78 |
| `test/helper.test.ts` | Faux-only helper findings, limits, no recursion and restart recovery |
| `test/boundary.test.ts` | Examples import only the public entries |
| `test/template.test.ts` | `template/` carries examples/tally unchanged and this release's tag, pins and compiler options |
| `test/real-model-smoke.ts` | Paid OpenAI probe; only run by `npm run smoke:real`, not `npm test` |
| `test/real-model-recovery.ts` | Paid, gated SIGKILL/reopen experiment; only run by `npm run smoke:recovery` |

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

Releases follow [docs/pin-and-release-policy.md](docs/pin-and-release-policy.md): one Galangan minor line per Pi minor
(0.1.x is Pi 1.5.x), fixes on the newest line only, and a `CHANGELOG.md` entry that says whether the store migrates.

## Limits

- One process per store, enforced: the shell holds SQLite's exclusive lock while open, so a second process exits 75
  within about half a second (it retries a few times, in case two processes started together), and a crash releases
  the lock with the process. The lock also shuts out read-only viewers; port Lunas's writer lease (`src/lease.ts`) if
  those are needed.
- The CLI talks to the root conversation only. Many conversations, an HTTP API and watching are a Harness away
  (`shell.harness`) but not wrapped yet.

## Licence

Apache-2.0. See `LICENSE`.
