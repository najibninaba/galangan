# Changelog

Each release says whether it migrates the store and gives a `Migration:` line for every change harness code must
make. See [docs/pin-and-release-policy.md](docs/pin-and-release-policy.md) for release lines and how to upgrade.

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
