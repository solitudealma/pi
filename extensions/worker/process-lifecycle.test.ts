import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_OPTIONS } from "./config.ts";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireSlot, beginWorkerShutdown, createWorkerOwner, executeTask, runPiWorker, type WorkerOwner } from "./process.ts";
import { until } from "./fixtures/helpers.ts";
import type { ChildProgress, Route, RoutingConfig, WorkerTask } from "./types.ts";

const route: Route = { requestedPreset: "fast", resolvedPreset: "fast", modelId: "fixture/local", provider: "fixture", thinking: "high", routeReason: [] };
const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
const launch = (owner: WorkerOwner, scenario: string, signal?: AbortSignal, timeout = 10_000, progress?: (progress: ChildProgress) => void) => runPiWorker(
	{ mode: "scout", objective: "fixture", sessionMode: "new" }, route, process.cwd(), "fixture", "fixture", signal, timeout, 1, progress,
	{ owner, invocation: { command: process.execPath, args: ["--experimental-transform-types", fixture, scenario] } },
);

test("owner shutdown rejects only its own waiters and slot releases are idempotent", async () => {
	const a = createWorkerOwner(), b = createWorkerOwner();
	const releaseA = await acquireSlot(1, undefined, 1_000, a);
	const releaseB = await acquireSlot(1, undefined, 1_000, b);
	const waitA = assert.rejects(acquireSlot(1, undefined, 1_000, a), /取消/);
	beginWorkerShutdown(a); beginWorkerShutdown(a);
	await waitA;
	assert.equal(a.waiters.length, 0); assert.equal(b.closed, false); assert.equal(b.slots, 1);
	releaseA(); releaseA(); releaseB(); releaseB();
	assert.equal(a.slots, 0); assert.equal(b.slots, 0);
});

test("standalone timeout and pre-spawn task timeout retain explicit sources without claiming parent death", async () => {
	const owner = createWorkerOwner();
	const timeout = await launch(owner, "hang", undefined, 200);
	assert.equal(timeout.timedOut, true); assert.equal(timeout.aborted, false);
	assert.equal(timeout.termination?.source, "timeout");
	const controller = new AbortController();
	controller.abort(Object.assign(new Error("Worker 任务超时"), { source: "task_timeout" }));
	const early = await launch(owner, "done", controller.signal);
	assert.equal(early.timedOut, true); assert.equal(early.aborted, false);
	assert.equal(early.termination?.source, "task_timeout");
	assert.equal(owner.children.size, 0); assert.equal(owner.slots, 0);
});

test("raw onProgress throws throughout cancellation cannot suppress SIGKILL escalation or settlement", { timeout: 8_000 }, async () => {
	const owner = createWorkerOwner();
	const controller = new AbortController();
	const phases: string[] = [];
	let ready = false;
	const work = launch(owner, "stubborn", controller.signal, 10_000, (progress) => {
		ready ||= progress.activities.some((activity) => activity.id === "tool:fixture-ready");
		phases.push(progress.phase);
		throw new Error("fixture raw progress failure");
	});
	try {
		await until(() => ready);
		controller.abort();
		const result = await work;
		assert.equal(result.aborted, true);
		assert.ok(phases.includes("正在取消"));
		assert.ok(phases.includes("已取消"));
		assert.equal(owner.children.size, 0);
		assert.equal(owner.slots, 0);
		assert.doesNotMatch(result.errorMessage!, /FORCE_SETTLE/);
	} finally { beginWorkerShutdown(owner); }
});

test("SIGTERM resistance and suppressed close reach bounded strong settlement; delayed close cannot settle twice", { timeout: 10_000 }, async () => {
	const owner = createWorkerOwner();
	const controller = new AbortController();
	let settled = 0;
	let ready = false;
	const work = launch(owner, "stubborn", controller.signal, 10_000, (progress) => { ready ||= progress.activities.some((activity) => activity.id === "tool:fixture-ready"); }).then((result) => { settled++; return result; });
	await until(() => owner.children.size === 1);
	const child = [...owner.children][0];
	assert.equal(child.stdio.length, 3, "worker uses only stdin/stdout/stderr");
	const originalEmit = child.emit;
	let delayedClose: any[] | undefined;
	child.emit = function (event: string | symbol, ...args: any[]) {
		if (event === "close") { delayedClose = args; return true; }
		return originalEmit.call(this, event, ...args);
	};
	try {
		await until(() => ready);
		controller.abort();
		const result = await work;
		assert.equal(result.exitCode, 1); assert.equal(result.aborted, true);
		assert.equal(result.termination?.source, "abort_signal");
		assert.match(result.errorMessage!, /cleanup=FORCE_SETTLE_NO_CLOSE/);
		assert.equal(settled, 1); assert.equal(owner.slots, 0);
		assert.equal(delayedClose?.[1], "SIGKILL", "SIGKILL closed the resistant child even when the event was hidden");
		assert.equal(owner.children.size, 1, "unconfirmed close remains tracked for the exit fallback");
		originalEmit.call(child, "close", ...delayedClose!);
		assert.equal(owner.children.size, 0);
		assert.equal(owner.stops.size, 0);
		assert.equal(settled, 1);
	} finally {
		child.emit = originalEmit;
		if (delayedClose) originalEmit.call(child, "close", ...delayedClose);
		beginWorkerShutdown(owner);
	}
});

test("preflight failures preserve category, routing metadata and result shape without launching a worker", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "worker-preflight-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const task: WorkerTask = { mode: "scout", objective: "inspect", preset: "fast" };
	const preset = { model: "fixture/model", thinking: "high" as const };
	const config: RoutingConfig = { ...DEFAULT_OPTIONS, fast: preset, normal: preset, deep: preset };
	for (const available of [false, true]) {
		const ctx = { cwd, sessionManager: { getBranch: () => [] }, modelRegistry: { getAvailable: () => available ? [{ provider: "fixture", id: "model", reasoning: true }] : [] } } as any;
		const result = await executeTask(task, config, ["warning"], ctx, undefined);
		assert.equal(result.status, "blocked");
		assert.equal(result.failure.category, available ? "workspace_snapshot" : "route_or_contract");
		assert.equal(result.failure.retryable, false);
		assert.deepEqual(result.summary, [result.failure.reason]);
		assert.deepEqual(result.recommended_next_action, [result.failure.next_action]);
		assert.equal(result.execution.attempt, 0);
		assert.equal(result.execution.requested_preset, "fast");
		assert.equal(result.execution.resolved_preset, available ? "fast" : null);
		assert.equal(result.execution.resolved_model_id, available ? "fixture/model" : null);
		assert.deepEqual(result.execution.warnings, ["warning"]);
		for (const key of ["changed_files", "observed_changed_files", "validation", "acceptance", "findings", "risks", "out_of_scope"]) {
			assert.deepEqual(result[key], [], key);
		}
	}
});
