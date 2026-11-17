// Galangan's public entry (`import ... from "galangan"`). A harness repo imports only this and "galangan/testing";
// every other file under src/ is internal and may change in any release. Before 1.0 a minor release may still break
// what is exported here; CHANGELOG.md gives a `Migration:` line for each break.
export { runCli } from "./cli.ts";
export { defineHarness, type HarnessSpec } from "./harness.ts";
export { helper } from "./helper.ts";
export { chooseModel, chooseThinking, InvalidModel, REAL_MODEL, type ModelChoice } from "./models.ts";
export { Shell, StoreLocked, StoreMissing, Unanswered, type ShellOptions } from "./shell.ts";
