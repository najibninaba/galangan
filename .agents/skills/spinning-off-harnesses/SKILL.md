---
name: spinning-off-harnesses
description: "Spins off a new standalone harness repo from Galangan's template: copies template/ at the latest release tag, renames the starting tally harness (its store, doc kinds, extension and tool), writes the harness half of AGENTS.md, runs npm run ci and the CLI, then, with approval, creates the Amp project and adds it to Galangan's HARNESSES.md registry. Use when asked to start, create, scaffold, or spin off a new harness, agent, or harness repo on Galangan, and for proposing fold-backs from a harness to Galangan. Not for adding tools to an existing harness repo or for changing Galangan's shell."
---

# Spinning off a harness repo

A harness repo is its own git repository. It depends on the npm package `galangan` at an exact release, plus Galangan's exact Pi and Effect peers, and its code imports only `galangan` and `galangan/testing`. It starts as a copy of Galangan's `template/`, whose `src/` holds tally, the example harness. The copy is mechanical. Spend your attention on the name, the rename, and the harness half of AGENTS.md.

## Ask first

Ask the requester in one message for whatever they have not already told you:

- The harness name, matching `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, such as `pantry` or `pantry-box`: it starts with a letter, because Pi rejects a section key that does not and `<Camel>Harness` must be a valid identifier. It names the store (`~/.galangan/<name>.sqlite`), the doc-kind and extension prefix, the package and the repository. Refuse `tally`, `instructions` (Pi reserves that section key), `galangan` and names starting with `galangan`. Check it against `amp projects list` and Galangan's `HARNESSES.md`, if it exists, so two harnesses never share a store.
- What the harness is for, in a sentence or two.
- Its owner. The default is the person asking.
- Whether you may create the Amp project and push the repo once its checks pass (step 5). Ask now, because the new repo lives outside the orb's own checkout: an orb deleted while you wait for approval loses a repo that was never pushed. If the owner wants to review first, tell them the repo exists only in this orb until it is pushed.

Do not ask for a version: always use the latest release tag.

Below, `<name>` is the harness name, `<snake>` is that name with hyphens replaced by underscores, `<Camel>` is it in camelCase, such as `pantryBox` for `pantry-box`, and `<tag>` is the release tag step 1 prints. Write these values literally into every command: each command may run in a new shell, so a shell variable set in one command is empty in the next.

## 1. Copy the template at the latest release tag

Run these from the root of the Galangan checkout. The new repo goes next to it, at `../<name>`, never inside it.

```sh
git ls-remote --tags --refs https://github.com/najibninaba/galangan.git 'v*' | sed 's#.*refs/tags/##' | sort -V | tail -1
rm -rf /tmp/galangan-<tag> && git -c advice.detachedHead=false clone --quiet --depth 1 --branch <tag> https://github.com/najibninaba/galangan.git /tmp/galangan-<tag>
mkdir ../<name> && cp -r /tmp/galangan-<tag>/template/. ../<name>/
cd ../<name> && git init --quiet --initial-branch=main && ./.agents/setup && npm run ci
```

- The last line installs and tests the untouched copy before you edit anything. If `.agents/setup` or `npm run ci` fails here, the template at that tag is broken: file it as a fold-back, and fix it in the new repo only as a marked workaround.
- Copy from the tag, not from a Galangan checkout's `main`: between releases `main` can carry shell API or peers that the tag the template pins lacks, and `test/template.test.ts` only holds the template in step at release commits.
- Copy `template/.`, not `template/*`, so `.npmrc`, `.gitignore` and `.agents/` come too.
- The clone warns that the tag "is not a commit". That is harmless: the tag is annotated.
- Keep the template's pin: `galangan` at the tag's version without the `v`, which the committed `package-lock.json` records as the npm tarball of that version. Step 4 checks this.

## 2. Rename tally to the harness

Until the rename, the repo shares `~/.galangan/tally.sqlite` with every other unrenamed copy, and its doc kinds and tool names collide with them. Rename all of these:

- Files: `src/tally.ts` becomes `src/<name>.ts`, and `src/tally.test.ts` becomes `src/<name>.test.ts`. Update the imports in `main.ts` and the test.
- Harness: `tallyHarness` becomes `<Camel>Harness`, and `name: "tally"` in `defineHarness` becomes `"<name>"`. This name names the store.
- Extension and section: `name: "tally"` in `defineExtension`, and the `section("tally", …)` id, become `"<name>"`.
- Doc kind: `tally.counts` becomes `<name>.counts`. Keep `version: 1`, because this is a new kind in a new store.
- Tool: `tally` becomes `<snake>_tally`. Update the section's prompt text that names it. In the test, `call tally {…}` becomes `call <snake>_tally {…}`, and each expected answer `tally: cups = 1` becomes `<snake>_tally: cups = 1`, because the faux model answers `<tool name>: <result>`.
- The package name becomes `<name>` in `package.json` and in both places in `package-lock.json`, and the AGENTS.md title becomes `<name>`. The template ships them as `my-harness`: `jq '.name = "<name>"' package.json`, and `jq '.name = "<name>" | .packages[""].name = "<name>"' package-lock.json`, each written to a temporary file and moved back.
- The file-top comments: rewrite them to say what this harness is, instead of calling it Galangan's example.

Keep the counter tool as the starting tool, renamed, unless the requester described the first real tool. Conformance needs only some harness to run against, and the first real feature replaces the counter later.

Then run `rg -n -i tally src package.json` and `rg --files src | rg -i tally`. The first should print only the tool's local variable `tally` and `<snake>_tally`; a leftover such as `tallyHarness`, `"tally"` or `tally.counts` means a missed rename. The second should print nothing. `rg -n my-harness package.json package-lock.json AGENTS.md` should print nothing too. Doc kinds and extension names starting with `galangan.`, and tool names starting with `galangan_`, belong to the shell. Galangan does not enforce this yet, and Pi lets a later tool silently replace an earlier one with the same name.

## 3. Write the harness half of AGENTS.md

The template's AGENTS.md has two halves, each marked by an HTML comment. Replace the text under the first comment, which is the harness half, and keep the comment. Leave the Galangan half, from its comment to the end of the file, byte for byte. It is a copy of Galangan's `template/AGENTS.md` and changes only by being copied again from a newer tag.

Write in the harness half only facts an agent in this repo cannot infer from its code:

- What the harness is for, in the requester's words.
- Its names: the harness `<name>`, the prefix `<name>.` for doc kinds and extensions, the prefix `<snake>_` for tools, and the store `~/.galangan/<name>.sqlite`.
- Its tools and doc kinds now: `<snake>_tally` and `<name>.counts`, marked as the starting counter that the first real tool replaces.
- Secrets: each environment variable the harness's tools will need, such as an API token, listed in `secrets` in `defineHarness`, and which Amp project holds it. Tally needs none; add them with the first real tool.
- Upstream: Galangan at `<tag>` (`https://github.com/najibninaba/galangan`, npm `galangan`). Fold-backs to Galangan go in Linear, team Bijandev, project Galangan, as described in "Fold-backs" below; write that procedure into this half, because this skill is not loaded in the harness repo. Name the owner.

## 4. Install and verify

Run these from the new repo's root:

```sh
./.agents/setup && npm run ci    # tsc, then node --test including "galangan conformance: <name>"
jq -r '.packages["node_modules/galangan"].resolved' package-lock.json
mkdir -p /tmp/<name>-check && GALANGAN_DATA=/tmp/<name>-check npm start -- --init
GALANGAN_DATA=/tmp/<name>-check npm start -- 'call <snake>_tally {"label":"cups"}'    # prints: <snake>_tally: cups = 1
ls /tmp/<name>-check                                                                   # <name>.sqlite, not tally.sqlite
```

- The lockfile's `resolved` URL must be `https://registry.npmjs.org/galangan/-/galangan-<version>.tgz`, where `<version>` is `<tag>` without the `v`.
- Set `GALANGAN_DATA` on each `npm start` line, as above, so the check never leaves a store in `~/.galangan`. If `/tmp/<name>-check` already holds a store, `--init` says so; delete the directory first.

Then commit everything, including `package-lock.json`: `git add -A && git commit -m "Start <name> from the Galangan <tag> template"`.

## 5. Publish it (approval needed)

Creating the repository and pushing need the owner's explicit approval, which you asked for up front. If you do not have it yet, ask now for both at once.

In an orb, `amp projects create` fails: the orb's credentials cannot create projects. Create the project with the `manage_amp` tool instead, topic `projects`, operation `create`, with parameters `{ "owner": "personal", "repository_mode": "amp-hosted", "name": "<name>" }`. Use `"owner": "workspace"` for a workspace project. It returns the repository URL, such as `https://ampcode.com/@<namespace>/<name>`. `personal` means the account the thread runs as. If the owner is someone else, have them create the project, or give them the command below to run on their own machine.

The new Amp-hosted repository is not empty: Amp writes its own "Initialize repository" commits, so a plain first push is rejected. Rebase onto them rather than force-pushing, run the checks again, then push. Run this from the new repo's root, with the URL `manage_amp` returned:

```sh
git remote add origin <repository URL>.git && git fetch --quiet origin
git rebase origin/main && npm run ci && git push -u origin main
```

Outside an orb, `amp projects create --push --personal --name <name>` from the new repo's root is meant to do this in one step; it has not been tried yet.

Orbs for the project run `.agents/setup` on their own, and it needs no pre-setup script, because Galangan comes from npm. A harness copied from v0.2.2 or older takes Galangan from a git dependency, which fails in fresh orbs (BIJAN-163): move it to npm as the 0.2.3 CHANGELOG says. Confirm the push with `git ls-remote origin main`, which must print your `HEAD`, and `amp projects status` from the new repo's root: it prints the project its git remote matches, and that project's URL is the repository URL for the registry.

Then add the harness to the downstream registry: one row in `HARNESSES.md` at the root of the Galangan repo. If the file does not exist yet, create it with this header (BIJAN-154 owns the registry and the review routine that reads it):

```markdown
# Harnesses on Galangan

Each harness repo built on Galangan, the release it pins and its owner. Galangan's release review checks each one for fold-backs.

| Harness | Repository | Galangan | Owner |
|---|---|---|---|
| <name> | <repository URL from amp projects status> | <tag> | <owner> |
```

Commit the registry change in Galangan, and push it only with the owner's approval. Add only harnesses that are published. A trial spin-off that is never pushed stays out of the registry.

## Fold-backs

When a harness needs something the shell does not offer, or finds a gap in Galangan, propose the change to Galangan. Do not patch `node_modules/galangan`, copy shell code into the harness, or import Galangan's internal paths. A gap can be a durability bug, a missing check, a convention every harness should follow, or a template step that failed. File a Linear issue in team Bijandev, project Galangan. Name the harness, what happened, how to reproduce it, and which channel it goes through:

- A runtime fix becomes a shell change in the next Galangan release.
- A failure mode the shell should catch becomes a case in `conformance` (`galangan/testing`), so every harness runs it on its next bump.
- A convention becomes text in Galangan's `template/AGENTS.md`, in the Galangan half.
- An extension a second harness wants moves into the opt-in kit (BIJAN-155).

Build a feature in the harness first, and promote it when a second harness needs it. Promote durability fixes at once. Until the release lands, a workaround in the harness's own code is fine if it carries a comment that links the issue.
