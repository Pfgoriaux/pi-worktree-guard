/**
 * Worktree Guard — keep concurrent pi sessions from running each other over.
 *
 * The incident this exists for: two pi agents shared one checkout of a repo.
 * The second, needing a different branch, ran `git stash` + `git checkout
 * <branch>` — silently parking the first agent's 23 uncommitted paths in the
 * stash pile with only a polite note pointing at it.
 *
 * Policy enforced: ONE BRANCH = ONE WORKTREE = ONE AGENT.
 *
 * How it works:
 *   1. CLAIM — each pi session writes a claim file under
 *      `<repo>/.git/pi-agent-claims/<host>-<pid>.json` when its session cwd
 *      is a repo's MAIN checkout (linked worktrees never claim — they can't
 *      collide). The claim is heartbeat-refreshed while pi runs and deleted
 *      on session shutdown; a claim is considered live while its pid is alive
 *      and its heartbeat is fresh (`STALE_MS`).
 *   2. BLOCK — when a bash tool call would run a git op that moves HEAD or
 *      hides/destroys work (`git stash`, `git checkout`, `git switch`,
 *      `git reset --hard`, `git clean -f…`) against a MAIN checkout that
 *      another live pi session currently claims, the call is blocked with a
 *      reason telling the agent how to proceed (use its own worktree / ask
 *      the user).
 *   3. LOCATION — `git worktree add <path>` for a repo inside the workspace
 *      (the parent of `PI_WORKTREE_ROOT`, default `~/eden/.worktrees`) is
 *      blocked unless <path> sits under the repo's mirrored folder, e.g.
 *      `~/eden/products/app` -> `~/eden/.worktrees/products/app/<branch>`.
 *      This applies to every session, claimed or not.
 *
 * Not blocked, by design:
 *   - mutating ops inside a linked worktree
 *   - anything in a repo no other live session claims (single-agent flow)
 *   - `git stash list` / `git stash show` (read-only)
 *   - commands outside a git repository (git itself will error)
 *
 * Escape hatch (human, not agent): relaunch pi with `PI_WORKTREE_GUARD=0`.
 *
 * Failure mode is fail-closed for weird command shapes: an indirect
 * invocation (sh -c '…git stash…', xargs git …) in a claimed checkout is
 * blocked; a plain invocation the scanner misreads falls through to git's
 * own errors.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CLAIMS_DIR_NAME = "pi-agent-claims";
const HEARTBEAT_MS = 30_000;
const STALE_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 5_000;

/** `git stash` subcommands that mutate. Bare `git stash` = push ("" entry). */
const STASH_WRITE_SUBCOMMANDS = new Set([
	"",
	"push",
	"pop",
	"apply",
	"drop",
	"clear",
	"store",
	"save",
	"create",
	"branch",
]);

/** Global git flags that consume a separate value token. */
const GIT_FLAG_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

/** Interpreters/wrappers that hide a nested git invocation. */
const INDIRECT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ssh", "xargs"]);

/** `git worktree add` options that consume a separate value token. */
const WORKTREE_ADD_FLAG_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/** Cheap pre-filter regexes (used only for the indirect path). */
const MUTATION_HINT_RE = /\b(?:checkout|switch|stash|reset|clean)\b/;

// ---------------------------------------------------------------------------
// Shell scanning — best-effort, quote-aware
// ---------------------------------------------------------------------------

interface MutationHit {
	op: string;
	dir: string;
}

/**
 * Split a shell string on `&&`, `||`, `;`, `|`, `&` and newlines, ignoring
 * separators inside single or double quotes.
 */
function splitShell(command: string): string[] {
	const segments: string[] = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (c === "\\") {
			buf += c;
			if (i + 1 < command.length) {
				buf += command[i + 1];
				i++;
			}
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble) {
			const two = command.slice(i, i + 2);
			if (two === "&&" || two === "||") {
				segments.push(buf);
				buf = "";
				i++;
				continue;
			}
			if (c === ";" || c === "\n" || c === "|" || c === "&") {
				segments.push(buf);
				buf = "";
				continue;
			}
		}
		buf += c;
	}
	segments.push(buf);
	return segments.filter((s) => s.trim().length > 0);
}

