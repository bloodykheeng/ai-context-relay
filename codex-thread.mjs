// Ask Codex to create a thread for a Claude session, the way the plugin does.
//
// It must be externalAgentConfig/import rather than thread/start: only the
// import fills in title, first_user_message and preview, and the chats list
// renders and searches on those. A thread/start thread is one Codex considers
// empty, so it never appears however well named it is.

import { spawn } from "child_process";
import readline from "readline";
import path from "path";
import fs from "fs";
import os from "os";

const RPC_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const IMPORT_DONE = "externalAgentConfig/import/completed";
const LEDGER = path.join(os.homedir(), ".codex", "external_agent_session_imports.json");

// Match on the path alone. The ledger stores Windows verbatim paths and a hash
// of a transcript that keeps growing, which is why the plugin's own lookup
// never matches on Windows and it reports a failure after a good import.
export function ledgerThreadFor(transcript) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return null; }
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const wanted = path.resolve(transcript).toLowerCase();
  const hit = records.filter((r) => {
    const source = String(r?.source_path ?? "").replace(/^\\\\\?\\/, "").toLowerCase();
    return source === wanted && typeof r?.imported_thread_id === "string";
  }).at(-1);
  return hit?.imported_thread_id ?? null;
}

// Never wrap in $SHELL: on Windows that points at a bash which may not exist,
// which is the plugin's own bug #669.
function spawnAppServer(cwd) {
  return spawn("codex", ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

export async function importClaudeSession(cwd, transcript, title) {
  const proc = spawnAppServer(cwd);
  proc.stdout.setEncoding("utf8");
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { stderr += chunk; });

  let nextId = 1;
  const pending = new Map();
  let onImported = null;
  const imported = new Promise((resolve) => { onImported = resolve; });

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === IMPORT_DONE) { onImported(); return; }
    const settle = message.id != null && pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out on ${method}`)); }, RPC_TIMEOUT_MS);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  try {
    await request("initialize", { clientInfo: { name: "relay", version: "1.0.0" }, capabilities: {} });
    notify("initialized", {});

    await request("externalAgentConfig/import", {
      migrationItems: [{
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(transcript)}`,
        cwd: null,
        details: {
          plugins: [], mcpServers: [], hooks: [], subagents: [], commands: [],
          sessions: [{ path: transcript, cwd, title: title ?? null }],
        },
      }],
    });

    await Promise.race([
      imported,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the import")), IMPORT_TIMEOUT_MS)),
    ]);

    const threadId = ledgerThreadFor(transcript);
    if (!threadId) throw new Error("Codex finished the import but recorded no thread");
    return { threadId, stderr: stderr.trim() };
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(detail ? `${error.message}\n${detail}` : error.message);
  } finally {
    proc.kill();
  }
}
