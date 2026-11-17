// The CLI's store as separate processes: its default location under HOME, and the lock a second process hits.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** A temp HOME with no GALANGAN_DATA, so the CLI picks its default store. */
function home(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "galangan-home-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { GALANGAN_DATA: _, ...env } = process.env;
	return { dir, env: { ...env, HOME: dir, GALANGAN_HARNESS: "tally", GALANGAN_MODEL: "faux" } };
}

const cli = (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
		// The timeout kills a hung CLI, so a regression fails the test instead of hanging npm test.
		execFile(process.execPath, [main, ...args], { env, cwd, timeout: 20_000 }, (error, stdout, stderr) =>
			done({ code: error === null ? 0 : Number(error.code), stdout: stdout.trim(), stderr }));
	});

describe("store", () => {
	it("is one store under HOME from any working directory, made only by --init", async (t) => {
		const { dir, env } = home(t);
		const [a, b] = [join(dir, "a"), join(dir, "b")];
		mkdirSync(a);
		mkdirSync(b);
		const store = join(dir, ".galangan", "tally.sqlite");

		const missing = await cli(env, a, 'call tally {"label":"cups"}');
		assert.equal(missing.code, 78);
		assert.match(missing.stderr, new RegExp(`no store at ${store}`));
		assert.equal(existsSync(store), false);

		assert.equal((await cli(env, a, "--init")).code, 0);
		assert.equal((await cli(env, a, 'call tally {"label":"cups"}')).stdout, "tally: cups = 1");
		assert.equal((await cli(env, b, 'call tally {"label":"cups"}')).stdout, "tally: cups = 2");

		// A second --init leaves the store alone instead of opening it, which would resume its unfinished runs.
		const again = await cli(env, b, "--init");
		assert.deepEqual([again.code, again.stderr], [0, `galangan: store already exists at ${store}\n`]);
		assert.equal((await cli(env, a, 'call tally {"label":"cups"}')).stdout, "tally: cups = 3");
	});

	it("points a missing default store at a store left in ./data by the old default", async (t) => {
		const { dir, env } = home(t);
		assert.equal((await cli({ ...env, GALANGAN_DATA: join(dir, "data") }, dir, "--init")).code, 0);
		const missing = await cli(env, dir, 'call tally {"label":"cups"}');
		assert.equal(missing.code, 78);
		assert.match(missing.stderr, new RegExp(`found a store at ${join(dir, "data", "tally.sqlite")}`));
		assert.equal(existsSync(join(dir, ".galangan")), false);
	});

	it("refuses a second process while one has the store open, and serves the next one after it exits", async (t) => {
		const { dir, env } = home(t);
		assert.equal((await cli(env, dir, "--init")).code, 0);

		// The first process holds the store while its stdin stays open.
		const first = spawn(process.execPath, [main], { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
		t.after(() => first.kill("SIGKILL"));
		const exited = once(first, "exit");
		await Promise.race([
			new Promise<void>((ready) => first.stderr.on("data", (chunk) => {
				if (String(chunk).includes("one message per line")) ready();
			})),
			exited.then(() => assert.fail("the first process exited before it opened the store")),
		]);

		const started = Date.now();
		const second = await cli(env, dir, 'call tally {"label":"cups"}');
		assert.equal(second.code, 75);
		assert.match(second.stderr, /in use by another process/);
		// chord's default busy timeout would hold the refusal for about 5 s; this is process start-up time.
		assert.ok(Date.now() - started < 4000, `refused after ${Date.now() - started} ms`);

		first.stdin.end();
		assert.equal((await exited)[0], 0);
		assert.equal((await cli(env, dir, 'call tally {"label":"cups"}')).stdout, "tally: cups = 1");
	});
});
