# Pin and release policy

From BIJAN-151, adapted from Lunas's [Pi pin policy](https://github.com/najibninaba/lunas/blob/main/docs/pi-pin-policy.md)
for a shell that downstream harnesses build on. Pi Durable ships a minor release every few days to two weeks, each
minor can break its API, and its store migrations are one-way, so Galangan's versions say which Pi a harness gets.

## 1. What is pinned

- `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-schema` are pinned to the same exact version and move
  together.
- `effect` is pinned exactly and tracks its latest stable release.
- `.npmrc` sets `save-exact=true`, `package-lock.json` is committed, and orbs install with `npm ci`.
- Published npm releases only. A git dependency or vendored upstream `main` needs its own decision.

## 2. Release lines

- Galangan follows every Pi minor. Harnesses may lag behind by staying on an older Galangan line.
- One Galangan minor line per Pi minor: 0.1.x is Pi 1.5.x. The next Pi minor (1.6) opens 0.2.0, and so on. Before
  1.0, a Galangan minor may also break the shell's own API.
- Shell fixes and Pi patch bumps ship as patch releases on the newest line only. There are no backports to older lines;
  a harness that needs a fix moves to the newest line.
- Every release is a commit that sets `package.json` `version` (and `WRITER` in `src/shell.ts`, which a test keeps
  equal), adds a `CHANGELOG.md` entry, and carries an annotated
  tag `v<version>` on `main`. `npm run check` and `npm test` pass on that commit.

## 3. Release notes

Each `CHANGELOG.md` entry says:

- Which Pi and Effect versions it pins, when they change.
- Whether the release migrates the store, and to which SQLite schema version. Treat every schema migration as one-way.
- A Pi-style `Migration:` line for every change harness code or deployments must make, with before and after where it
  helps.

## 4. Bumping Pi

One change on `main`:

1. Read Pi's `CHANGELOG.md` for every version crossed, not only the newest.
2. Update the code and the README's Pins table and API notes, then run `npm run check` and `npm test`.
3. If the bump crosses a Pi minor, release it as the next Galangan minor; otherwise as a patch.
4. Say in the release notes whether the store migrates.

## 5. Upgrading a harness

1. Bump the one Galangan version the harness depends on.
2. Fix the `tsc` errors, guided by the `Migration:` lines.
3. Run the harness's conformance tests against a copy of the production store.
4. Stop the process and back up the store: copy the SQLite file and its WAL while no process holds it.
5. Deploy. The first open by the new version also copies the store to `<store>.<UTC time>.bak` beside it.

Roll back by restoring that backup with the old version, never by running the old version on a migrated store. A
version with BIJAN-150 or later refuses a store a newer one stamped (exit 78), so it cannot open it by mistake; 0.1.0
predates the stamp and does not check it.

## 6. Open decisions

- Follow every Pi minor (this policy) or bump only on need, as Lunas does. Owner to confirm.
- Distribution. The package is Apache-2.0 but `private: true`, so for now harnesses take Galangan from the repository at
  a release tag. Public npm, a private registry or git dependencies are still to be decided.
