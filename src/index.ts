// Galangan's shell entry (`import ... from "galangan"`). Testing and opt-in kit extensions use the subpaths in
// package.json's exports. Before 1.0 a minor release may still break a public API; CHANGELOG.md gives a `Migration:`
// line for each break.
export { runCli } from "./cli.ts";
export { defineHarness, type HarnessSpec } from "./harness.ts";
export { helper } from "./helper.ts";
export { chooseModel, chooseThinking, InvalidModel, REAL_MODEL, type ModelChoice } from "./models.ts";
export {
	Shell,
	StoreBackupFailed,
	StoreIncompatible,
	StoreLocked,
	StoreMissing,
	Unanswered,
	type ShellOptions,
} from "./shell.ts";
