import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import guard, { scanCommand } from "../extensions/worktree-guard.ts";

test("env wrappers preserve Git mutations and worktree destinations", () => {
	for (const prefix of ["env", "/usr/bin/env", "env FOO=bar", "env -i", "env -u FOO", "env --unset=FOO --", "env env"]) {
		assert.deepEqual(scanCommand(`${prefix} git stash`, "/fixture").hits, [{ op: "stash", dir: "/fixture" }]);
		assert.deepEqual(scanCommand(`${prefix} git worktree add /tmp/outside -b feature`, "/fixture").adds, [
			{ dir: "/fixture", target: "/tmp/outside", branch: "feature" },
		]);
		assert.deepEqual(scanCommand(`${prefix} git status`, "/fixture"), { hits: [], adds: [], indirect: false });
	}
	assert.equal(scanCommand("env -C /other git stash; git stash", "/fixture").hits[0].dir, "/other");
	assert.equal(scanCommand("env -C /other git stash; git stash", "/fixture").hits[1].dir, "/fixture");
	assert.equal(scanCommand("env --chdir=/other git stash", "/fixture").hits[0].dir, "/other");
	assert.equal(scanCommand("env -S 'git stash'", "/fixture").indirect, true);
});

test("heartbeat keeps claims fresh and never recreates a removed claim", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-claims-"));
	const git = path.join(root, ".git");
	fs.mkdirSync(git);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const hooks = new Map<string, (...args: any[]) => any>();
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => hooks.set(name, handler),
		exec: async (_command: string, args: string[]) => ({
			code: 0, stdout: args.includes("--abbrev-ref") ? "main\n" : `${git}\n${git}\n${root}\n`, stderr: "",
		}),
	};
	guard(pi as never);
	await new Promise(resolve => setImmediate(resolve));
	t.after(() => hooks.get("session_shutdown")?.());
	const directory = path.join(git, "pi-agent-claims");
	const file = path.join(directory, fs.readdirSync(directory)[0]);
	const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
	const initial = read().lastBeat;
	t.mock.timers.tick(11 * 60 * 1000);
	assert.equal(read().lastBeat, initial + 11 * 60 * 1000);
	fs.rmSync(file);
	t.mock.timers.tick(30000);
	assert.equal(fs.existsSync(file), false);
	hooks.get("session_shutdown")?.();
});

test("the tool-call hook blocks env mutations and misplaced worktrees in an isolated checkout", async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-block-")));
	const git = path.join(root, ".git");
	const claims = path.join(git, "pi-agent-claims");
	fs.mkdirSync(claims, { recursive: true });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const previous = process.env.PI_WORKTREE_ROOT;
	process.env.PI_WORKTREE_ROOT = path.join(path.dirname(root), ".worktrees");
	t.after(() => {
		if (previous === undefined) delete process.env.PI_WORKTREE_ROOT;
		else process.env.PI_WORKTREE_ROOT = previous;
	});
	const hooks = new Map<string, (...args: any[]) => any>();
	guard({
		on: (name: string, handler: (...args: any[]) => any) => hooks.set(name, handler),
		exec: async (_command: string, args: string[]) => ({
			code: 0, stdout: args.includes("--abbrev-ref") ? "main\n" : `${git}\n${git}\n${root}\n`, stderr: "",
		}),
	} as never);
	await new Promise(resolve => setImmediate(resolve));
	t.after(() => hooks.get("session_shutdown")?.());
	fs.writeFileSync(path.join(claims, "rival.json"), JSON.stringify({
		host: os.hostname(), pid: process.ppid, branch: "main", lastBeat: Date.now(),
	}));
	const check = (command: string) => hooks.get("tool_call")!({ toolName: "bash", input: { command } }, { cwd: root, hasUI: false });
	assert.equal((await check("env git stash")).block, true);
	assert.equal(await check("env git status"), undefined);
	assert.equal((await check("env git worktree add /tmp/outside -b feature")).block, true);
});
