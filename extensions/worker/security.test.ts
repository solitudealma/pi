import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attributeChangedFiles,
	declaredWriteBoundary,
	filterChangedFilesToBoundary,
	workerTaskScopesConflict,
} from "./security.ts";
import type { WorkerTask } from "./types.ts";
import { validateWorkerWritePath } from "./guard.ts";

const workerTasksConflict = (left: WorkerTask, right: WorkerTask, cwd: string) => workerTaskScopesConflict(left, cwd, right, cwd);

const readTask = (cwd?: string): WorkerTask => ({ mode: "scout", objective: "read", cwd });
const writeTask = (allowedPaths: string[], cwd?: string): WorkerTask => ({ mode: "implement", objective: "write", allowedPaths, cwd });

async function workspace(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "worker-security-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("read/read is concurrent while read/write is exclusive", async (t) => {
	const root = await workspace(t);
	assert.equal(workerTasksConflict(readTask(), readTask(), root), false);
	assert.equal(workerTasksConflict(readTask(), writeTask(["a.ts"]), root), true);
});

test("directory literals are exact while explicit globs describe subtrees", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "src", "left"), { recursive: true });
	await mkdir(join(root, "src", "right"), { recursive: true });
	await writeFile(join(root, "src", "left.ts"), "");
	await writeFile(join(root, "src", "right.ts"), "");

	assert.equal(workerTasksConflict(writeTask(["src/left.ts"]), writeTask(["src/right.ts"]), root), false);
	assert.equal(workerTasksConflict(writeTask(["src/left.ts"]), writeTask(["src/left.ts"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["src"]), writeTask(["src/left/file.ts"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["src"]), writeTask(["src/**"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["src/left/**"]), writeTask(["src/right/**"]), root), false);
	assert.equal(workerTasksConflict(writeTask(["src/**"]), writeTask(["src/left/*.ts"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["src/*.ts"]), writeTask(["src/*.js"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["*.ts"]), writeTask(["other/file.ts"]), root), true);
	assert.equal(workerTasksConflict(writeTask(["src/[ab].ts"]), writeTask(["other/file.ts"]), root), true);
});

test("task cwd boundaries use canonical main-workspace coordinates", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "packages", "a", "src"), { recursive: true });
	await mkdir(join(root, "packages", "b", "src"), { recursive: true });

	assert.equal(workerTasksConflict(
		writeTask(["src/**"], "packages/a"),
		writeTask(["src/**"], "packages/b"),
		root,
	), false);
	assert.equal(workerTasksConflict(
		writeTask(["a/src/**"], "packages"),
		writeTask(["src/**"], "packages/a"),
		root,
	), true);
	assert.equal(workerTasksConflict(
		writeTask(["*.ts"], "packages/a"),
		writeTask(["src/**"], "packages/b"),
		root,
	), true);
});

test("symlink aliases resolve to one write boundary", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "real"), { recursive: true });
	await symlink(join(root, "real"), join(root, "alias"), "dir");
	assert.equal(workerTasksConflict(writeTask(["alias/**"]), writeTask(["real/**"]), root), true);
});

test("dangling symlink boundaries are unknown and conflict conservatively", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "other"), { recursive: true });
	await symlink(join(root, "missing"), join(root, "dangling"), "dir");
	assert.equal(declaredWriteBoundary(writeTask(["dangling/**"]), root).unknown, true);
	assert.equal(workerTasksConflict(writeTask(["dangling/**"]), writeTask(["other/**"]), root), true);
});

test("changed_files attribution preserves raw observations and only filters real overlap", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "packages", "a", "src"), { recursive: true });
	await mkdir(join(root, "packages", "b", "src"), { recursive: true });
	const task = writeTask(["src/**"], "packages/a");
	const observed = ["src/own.ts", "../b/src/sibling.ts", "../shared.ts"];

	assert.deepEqual(filterChangedFilesToBoundary(task, root, observed), ["src/own.ts"]);
	assert.deepEqual(attributeChangedFiles(task, root, observed, false), {
		changedFiles: observed,
		observedChangedFiles: observed,
		attributedToDeclaredPaths: false,
	});
	assert.deepEqual(attributeChangedFiles(task, root, observed, true), {
		changedFiles: ["src/own.ts"],
		observedChangedFiles: observed,
		attributedToDeclaredPaths: true,
	});
});

test("changed-file filtering matches exact literal and glob guard semantics", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "src"), { recursive: true });
	assert.deepEqual(filterChangedFilesToBoundary(writeTask(["src"]), root, ["src", "src/file.ts"]), ["src"]);
	assert.deepEqual(filterChangedFilesToBoundary(writeTask(["src/**"]), root, ["src", "src/file.ts"]), ["src/file.ts"]);
	assert.deepEqual(filterChangedFilesToBoundary(writeTask(["src/*.ts"]), root, ["src/file.ts", "src/file.js", "src/nested/file.ts"]), ["src/file.ts"]);
});

test("write guard keeps exact file and subtree glob semantics without widening bare paths", async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "backend"));
	const base = { mode: "implement" as const, cwd: root, forbiddenPaths: [] };
	assert.match(validateWorkerWritePath({ ...base, allowedPaths: ["backend"] }, "backend/new.ts")!, /超出 allowedPaths/);
	assert.equal(validateWorkerWritePath({ ...base, allowedPaths: ["backend/**"] }, "backend/new.ts"), undefined);
	assert.equal(validateWorkerWritePath({ ...base, allowedPaths: ["backend/new.ts"] }, "backend/new.ts"), undefined);
	assert.match(validateWorkerWritePath({ ...base, allowedPaths: ["backend/new.ts"] }, "backend/other.ts")!, /超出 allowedPaths/);
	assert.equal(validateWorkerWritePath({ ...base, allowedPaths: ["backend/**"], forbiddenPaths: ["backend"] }, "backend/new.ts"), undefined);
	assert.match(validateWorkerWritePath({ ...base, allowedPaths: ["backend/**"], forbiddenPaths: ["backend/**"] }, "backend/new.ts")!, /命中 forbiddenPaths/);
});
