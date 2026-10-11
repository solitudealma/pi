import assert from "node:assert/strict";
import test from "node:test";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "./fixtures/helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/parent.mjs", import.meta.url));
const task = (objective = "hang") => ({ tasks: [{ mode: "scout", preset: "normal", sessionMode: "fork", objective }] });
function workspace() {
	const cwd = mkdtempSync(join(tmpdir(), "worker-isolation-"));
	execFileSync("git", ["init", "--quiet", cwd]);
	return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}
async function parent(cwd: string) {
	const child = fork(fixture, [], { cwd, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let errors = "";
	child.stderr!.on("data", (chunk) => { errors += chunk; });
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	let count = 0;
	let ready!: () => void;
	const started = new Promise<void>((resolve) => { ready = resolve; });
	child.on("message", (message: any) => {
		if (message.ready) { ready(); return; }
		const request = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
	});
	child.stdout!.resume();
	const closed = once(child, "exit");
	child.on("exit", () => { for (const request of pending.values()) request.reject(new Error(`fixture exited: ${errors}`)); pending.clear(); });
	const call = (op: string, data: Record<string, any> = {}): Promise<any> => new Promise((resolve, reject) => {
		const id = String(++count);
		pending.set(id, { resolve, reject });
		child.send({ id, op, ...data });
	});
	await Promise.race([started, closed.then(() => { throw new Error(`fixture startup failed: ${errors}`); })]);
	return { call, child, closed, dispose: async () => { if (child.connected) child.disconnect(); await closed; } };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitReady(p: Awaited<ReturnType<typeof parent>>, count = 1) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if ((await p.call("stats")).owners.filter((owner: any) => owner.ready).length >= count) return;
		await delay(10);
	}
	throw new Error("fixture child did not become ready");
}
function processRunning(pid: number) {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") return !/^[ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]);
		return true;
	} catch { return false; }
}
function assertReleased(stats: any) {
	assert.equal(stats.owners.length, 0);
	assert.ok(stats.retained.every((owner: any) => owner.slots === 0 && owner.children === 0), "all process slots released");
	assert.ok(stats.runtimes.every((runtime: any) => runtime.active === 0 && runtime.queued === 0), "runtime active/path locks released");
}


test("real loader instances isolate slots, shutdown and subsequent work", { timeout: 30_000 }, async (t) => {
	const repo = workspace(); const p = await parent(repo.cwd);
	try {
		await p.call("load", { session: "a" }); await p.call("load", { session: "b" });
		const workB = p.call("call", { session: "b", input: task() });
		await waitReady(p);
		const before = await p.call("stats");
		t.diagnostic(`Pi loader version: ${before.piVersion}`);
		assert.equal(before.modules, 1);
		await p.call("shutdown", { session: "a" });
		assert.deepEqual((await p.call("stats")).owners, before.owners);
		await p.call("restart", { session: "a" });
		const workA = p.call("call", { session: "a", input: task() });
		await waitReady(p, 2);
		assert.equal((await p.call("stats")).owners.length, 2);
		await p.call("shutdown", { session: "a" });
		assert.equal((await workA).result.results[0].execution.termination.source, "session_shutdown");
		assert.equal((await p.call("stats")).owners.length, 1);
		await p.call("shutdown", { session: "b" });
		assert.equal((await workB).result.results[0].execution.cancelled, true);
		assertReleased(await p.call("stats"));
		await p.call("restart", { session: "a" });
		assert.equal((await p.call("call", { session: "a", input: task("done") })).result.results[0].status, "completed");
	} finally { await p.dispose(); repo.dispose(); }
});

test("two OS parents in the same cwd isolate process groups and lifecycle", { timeout: 30_000 }, async () => {
	const repo = workspace(); const a = await parent(repo.cwd), b = await parent(repo.cwd);
	try {
		await Promise.all([a.call("load"), b.call("load")]);
		const workA = a.call("call", { input: task() }), workB = b.call("call", { input: task() });
		await Promise.all([waitReady(a), waitReady(b)]);
		const before = await b.call("stats");
		await a.call("shutdown");
		assert.equal((await workA).result.results[0].execution.cancelled, true);
		assert.deepEqual((await b.call("stats")).owners, before.owners);
		await b.call("shutdown");
		assert.equal((await workB).result.results[0].execution.cancelled, true);
		assertReleased(await a.call("stats")); assertReleased(await b.call("stats"));
	} finally { await a.dispose(); await b.dispose(); repo.dispose(); }
});

test("exit fallback spans loader generations without cancelling fresh sessions on old shutdown", { timeout: 30_000 }, async () => {
	const repo = workspace(); const p = await parent(repo.cwd);
	try {
		await p.call("load", { session: "old" });
		const old = p.call("call", { session: "old", input: task() });
		await waitReady(p);
		await p.call("load", { session: "new", reload: true });
		const fresh = p.call("call", { session: "new", input: task() });
		await waitReady(p, 2);
		assert.equal((await p.call("stats")).modules, 2);
		await p.call("shutdown", { session: "old" });
		assert.equal((await old).result.results[0].execution.cancelled, true);
		assert.equal((await p.call("stats")).owners.length, 1);
		await p.call("exit-hooks");
		assert.notEqual((await fresh).result.results[0].status, "completed");
		assertReleased(await p.call("stats"));
	} finally { await p.dispose(); repo.dispose(); }
});

