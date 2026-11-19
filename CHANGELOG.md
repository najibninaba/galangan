# Changelog

Each release says whether it migrates the store and gives a `Migration:` line for every change harness code must
make. See [docs/pin-and-release-policy.md](docs/pin-and-release-policy.md) for release lines and how to upgrade.

## Unreleased

- Tool output redaction no longer increases the byte or line count. Short values may appear as `*` rather than
  `[secret NAME]`; diagnostics still prefer named markers. A warning distinguishes withheld output from execution failure.
- `recall` and `zoom` size pages with callable references and continuations, escaping public JSON keys when they
  collide with a declared value. A call that cannot be displayed safely is omitted with a warning. (BIJAN-166)
- Documented redaction limits: Pi stores diagnostics added after `afterTool` unredacted. Stock compaction and
  replay after protected extensions are deselected bypass the Responses payload guard.
  [BIJAN-167](https://linear.app/kapitan/issue/BIJAN-167) tracks the Pi hook.

Store: no schema or kit format change. Migration: none required.

## 0.2.6 - 2026-11-19

Opt-in transcript memory (BIJAN-139). Still on Pi Durable 1.5.2 and Effect 4.1.4.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). The first open of a store stamped by 0.2.5 backs it up to
`<store>.<UTC time>.bak` and restamps it. To roll back, restore the backup before opening it with 0.2.5.

### Added

- `memory()` from `galangan/kit/memory` adds `recall` and `zoom` over Pi's raw user and assistant history, including
  inherited messages through a fork point and messages removed from active context by stock compaction. The tools
  page their results and neither build summaries nor change compaction.
- The extension's store format is `galangan.memory` **1**. When opting in, spread `memoryFormats` into the harness's
  `formats` from the first install.

