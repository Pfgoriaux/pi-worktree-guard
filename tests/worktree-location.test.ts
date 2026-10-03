import assert from "node:assert/strict";
import * as os from "node:os";
import test from "node:test";
import { locationViolation, mirroredRoot, scanCommand, worktreeAdd } from "../extensions/worktree-guard.ts";

const central = "/ws/.worktrees";
const repo = "/ws/products/app";
const mirror = "/ws/.worktrees/products/app";

test("parses the worktree path and branch across option forms", () => {
	assert.deepEqual(worktreeAdd(["git", "worktree", "add", "../x", "-b", "feat/a"], repo), {
		dir: repo,
		target: "/ws/products/x",
		branch: "feat/a",
	});
	assert.deepEqual(worktreeAdd(["git", "-C", "/ws/products/app", "worktree", "add", "-B", "b", "--lock", "--reason", "r", "/tmp/y", "main"], "/"), {
		dir: repo,
		target: "/tmp/y",
		branch: "b",
	});
	assert.equal(worktreeAdd(["git", "worktree", "add", "--", "-odd"], repo)?.target, "/ws/products/app/-odd");
	assert.equal(worktreeAdd(["git", "worktree", "add", "~/w"], repo)?.target, `${os.homedir()}/w`);
	assert.equal(worktreeAdd(["git", "-C", "/ws", "-C", "products/app", "worktree", "add", "x"], "/")?.dir, repo);
	assert.equal(worktreeAdd(["git", "worktree", "list"], repo), null);
	assert.equal(worktreeAdd(["git", "worktree", "add", "-b", "x"], repo), null);
});

test("scanCommand tracks cd before worktree add", () => {
	const { adds } = scanCommand(`cd /ws/products/app && git worktree add "../app-feat" -b feat`, "/");
	assert.deepEqual(adds, [{ dir: repo, target: "/ws/products/app-feat", branch: "feat" }]);
});

test("mirroredRoot mirrors repos inside the workspace only", () => {
	assert.equal(mirroredRoot("/ws/products/app/.git", central), mirror);
	assert.equal(mirroredRoot("/elsewhere/app/.git", central), null);
	assert.equal(mirroredRoot("/ws/products/app.git", central), null); // bare
	assert.equal(mirroredRoot("/ws/.git", central), null); // workspace itself
	assert.equal(mirroredRoot("/ws/..app/.git", central), "/ws/.worktrees/..app");
});

test("locationViolation allows the mirrored folder and suggests the branch path otherwise", () => {
	assert.equal(locationViolation({ dir: repo, target: `${mirror}/feat-a` }, mirror), null);
	assert.equal(locationViolation({ dir: repo, target: `${mirror}/x/y` }, mirror), null);
	const reason = locationViolation({ dir: repo, target: "/ws/products/app-a", branch: "feat/a" }, mirror);
	assert.match(reason ?? "", /path replaced by \/ws\/\.worktrees\/products\/app\/feat-a$/);
	assert.notEqual(locationViolation({ dir: repo, target: mirror }, mirror), null);
	assert.notEqual(locationViolation({ dir: repo, target: `${mirror}-evil/x` }, mirror), null);
});
