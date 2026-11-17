// Galangan's test entry (`import ... from "galangan/testing"`): the offline faux model and a temporary store, so a
// harness's tests run over real file-backed SQLite with no network or keys, as Galangan's own tests do.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export { fauxAnswer, fauxModels, FAUX_MODEL } from "./models.ts";

/** A store path in a fresh temporary directory that is removed after the test. The file itself does not exist yet. */
export function tempStore(t: TestContext, file = "store.sqlite"): string {
	const dir = mkdtempSync(join(tmpdir(), "galangan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, file);
}
