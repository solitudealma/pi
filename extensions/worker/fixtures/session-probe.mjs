// A local fake child: exercise the real CLI arguments/session file without a model call.
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const file = args.includes("--session") ? value("--session") : undefined;
const tempDir = path.dirname(value("--append-system-prompt"));
const manager = file ? SessionManager.open(file, value("--session-dir")) : SessionManager.inMemory();
const report = {
	args, tempDir, header: manager.getHeader(), entries: manager.getBranch(), context: manager.buildSessionContext(),
	fileMode: file && (fs.statSync(file).mode & 0o777), dirMode: fs.statSync(tempDir).mode & 0o777,
	env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_WORKER_"))),
};
// Appending affects only the child session, never the parent's manager or file.
manager.appendMessage({ role: "user", content: "child-only", timestamp: Date.now() });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }] } }));
if (args.at(-1) === "wait") {
	console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "session-ready", toolName: "probe" }));
	setInterval(() => {}, 1000);
} else if (args.at(-1) === "fail") process.exitCode = 7;