Known limit: in harnesses that declare secrets, redaction can break references or continuations from either tool.
It can rewrite call arguments even when the page fits, or expand a page past Pi's output limit and cut off its
next-page line. [BIJAN-166](https://linear.app/kapitan/issue/BIJAN-166) tracks the shell fix.

Migration: none required. Upgrade with `npm install --save-exact galangan@0.2.6`; memory is opt-in.

## 0.2.5 - 2026-11-18

Secrets for harness tools (BIJAN-164, from kirim's `TODOIST_API_TOKEN`). Still on Pi Durable 1.5.2 and Effect 4.1.4.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). Galangan wraps tools when installing extensions, so existing
conversation selections need no rewrite, including helpers saved before the upgrade. The first open by 0.2.5 of a
store 0.2.4 stamped copies it to `<store>.<UTC time>.bak` and restamps it; 0.2.4 then refuses that store (exit 78), so
roll back by restoring the backup.

Upgrading from 0.2.4: run `npm install --save-exact galangan@0.2.5`, and copy the Secrets section of
`template/AGENTS.md` from this tag.

### Added

- `defineHarness({ secrets: ["NAME", ...] })`: `runCli` exits 78 at startup, before the store opens, when a named
  variable is unset or empty, instead of the tool failing mid-conversation.
- Galangan replaces exact secret values with `[secret NAME]` in live tool progress, tool results and report lines.
  The protection handles streamed UTF-8 and follows installed tools through forks and helper recovery.
  `ShellOptions.env` sets where values are read from (default `process.env`).
- `conformance` checks the SQLite file and WAL for test secrets before the tool settles and after interrupted reopen.

Migration: none required. A harness whose tools read a variable lists it in `secrets` and can drop its own
"is not set" check; copy the Secrets section of `template/AGENTS.md`.

## 0.2.4 - 2026-11-18

The template ships its `package-lock.json`. Still on Pi Durable 1.5.2 and Effect 4.1.4, and no change to the shell's
API.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). The first open by 0.2.4 of a store 0.2.3 stamped copies it to
`<store>.<UTC time>.bak` and restamps it; 0.2.3 then refuses that store (exit 78), so roll back by restoring the
backup.

Upgrading from 0.2.3: run `npm install --save-exact galangan@0.2.4`. Nothing else in harness code changes.

### Fixed

- A new harness's first `npm install` wrote a lockfile that `npm ci` then rejected (`lock file's ws@8.23.0 does not
  satisfy ws@8.21.0`; chord pins `ws` exactly). `template/package-lock.json` is now committed, generated and checked
  with `npm ci`, so a new harness starts from a lockfile that installs.

Migration: none.

## 0.2.3 - 2026-11-18

Galangan is public: the repository is https://github.com/najibninaba/galangan and the package is `galangan` on npm.
Still on Pi Durable 1.5.2 and Effect 4.1.4, and no change to the shell's API.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). The first open by 0.2.3 of a store 0.2.2 stamped copies it to
`<store>.<UTC time>.bak` and restamps it; 0.2.2 then refuses that store (exit 78), so roll back by restoring the
backup.

Upgrading from 0.2.2: run `npm install --save-exact galangan@0.2.3`, which replaces the git dependency, and copy
`template/.agents/setup` and the Galangan half of `template/AGENTS.md` from this tag. Nothing else in harness code
changes.

### Fixed

- Harness orb setup (BIJAN-163): a fresh orb of a harness project could not fetch the git dependency on the
  Amp-hosted Galangan repository, because setup's credential cannot read another project's repository. 0.2.2's
  `amp git-setup` step did not fix it. Harnesses now take Galangan from npm, and the template's setup has no Git step.

### Changed

- The package is no longer `private`, and ships `CHANGELOG.md` beside `dist/`.

Migration: replace the `galangan` git dependency with `galangan@0.2.3` (above).

## 0.2.2 - 2026-11-18

Template and skill fixes found by kirim, the first published harness (BIJAN-156). Still on Pi Durable 1.5.2 and Effect
4.1.4, and no change to the shell's API.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). The first open by 0.2.2 of a store 0.2.1 stamped copies it to
`<store>.<UTC time>.bak` and restamps it; 0.2.1 then refuses that store (exit 78), so roll back by restoring the
backup.

Upgrading from 0.2.1: change the Galangan dependency's tag to `#v0.2.2`, and copy the "Check Git can read Galangan"
step from `template/.agents/setup` into the harness's `.agents/setup`. Nothing else in harness code changes.

### Fixed

- Harness orb setup (BIJAN-163): a fresh orb of a harness project could fail `npm ci` because ampcode.com rejected
  its Git credential for the Galangan repository. `template/.agents/setup` now checks that Git can read Galangan and
  runs `amp git-setup` when it cannot; it leaves working credentials alone and fails clearly without `amp`.
- Spin-off skill: creates the Amp project with `manage_amp` in an orb, rebases onto Amp's initial commits instead of
  force-pushing, and renames the package in `package-lock.json` too.

### Added

- Spin-off skill (BIJAN-153): `.agents/skills/spinning-off-harnesses` makes a harness repo from `template/` at the
  latest release tag. It renames tally (store, doc kinds, extension and tool), writes the harness half of AGENTS.md,
  runs `npm run ci` and the CLI, and, with the owner's approval, creates the Amp project and adds the harness to
  `HARNESSES.md`. It also says how a harness files fold-backs to Galangan. Nothing in the package changes.

Migration: none.

## 0.2.1 - 2026-11-17

The starter template for new harness repos: copy `template/` at this tag (see the README). Still on Pi Durable 1.5.2
and Effect 4.1.4, and no change to the shell's API.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). The first open by 0.2.1 of a store 0.2.0 stamped copies it to
`<store>.<UTC time>.bak` and restamps it; 0.2.0 then refuses that store (exit 78), so roll back by restoring the
backup.

Upgrading from 0.2.0: change the Galangan dependency's tag to `#v0.2.1`. Nothing else in harness code changes.

### Added

- Starter template (BIJAN-152): `template/` is what a new harness repo copies. It pins Galangan to this release's tag
  with the exact peers, keeps the erasable-syntax tsconfig with `skipLibCheck`, carries Galangan's conventions in
  AGENTS.md, runs check and test (with conformance) as `npm run ci`, and starts from tally in `src/`. Tests keep it
  equal to `examples/tally` and to this release's tag, pins and compiler options. Copy it from the release tag it
  pins, not from `main`; the README gives the commands. There is no CI workflow: ampcode.com has no CI runner, and a
  GitHub runner has no Amp git credentials to install Galangan.
- `examples/tally`'s test passes `from: process.env.CONFORMANCE_FROM` to `conformance`, as the README recommends, so
  `CONFORMANCE_FROM=<backup> npm test` works in a repo made from the template without an edit.

Migration: none.

## 0.2.0 - 2026-11-17

Galangan as a package other harness repos build on: they install it from this repository at the `v0.2.0` tag, import
only `galangan` and `galangan/testing`, and run its conformance cases against their own harness. Still on Pi Durable
1.5.2 and Effect 4.1.4; the shell's API changed, so this opens the 0.2 line, which also follows Pi 1.5.

Store: no Pi migration; Pi stays at 1.5.2 (schema 2). Galangan adds its `galangan_store` stamp table on the first
open, after copying the store to `<store>.<UTC time>.bak`. Treat that as one-way: 0.1.0 does not check the stamp, so
roll back by restoring the backup, not by running 0.1.0 on the stamped store. Existing tally counts are not carried
over (see Changed).

Upgrading from 0.1.0:

1. Depend on `galangan@git+https://ampcode.com/@najib/galangan.git#v0.2.0` and add Pi (`pi-durable`, `pi-ai`, `chord`,
   `pi-schema` 1.5.2) and `effect` 4.1.4 as your own exact dependencies; they are peers now.
2. Import from `galangan` and `galangan/testing` only, and call `runCli([...])` from the harness's entry point.
3. Rename any `galangan.*` doc kinds, extension names and `galangan_*` tool names to the harness's own prefix.
4. Add `conformance(myHarness)` to the harness's tests, and run it against a backup of the store before deploying.
5. Expect one backup beside the store on the first open; later opens of a stamped store make none.

### Added

- Conformance cases (BIJAN-149): `conformance(spec, { from? })` in `galangan/testing` registers node:test cases a
  harness runs against its own spec, offline, over real SQLite: state survives a close and reopen, commits use
  `synchronous = FULL`, a repeated request ID is answered once (also after a reopen), and a non-replay-safe tool cut
  off mid-call returns `interrupted` without running again. `from` runs every case on a copy of an existing store
  that no process holds, and checks the copy starts from its history, for the upgrade step in
  docs/pin-and-release-policy.md. Tool names starting `galangan_` are now reserved for the shell, like `galangan.`
  doc kinds and extension names. Tally runs it; the generic reopen and request ID cases moved
  there from `test/shell.test.ts`.
  Migration: add `conformance(myHarness)` to the harness's tests.
- Store stamp (BIJAN-150): every open records the Galangan and Pi versions in a `galangan_store` table. A store
  stamped by a newer Galangan or Pi, or at a newer Pi schema, fails with `StoreIncompatible` (CLI exit 78) naming both
  versions. An open that upgrades a store first copies it to `<store>.<UTC time>.bak`, so a rollback restores that
  copy; a failed copy is `StoreBackupFailed` (exit 78) and leaves the store as it was. `HarnessSpec.formats` gives a
  kit extension's store format, 0 when undeclared; a store with another one fails at open.
  Migration: none in code. The first open by this build of an existing store backs it up once, since it has no stamp.
- Public package boundary (BIJAN-147): `galangan` (`src/index.ts`) and `galangan/testing` (`src/testing.ts`) are the
  only entries in `package.json` `exports`; everything else under `src/` is internal. `galangan/testing` has the faux
  model and `tempStore(t)`, a store path in a temporary directory removed after the test.
- `runCli(harnesses)` is the CLI, so a harness repo's entry point is one call and the shell imports no harness.
  `GALANGAN_HARNESS` picks among the harnesses passed, defaulting to the first.
- Pi (`pi-durable`, `pi-ai`, `chord`, `pi-schema`) and Effect are exact `peerDependencies`, so a harness cannot load a
  second copy.
- Harness repos install Galangan as a git dependency pinned to a release tag or commit (BIJAN-148). `prepare` builds
  `dist/` (JS and `.d.ts`) on install, since Node does not strip types under `node_modules`; `exports` points there by
  default.
  Galangan's own npm scripts use the `galangan-source` condition, so its runs and tests still need no build.
  Migration: run files in this repository through the npm scripts, or with `node --conditions=galangan-source`.

### Changed

- `tally` moved to `examples/tally/` with its CLI (`main.ts`, still `npm start`) and its own test, importing only the
  public entries. Its doc kind is now `tally.counts` and its extension `tally`: `galangan.*` doc kinds and extension
  names are reserved for the shell.
  Migration: counts in an existing tally store are not read under the new kind; no store worth keeping existed.
  Harness code imports `defineHarness`, `helper` and the rest from `galangan` instead of `src/*.ts`, and calls
  `runCli([...])` instead of listing itself in `src/harnesses/index.ts`, which is gone.

## 0.1.0 - 2026-11-17

The first working release: a usable command-line app on Pi Durable 1.5.2 and Effect 4.1.4. Opens the 0.1 line, which
follows Pi 1.5.

Store: no migration by Galangan. Pi 1.5.2 keeps SQLite stores at schema version 2. The default store location moved
(see Changed).

### Added

- Harness app shell: a harness is `defineHarness({ name, extensions })` built from Pi extensions, and the `Shell`
  Effect layer opens the Pi Harness over SQLite (`synchronous = FULL`), resumes unfinished work, exposes `ask()` and
  closes the Harness when its scope ends. Ships the `tally` example harness.
- CLI (`npm start`): one message as arguments, or one message per stdin line. `--init` creates the store; it is the
  only way to create one.
- Exit codes: 0 done, 1 failed (restart it), 75 store in use by another process, 78 bad configuration (including a
  missing store), 130/143 stopped by SIGINT/SIGTERM.
- Real models: `GALANGAN_MODEL=real` selects OpenAI Terra 6.1 (`openai/gpt-6.1-terra`) at `medium` effort, or name any
  `<provider>/<model id>` from pi-ai's catalog. The default stays the offline `faux` model, so nothing spends money
  unless asked.
- `GALANGAN_THINKING` sets the Pi thinking level. It defaults to `medium` when the model supports it, otherwise the
  first supported level. An unsupported level is a configuration error (exit 78), never silently clamped. Model and
  effort are applied to the root on every open, so an existing store switches models without losing history.
- Opt-in reasoning helper: `helper()` from `src/helper.ts` offers `delegate({ task })`, which asks OpenAI Sol 6.1 at
  `high` for findings that the root model turns into the answer. It is task-owned and replay-safe across restarts,
  has no extensions unless opted in, cannot delegate recursively, and has a persisted budget of three calls per
  answer. The `tally` harness does not opt in.
- `npm run smoke:real`: a separate, paid OpenAI check across a process restart, reporting committed model, effort,
  token usage and estimated cost. `npm test` stays faux-only with no network.
- `npm run smoke:recovery`: a separate, paid, cost-capped experiment that SIGKILLs a real-model process at four points
  (during Terra streaming, after a tally increment before its result commits, during Sol streaming, and after Sol's
  answer commits before the delegate result does), then reopens the store in another process. Its run on this release
  (Terra at `medium`, Sol at `high`) passed all four:
  - A kill during a model request recovers by itself: Pi 1.5.2 retries (up to three times), and the caller gets the
    answer.
  - A kill inside a tool that is not replay-safe (`tally`) does not run it again: the count stays at 1, and the model
    gets an `interrupted` result.
  - A kill during a helper call keeps one child conversation, one submission and the same budget. A Sol answer that
    was already stored is reused without another Sol request.
  - Known limit: Pi records no usage for an interrupted attempt, so `harness.usage()` can understate what the provider
    bills. Running out of retries and a crash loop up to Pi's restart limit are not tested yet.
- Pin and release policy (BIJAN-151) in [docs/pin-and-release-policy.md](docs/pin-and-release-policy.md).

### Changed

- Stores default to `~/.galangan/<harness>.sqlite`, the same from any working directory (BIJAN-136), instead of
  `./data/<harness>.sqlite`. `GALANGAN_DATA` overrides the directory. A run from a directory that holds an old
  `./data` store prints a hint.
  Migration: set `GALANGAN_DATA=./data`, or move `./data/<harness>.sqlite` to `~/.galangan/`. Do not run `--init`,
  which would start an empty store.

### Fixed

- One process per store: the shell holds SQLite's exclusive lock while open, so a second process exits 75 instead of
  writing alongside the first (BIJAN-135). Busy is read from the primary result code, so `SQLITE_BUSY_RECOVERY`
  counts, and a short jittered retry keeps two processes started together from both being refused.
- A missing store exits 78 and names the path it looked for, instead of starting the harness with an empty past. A
  store path that is not a file exits 78 too, instead of a `SQLITE_CANTOPEN` defect.
- `--init` on an existing store says so and leaves it unopened, so it never resumes that store's unfinished runs.
  `--init` takes no other arguments.
- In stdin mode an unanswered line (bad tool arguments, a model error) prints its error and the session reads the
  next line, instead of ending the session.
- SIGINT and SIGTERM close the Harness first, so running work goes back to pending and the lock is released; a second
  signal exits at once.