test("model-free child returns blocked without interaction and next batch can run", { timeout: 15_000 }, async () => {
	const repo = workspace(); const p = await parent(repo.cwd);
	try {
		await p.call("load");
		const result = await p.call("call", { input: task("blocked") });
		assert.equal(result.finished, true);
		assert.equal(result.result.results[0].status, "blocked");
		assert.equal(result.result.results[0].failure.category, "worker_blocked");
		assertReleased(await p.call("stats"));
		assert.equal((await p.call("call", { input: task("done") })).result.results[0].status, "completed");
	} finally { await p.dispose(); repo.dispose(); }
});

test("cancel retains original PGID, slot and runtime lock after leader closes until resistant grandchild is killed", { timeout: 20_000, skip: process.platform !== "linux" }, async (t) => {
	const repo = workspace(); const p = await parent(repo.cwd);
	let group: { leader: number; grandchild: number } | undefined;
	try {
		await p.call("load");
		const work = p.call("call", { input: { tasks: [{ mode: "fix", preset: "normal", sessionMode: "fork", objective: "group-stubborn", allowedPaths: ["fixture-group.json"] }] } });
		void work.catch(() => {});
		await waitReady(p);
		group = JSON.parse(readFileSync(join(repo.cwd, "fixture-group.json"), "utf8"));
		const stat = readFileSync(`/proc/${group!.grandchild}/stat`, "utf8").split(") ")[1].split(" ");
		assert.equal(Number(stat[2]), group!.leader, "grandchild shares fixture leader PGID");
		let settled = false;
		const started = Date.now();
		const shutdown = p.call("shutdown").then(() => { settled = true; });
		void shutdown.catch(() => {});
		await until(() => !processRunning(group!.leader), 1_500);
		await delay(200);
		assert.equal(processRunning(group!.grandchild), true, "grandchild resists SIGTERM after direct close");
		assert.equal(settled, false);
		const during = await p.call("stats");
		assert.deepEqual(during.owners[0].pids, [group!.leader], "original PGID remains exit-registered");
		assert.equal(during.owners[0].slots, 1);
		assert.equal(during.runtimes[0].active, 1, "write task retains its runtime path lock");
		await shutdown;
		const result = await work;
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 2_900 && elapsed < 5_500, `original three-second escalation remains bounded: ${elapsed}ms`);
		assert.equal(result.result.results[0].execution.cancelled, true);
		assert.equal(processRunning(group!.grandchild), false);
		assertReleased(await p.call("stats"));
		t.diagnostic(`leader closed early; resistant same-PGID grandchild stopped; cleanup ${elapsed}ms`);
	} finally {
		// Exact fixture PGID only, even when the lifecycle assertion fails.
		if (group) { try { process.kill(-group.leader, "SIGKILL"); } catch {} }
		await p.dispose(); repo.dispose();
	}
});

for (const scenario of [
	{ name: "final onUpdate", update: "子进程已完成" },
	{ name: "intermediate onUpdate and usage", update: "all", usage: true },
	{ name: "final onProgress", progress: "子进程已完成" },
	{ name: "terminating onUpdate", update: "正在取消", cancel: true },
	{ name: "terminating onProgress", progress: "正在取消", cancel: true },
]) test(`real loader isolates throwing ${scenario.name} and releases lifecycle resources`, { timeout: 15_000 }, async (t) => {
	const repo = workspace(); const p = await parent(repo.cwd);
	try {
		await p.call("load");
		await p.call("presentation", { usage: scenario.usage, progress: scenario.progress });
		const work = p.call("call", { input: task(scenario.cancel ? "hang" : "done"), throwUpdate: scenario.update });
		void work.catch(() => {});
		let started = Date.now();
		if (scenario.cancel) {
			await waitReady(p);
			started = Date.now();
			await p.call("shutdown");
		}
		const result = await work;
		const elapsed = Date.now() - started;
		assert.equal(result.finished, true);
		assert.equal(result.result.results[0].status, scenario.cancel ? "failed" : "completed");
		if (scenario.cancel) assert.equal(result.result.results[0].execution.cancelled, true);
		assert.ok(elapsed < 2_500, `no unnecessary three-second grace: ${elapsed}ms`);
		const stats = await p.call("stats");
		if (scenario.update) assert.ok(stats.updates.includes(scenario.update === "all" ? "子进程已完成" : scenario.update), "target onUpdate actually threw");
		if (scenario.progress) assert.ok(stats.progressThrows > 0, "target onProgress actually threw");
		if (scenario.usage) assert.ok(stats.usageThrows > 0, "usage callback actually threw");
		assertReleased(stats);
		await p.call("shutdown");
		await p.call("restart");
		await p.call("presentation");
		assert.equal((await p.call("call", { input: task("done") })).result.results[0].status, "completed");
		assertReleased(await p.call("stats"));
		t.diagnostic(`${scenario.name}: settled and shutdown completed (${elapsed}ms), subsequent work completed`);
	} finally { await p.dispose(); repo.dispose(); }
});
