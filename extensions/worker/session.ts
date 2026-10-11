import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerTask } from "./types.ts";

/** Serialized at admission, not when a queued task eventually gets a slot. */
export interface WorkerSessionSnapshot {
	readonly branchJsonl: string;
}

export function captureWorkerSession(manager: Pick<ExtensionContext["sessionManager"], "getBranch">): WorkerSessionSnapshot {
	// getEntries()/forkFrom(file) would include inactive branches and miss in-memory
	// state. Serializing also detaches nested message content from later mutations.
	return Object.freeze({ branchJsonl: manager.getBranch().map((entry) => JSON.stringify(entry)).join("\n") });
}

export async function workerSessionArgs(task: WorkerTask, cwd: string, tempDir: string, snapshot?: WorkerSessionSnapshot): Promise<string[]> {
	const mode = task.sessionMode;
	if (mode === "new") return ["--no-session"];
	if (mode !== "fork") throw new Error(`无效 sessionMode: ${String(mode)}`);
	if (!snapshot) throw new Error("fork Worker 缺少主会话活动分支快照");
	// Use a fresh SDK header/ID, preserve entry IDs for compaction/context edits,
	// and never open, flush, branch or write the parent's manager/session file.
	const header = SessionManager.inMemory(cwd).getHeader();
	const file = path.join(tempDir, "worker-session.jsonl");
	await fs.writeFile(file, `${JSON.stringify(header)}\n${snapshot.branchJsonl}${snapshot.branchJsonl ? "\n" : ""}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	// --no-session takes precedence over --session; it MUST NOT accompany a fork.
	return ["--session", file, "--session-dir", tempDir];
}
