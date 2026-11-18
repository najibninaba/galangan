// The CLI as a child process over a temp store and the faux model: a stdin session survives an unanswered line,
// SIGINT or SIGTERM closes the Harness, and with it the store's lock, before exiting, and a missing secret is a
// configuration error at startup.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, type TestContext } from "node:test";

const MAIN = join(import.meta.dirname, "..", "examples", "tally", "main.ts");
const ENV = { GALANGAN_MODEL: "faux", GALANGAN_HARNESS: "tally" };

/** Starts the CLI in stdin mode on `data`; `until(text)` waits for `text` on stdout or stderr. */
function cli(t: TestContext, data: string) {
	const child = spawn(process.execPath, [MAIN], {
		env: { ...process.env, ...ENV, GALANGAN_DATA: data },
	});
	t.after(() => child.kill("SIGKILL"));
	const out = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out.stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out.stderr += chunk));
	const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	// A CLI that never exits fails its test instead of hanging npm test; t.after then kills it.
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	t.after(() => clearTimeout(timer));
	const until = async (text: string) => {
		while (!out.stdout.includes(text) && !out.stderr.includes(text)) {
			const ended = await Promise.race([once(child.stdout, "data"), once(child.stderr, "data"), exited.then(() => true)]);
			if (ended === true) assert.fail(`exited before ${JSON.stringify(text)}:\n${out.stderr}`);
		}
	};
	return { child, out, exited, until };
}

/** A fresh store directory with the tally store made by `--init`. */
function tempData(t: TestContext): string {
	const data = mkdtempSync(join(tmpdir(), "galangan-cli-"));
	t.after(() => rmSync(data, { recursive: true, force: true }));
	const env = { ...process.env, ...ENV, GALANGAN_DATA: data };
	execFileSync(process.execPath, [MAIN, "--init"], { env, stdio: "ignore", timeout: 20_000 });
	return data;
}

describe("cli", () => {
	it("prints an unanswered line's error and keeps reading stdin", async (t) => {
		const { child, out, exited } = cli(t, tempData(t));
		child.stdin.end('call tally {"label":"cups"}\ncall tally {bad\n\ncall tally {"label":"cups"}\n');
		const [code] = await exited;
		assert.equal(code, 0, out.stderr);
		assert.equal(out.stdout, "tally: cups = 1\ntally: cups = 2\n");
		assert.match(out.stderr, /galangan: unanswered \(model_error\): .*JSON/);
	});

	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
		it(`closes the Harness on ${signal} and releases the store for the next process`, async (t) => {
			const data = tempData(t);
			const first = cli(t, data);
			first.child.stdin.write('call tally {"label":"cups"}\n');
			await first.until("tally: cups = 1");
			first.child.kill(signal);
			const [exitCode, killedBy] = await first.exited;
			assert.deepEqual([exitCode, killedBy], [code, null], first.out.stderr);
			// Pi's harness.closed settled with kind "closed": the scope released the Harness, not the default handler.
			assert.match(first.out.stderr, new RegExp(`galangan: ${signal}, closing\\ngalangan: closed\\n`));

			const second = cli(t, data);
			second.child.stdin.end('call tally {"label":"cups"}\n');
			await second.until("tally: cups = 2");
			assert.equal(second.out.stdout, "tally: cups = 2\n", second.out.stderr);
		});
	}

	it("exits 78 at startup when a secret the harness names is unset, before it touches the store", (t) => {
		const data = mkdtempSync(join(tmpdir(), "galangan-cli-"));
		t.after(() => rmSync(data, { recursive: true, force: true }));
		const main = join(data, "main.ts");
		const index = pathToFileURL(join(import.meta.dirname, "..", "src", "index.ts")).href;
		writeFileSync(main, `import { defineHarness, runCli } from ${JSON.stringify(index)};
await runCli([defineHarness({ name: "needy", secrets: ["NEEDY_TOKEN", "NEEDY_OTHER"], extensions: [] })]);
`);
		const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [main, "--init"], {
			env: { ...process.env, GALANGAN_DATA: data, NEEDY_TOKEN: undefined, NEEDY_OTHER: undefined, ...env },
			encoding: "utf8",
			timeout: 20_000,
		});
		const unset = run({ NEEDY_OTHER: "set" });
		assert.equal(unset.status, 78, unset.stderr);
		assert.equal(unset.stderr, "galangan: needy needs NEEDY_TOKEN set in the environment\n");
		// Empty is unset: an empty token would only fail later, at the service.
		assert.equal(run({ NEEDY_TOKEN: "", NEEDY_OTHER: "set" }).status, 78);
		assert.equal(existsSync(join(data, "needy.sqlite")), false);
		const set = run({ NEEDY_TOKEN: "t", NEEDY_OTHER: "o" });
		assert.equal(set.status, 0, set.stderr);
		assert.equal(existsSync(join(data, "needy.sqlite")), true);
	});
});