function unquote(token: string): string {
	return token.replace(/^["']|["']$/g, "");
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

interface GitCall {
	dir: string;
	op: string | undefined;
	args: string[];
}

/** Split a git argv into the directory it runs in, the subcommand and its args. */
function parseGit(argv: string[], cwd: string): GitCall | null {
	// argv[0] === "git"
	const rest = argv.slice(1);
	let dir = cwd;
	let i = 0;
	while (i < rest.length) {
		const t = rest[i];
		if (t === "-C") {
			if (i + 1 >= rest.length) return null; // malformed — git errors on its own
			dir = path.resolve(dir, expandHome(unquote(rest[i + 1])));
			i += 2;
			continue;
		}
		if (GIT_FLAG_WITH_VALUE.has(t)) {
			i += 2;
			continue;
		}
		if (t.startsWith("-")) {
			i++;
			continue;
		}
		break;
	}
	return { dir, op: rest[i], args: rest.slice(i + 1) };
}

/**
 * Does this git argv mutate HEAD or hide/destroy work? Returns a description
 * of the op and the directory it targets (honouring `git -C <path>`).
 */
function gitMutation(argv: string[], cwd: string): MutationHit | null {
	const call = parseGit(argv, cwd);
	if (!call) return null;
	const { dir, op, args } = call;
	switch (op) {
		case "stash": {
			const sub = args[0] ?? "";
			if (STASH_WRITE_SUBCOMMANDS.has(sub)) {
				return { op: sub ? `stash ${sub}` : "stash", dir };
			}
			return null; // list / show: read-only
		}
		case "checkout":
		case "switch":
			// Strict by policy: branch moves, checkouts and even path restores
			// (which discard the other agent's edits) are blocked in a shared
			// checkout. Restore deliberately in your own worktree instead.
			return { op, dir };
		case "reset":
			return args.some((a) => a === "--hard") ? { op: "reset --hard", dir } : null;
		case "clean":
			return args.some((a) => a.startsWith("-") && a.includes("f")) ? { op: "clean -f", dir } : null;
		default:
			return null;
	}
}

export interface WorktreeAdd {
	/** Directory git runs in. */
	dir: string;
	/** Absolute path of the new worktree. */
	target: string;
	/** Branch named by `-b`/`-B`, if any. */
	branch?: string;
}

/** Parse `git [-C dir] worktree add [opts] <path> [<commit-ish>]`. */
export function worktreeAdd(argv: string[], cwd: string): WorktreeAdd | null {
	const call = parseGit(argv, cwd);
	if (call?.op !== "worktree" || call.args[0] !== "add") return null;
	// Git permutes options, so `-b <branch>` may follow the path.
	const args = call.args.slice(1).map(unquote);
	const positional: string[] = [];
	let branch: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const t = args[i];
		if (t === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (WORKTREE_ADD_FLAG_WITH_VALUE.has(t)) {
			if (t !== "--reason") branch = args[i + 1];
			i++;
		} else if (!t.startsWith("-")) {
			positional.push(t);
		}
	}
	if (positional.length === 0) return null;
	return { dir: call.dir, target: path.resolve(call.dir, expandHome(positional[0])), branch };
}

/** Central worktree folder. Its parent directory is the workspace. */
function centralRoot(): string {
	return process.env.PI_WORKTREE_ROOT ?? path.join(os.homedir(), "eden", ".worktrees");
}

/**
 * Mirrored worktree folder for the repo whose common git dir is `commonDir`,
 * or null when the repo is bare or outside the workspace.
 */
export function mirroredRoot(commonDir: string, central: string = centralRoot()): string | null {
	if (path.basename(commonDir) !== ".git") return null;
	const rel = path.relative(path.dirname(central), path.dirname(commonDir));
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
	return path.join(central, rel);
}

/** Branch name as a single directory name. */
function branchDir(branch: string): string {
	return branch.replaceAll("/", "-");
}

/** Common env options are transparent; unknown forms stay on the indirect path. */
function unwrapEnv(argv: string[], cwd: string): { argv: string[]; cwd: string } | null {
	let i = 1;
	let options = true;
	while (i < argv.length) {
		const token = argv[i++];
		if (/^[A-Za-z_]\w*=/.test(token)) continue;
		if (!options) return { argv: argv.slice(i - 1), cwd };
		if (token === "--") {
			options = false;
			continue;
		}
		if (["-", "-i", "--ignore-environment"].includes(token)) continue;
		if (token.startsWith("--unset=")) continue;
		if (token === "-u" || token === "--unset") {
			if (!argv[i]) return null;
			i++;
			continue;
		}
		if (token.startsWith("--chdir=")) {
			cwd = path.resolve(cwd, expandHome(token.slice("--chdir=".length)));
			continue;
		}
		if (token === "-C" || token === "--chdir") {
			if (!argv[i]) return null;
			cwd = path.resolve(cwd, expandHome(argv[i++]));
			continue;
		}
		if (token.startsWith("-")) return null;
		return { argv: argv.slice(i - 1), cwd };
	}
	return { argv: [], cwd };
}

function unwrapEnvs(argv: string[], cwd: string): { argv: string[]; cwd: string } | null {
	while (path.basename(argv[0] ?? "") === "env") {
		const command = unwrapEnv(argv, cwd);
		if (!command) return null;
		({ argv, cwd } = command);
	}
	return { argv, cwd };
}

/** Block reason when `add.target` is outside `mirror`, else null. */
export function locationViolation(add: WorktreeAdd, mirror: string): string | null {
	if (add.target.startsWith(mirror + path.sep)) return null;
	const dest = path.join(mirror, branchDir(add.branch ?? path.basename(add.target)));
	return [
		`pi-worktree-guard blocked \`git worktree add\` to ${add.target}.`,
		`Worktrees for this repo go under ${mirror}/, one directory per branch with "/" replaced by "-".`,
		`Rerun the same command with the worktree path replaced by ${dest}`,
	].join("\n");
}

/**
 * Walk the command left-to-right, tracking `cd`/`pushd`, and collect every
 * mutating git op and every `git worktree add`, with the directory each
 * would run in.
 *
 * `indirect` is true when the command shells out through an interpreter or
 * wrapper AND the raw string mentions a mutating-looking git op — fail-closed
 * for nested invocations we cannot parse.
 */
export function scanCommand(
	command: string,
	baseDir: string,
): { hits: MutationHit[]; adds: WorktreeAdd[]; indirect: boolean } {
	let cwd = baseDir;
	const hits: MutationHit[] = [];
	const adds: WorktreeAdd[] = [];
	let indirect = false;
	for (const segment of splitShell(command)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (
			i < tokens.length &&
			(/^[\w-]+=/.test(tokens[i]) || (i === 0 && ["sudo", "command", "exec", "nice"].includes(tokens[i])))
		) {
			i++;
		}
		const unwrapped = unwrapEnvs(tokens.slice(i), cwd);
		if (!unwrapped) {
			indirect ||= MUTATION_HINT_RE.test(command);
			continue;
		}
		const { argv, cwd: commandCwd } = unwrapped;
		const head = argv[0];
		if (head === "cd" || head === "pushd") {
			if (path.basename(tokens[i] ?? "") === "env") continue;
			const target = argv.slice(1).find((t) => !t.startsWith("-"));
			if (target) {
				cwd = path.resolve(cwd, expandHome(unquote(target)));
			}
			continue;
		}
		if (head === "git") {
			const hit = gitMutation(argv, commandCwd);
			if (hit) hits.push(hit);
			const add = worktreeAdd(argv, commandCwd);
			if (add) adds.push(add);
			continue;
		}
		if (head !== undefined && INDIRECT_SHELLS.has(head) && MUTATION_HINT_RE.test(command)) {
			indirect = true;
		}
	}
	return { hits, adds, indirect };
}

// ---------------------------------------------------------------------------
// Repo introspection & claims
// ---------------------------------------------------------------------------

interface RepoInfo {
	toplevel: string;
	gitDir: string;
	commonDir: string;
	isMainCheckout: boolean;
}

async function repoInfo(pi: ExtensionAPI, dir: string): Promise<RepoInfo | null> {
	const r = await pi.exec(
		"git",
		["-C", dir, "rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"],
		{ timeout: GIT_TIMEOUT_MS },
	);
	if (r.code !== 0) return null; // not a repo
	const lines = r.stdout.trim().split("\n");
	if (lines.length < 3) return null;
	// From a subdirectory git prints --git-dir absolute but --git-common-dir
	// relative, and symlinks (/tmp -> /private/tmp) would make equal dirs
	// compare unequal — normalize through realpath so the worktree test and
	// the claim key (commonDir) are stable regardless of how we got here.
	const norm = (value: string): string => {
		const abs = path.resolve(dir, value);
		try {
			return fs.realpathSync(abs);
		} catch {
			return abs;
		}
	};
	const gitDir = norm(lines[0]);
	const commonDir = norm(lines[1]);
	const toplevel = norm(lines[2]);
	return { toplevel, gitDir, commonDir, isMainCheckout: gitDir === commonDir };
}

interface Claim {
	host: string;
	pid: number;
	branch: string;
	startedAt: number;
	lastBeat: number;
}

interface MyClaim {
	file: string;
	branch: string;
	startedAt: number;
}

const myClaims = new Map<string, MyClaim>(); // commonDir -> claim
let beatTimer: NodeJS.Timeout | null = null;

function claimsDir(commonDir: string): string {
	return path.join(commonDir, CLAIMS_DIR_NAME);
}

function writeClaim(file: string, claim: Claim): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(claim, null, "\t")}\n`);
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function beat(claim: MyClaim): void {
	// A live session can recover a stale claim removed by a rival after sleep.
	// Shutdown clears the timer and myClaims, so it cannot recreate a claim.
	if (!fs.existsSync(path.dirname(claim.file))) return;
	const c: Claim = {
		host: os.hostname(),
		pid: process.pid,
		branch: claim.branch,
		startedAt: claim.startedAt,
		lastBeat: Date.now(),
	};
	try {
		writeClaim(claim.file, c);
	} catch {
		// Another process cleaned our claim dir mid-removal; next beat is fine.
	}
}

async function ensureClaim(pi: ExtensionAPI, info: RepoInfo): Promise<void> {
	if (myClaims.has(info.commonDir)) return;
	const b = await pi.exec("git", ["-C", info.toplevel, "rev-parse", "--abbrev-ref", "HEAD"], {
		timeout: GIT_TIMEOUT_MS,
	});
	const branch = b.code === 0 ? b.stdout.trim() : "detached-or-unknown";
	const file = path.join(claimsDir(info.commonDir), `${os.hostname()}-${process.pid}.json`);
	const now = Date.now();
	writeClaim(file, { host: os.hostname(), pid: process.pid, branch, startedAt: now, lastBeat: now });
	myClaims.set(info.commonDir, { file, branch, startedAt: now });
	if (beatTimer === null) {
		beatTimer = setInterval(() => {
			for (const claim of myClaims.values()) beat(claim);
		}, HEARTBEAT_MS);
		beatTimer.unref();
	}
}

/** Live = same-host pid alive (or cross-host fresh heartbeat) AND fresh beat. */
function liveRivals(commonDir: string): Claim[] {
	const dir = claimsDir(commonDir);
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const rivals: Claim[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let claim: Claim;
		try {
			claim = JSON.parse(fs.readFileSync(file, "utf8")) as Claim;
		} catch {
			continue; // corrupt file — another still-live session may rewrite it
		}
		if (claim.host === os.hostname() && claim.pid === process.pid) {
			continue; // mine (this or a previous session in this process)
		}
		const fresh = Date.now() - claim.lastBeat < STALE_MS;
		let alive = false;
		if (claim.host === os.hostname()) {
			try {
				process.kill(claim.pid, 0);
				alive = true;
			} catch (err) {
				// EPERM = exists but not ours; ESRCH = gone.
				alive = (err as NodeJS.ErrnoException)?.code === "EPERM";
			}
		}
		if (alive && fresh && claim.branch !== undefined) {
			rivals.push(claim);
		} else if (!alive || !fresh) {
			// Stale claim from a dead or foreign-silent session: clean it up.
			try {
				fs.rmSync(file);
			} catch {
				// lost the race against the other session — fine
			}
		}
	}
	return rivals;
}

function releaseClaims(): void {
	for (const claim of myClaims.values()) {
		try {
			fs.rmSync(claim.file);
		} catch {
			// already gone
		}
	}
	myClaims.clear();
	if (beatTimer !== null) {
		clearInterval(beatTimer);
		beatTimer = null;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function blockReason(op: string, info: RepoInfo, rival: Claim): string {
	const toplevel = info.toplevel;
	const mirror = mirroredRoot(info.commonDir);
	const addCmd = mirror
		? `git worktree add ${mirror}/<branch with "/" replaced by "-"> -b <branch>`
		: "git worktree add ../<name> -b <branch>";
	return [
		`pi-worktree-guard blocked \`${op}\` on the shared main checkout of ${toplevel}.`,
		`Another live pi session holds it: pid ${rival.pid} on ${rival.host}, branch "${rival.branch}".`,
		"Policy: one branch = one worktree = one agent. That session's uncommitted work lives here — do NOT stash, checkout, reset --hard or clean this checkout.",
		"Options:",
		`  1. Do the work in your own checkout: \`${addCmd}\`, then cd into it.`,
		"  2. Ask the user to park or commit the other session's work first.",
		"  3. Human override only: pi must be relaunched with PI_WORKTREE_GUARD=0 — you cannot disable the guard yourself.",
	].join("\n");
}

/** Block reason for the first `git worktree add` outside its mirrored folder. */
async function firstMisplacedAdd(pi: ExtensionAPI, adds: WorktreeAdd[]): Promise<string | null> {
	for (const add of adds) {
		const info = await repoInfo(pi, add.dir);
		const mirror = info && mirroredRoot(info.commonDir);
		const reason = mirror && locationViolation(add, mirror);
		if (reason) return reason;
	}
	return null;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => {
		releaseClaims();
	});

	// Claim the launch directory's main checkout proactively, so a quiet
	// session is visible to others before it runs any git command itself.
	void (async () => {
		try {
			const info = await repoInfo(pi, process.cwd());
			if (info?.isMainCheckout) {
				await ensureClaim(pi, info);
			}
		} catch {
			// never let guard bookkeeping break a session
		}
	})();

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (process.env.PI_WORKTREE_GUARD === "0") return undefined;
			if (event.toolName !== "bash") return undefined;
			const command = event.input?.command;
			if (typeof command !== "string" || command.length === 0) return undefined;

			const baseDir = ctx.cwd ?? process.cwd();
			const { hits, adds, indirect } = scanCommand(command, baseDir);
			// A failed location probe must not skip the claim checks below.
			const misplaced = await firstMisplacedAdd(pi, adds).catch(() => null);
			if (misplaced) return { block: true, reason: misplaced };
			if (hits.length === 0 && !indirect) return undefined;

			const targets: MutationHit[] = [...hits];
			if (indirect) targets.push({ op: "git (indirect nested invocation)", dir: baseDir });

			for (const target of targets) {
				const info = await repoInfo(pi, target.dir);
				if (!info) continue; // not a repo — git will error on its own
				if (!info.isMainCheckout) continue; // linked worktree or clone: safe by construction
				await ensureClaim(pi, info); // make sure we count ourselves
				const rivals = liveRivals(info.commonDir);
				if (rivals.length === 0) continue; // we are alone: nothing to protect

				const rival = rivals[0];
				if (ctx.hasUI) {
					ctx.ui.notify(
						`worktree-guard: blocked \`${target.op}\` — checkout of ${path.basename(info.toplevel)} is held by another session (branch ${rival.branch}).`,
						"warn",
					);
				}
				return { block: true, reason: blockReason(target.op, info, rival) };
			}
			return undefined;
		} catch {
			// Guard bookkeeping must never kill a tool call.
			return undefined;
		}
	});
}
