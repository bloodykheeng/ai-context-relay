#!/usr/bin/env node
// relay - keep a Claude Code session and a Codex thread as one conversation.
//
// BOTH DIRECTIONS. Claude turns are appended to the Codex thread, and work done
// in Codex is appended back to the Claude session. Each pass carries only what
// is new. Codex work appears in Claude when that session is RESUMED: a window
// already open never re-reads its own transcript.
//
//   relay              sync both ways, once
//   relay --watch      keep them in step (this is what --install runs)
//   relay --status     what is paired with what
//   relay --new        start a fresh Codex thread for this session
//   relay --install    run the watcher at every logon
//   relay --uninstall  stop that
//
// Flags: --cwd <dir>  --session <file>  --tools native|text  --no-thinking  --interval <sec>

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync, spawn } from "child_process";
import { importClaudeSession } from "./codex-thread.mjs";

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
const STATE_FILE = path.join(HOME, ".claude", "tools", "relay-state.json");

// A Claude session being written to right now is one we must not append to.
const IDLE_BEFORE_WRITE_MS = 20_000;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    open: false, watch: false, status: false, reset: false,
    cwd: null, session: null, tools: "native", thinking: true, interval: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--open") opts.open = true;
    else if (a === "--watch") opts.watch = true;
    else if (a === "--status") opts.status = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--new") opts.fresh = true;
    else if (a === "--install") opts.install = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--no-thinking") opts.thinking = false;
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--session") opts.session = argv[++i];
    else if (a === "--tools") opts.tools = argv[++i];
    else if (a === "--interval") opts.interval = Number(argv[++i]) || 10;
    else if (a === "-h" || a === "--help") opts.help = true;
    else die(`Unknown option ${a}. Try --help.`);
  }
  return opts;
}

function die(message) {
  console.error(`relay: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- utilities

// Codex thread ids are UUIDv7: millisecond timestamp prefix, so they sort by age.
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const shortId = (prefix) => `${prefix}_${crypto.randomBytes(16).toString("hex")}`;

// Codex compares cwd as a plain string, so a lowercase drive letter hides the
// thread from the VS Code list. Always stamp the uppercase form.
function normaliseCwd(dir) {
  return path.resolve(dir).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function gitInfo(cwd) {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return null; }
  };
  const commit = run(["rev-parse", "HEAD"]);
  if (!commit) return null;
  return {
    commit_hash: commit,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    repository_url: run(["config", "--get", "remote.origin.url"]),
  };
}

// ------------------------------------------------------- finding the source

// Claude names a project folder after its cwd, non-alphanumerics folded to "-".
// One dash per separator character, never per run: "d:\coding" is "d--coding".
// Case is preserved, because Claude keeps whatever the cwd string carried.
const slugFor = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// The drive letter's case is not ours to predict, so match a folder that
// already exists however it is spelled before minting a new name.
function projectDir(cwd) {
  const wanted = slugFor(cwd);
  if (fs.existsSync(CLAUDE_PROJECTS)) {
    const hit = fs.readdirSync(CLAUDE_PROJECTS).find((d) => d.toLowerCase() === wanted.toLowerCase());
    if (hit) return path.join(CLAUDE_PROJECTS, hit);
  }
  return path.join(CLAUDE_PROJECTS, wanted);
}

function newestFile(dir, filter = () => true) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && filter(f))
    .map((f) => path.join(dir, f))
    .map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file ?? null;
}

// Prefer the slug, but fall back to reading each project's cwd, since the slug
// rule is Claude's and could change under us.
function findTranscript(cwd) {
  const bySlug = projectDir(cwd);
  const direct = newestFile(bySlug);
  if (direct) return direct;

  if (!fs.existsSync(CLAUDE_PROJECTS)) die(`no Claude projects directory at ${CLAUDE_PROJECTS}`);
  const target = cwd.toLowerCase();
  for (const entry of fs.readdirSync(CLAUDE_PROJECTS)) {
    const candidate = newestFile(path.join(CLAUDE_PROJECTS, entry));
    if (!candidate) continue;
    const found = cwdOf(candidate);
    if (found && found.toLowerCase() === target) return candidate;
  }
  return null;
}

// --------------------------------------------------- reading the transcript

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c.type === "text").map((c) => c.text).join("");
};

const resultText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((c) => c.text ?? (c.type === "image" ? "[image]" : "")).join("").trim();
};

// Claude keeps screenshots inline as base64. Writing them out once and passing
// paths keeps the session file readable, where 3.5MB of data URIs would not be.
const MEDIA_DIR = path.join(HOME, ".codex", "relay-media");
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const MIME_FOR = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Claude takes PDFs, spreadsheets, documents and plain text as `document`
// blocks, base64 like an image. They are written out beside the screenshots so
// nothing is lost, and named in the message so the conversation still reads.
const EXTENSION_FOR = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

function saveDocument(block) {
  const data = block?.source?.data;
  if (block?.source?.type !== "base64" || !data) return null;
  const mime = block.source.media_type ?? "application/octet-stream";
  const extension = EXTENSION_FOR[mime] ?? "bin";
  const name = `${crypto.createHash("sha256").update(data).digest("hex").slice(0, 32)}.${extension}`;
  const file = path.join(MEDIA_DIR, name);
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, "base64"));
    return { file, mime, title: block.title ?? block.source.title ?? null, bytes: Buffer.byteLength(data, "base64") };
  } catch {
    return null;
  }
}

const describeFile = (doc) => {
  const size = doc.bytes > 1048576
    ? `${(doc.bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(doc.bytes / 1024))} KB`;
  return `[attached: ${doc.title ?? path.basename(doc.file)} (${doc.mime}, ${size}) saved at ${doc.file}]`;
};

function dataUrlFor(file) {
  try {
    const extension = path.extname(file).slice(1).toLowerCase();
    const mime = MIME_FOR[extension] ?? "image/png";
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function saveImage(block) {
  const data = block?.source?.data;
  if (block?.source?.type !== "base64" || !data) return null;
  const extension = EXTENSIONS[block.source.media_type] ?? "png";
  // Named by content, so the same screenshot is written once however often it
  // appears and a re-sync never duplicates it.
  const name = `${crypto.createHash("sha256").update(data).digest("hex").slice(0, 32)}.${extension}`;
  const file = path.join(MEDIA_DIR, name);
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return null;
  }
}

// Flatten Claude's records into the turn sequence Codex needs. Everything that
// is bookkeeping rather than conversation (attachments, queue operations, mode
// changes, file snapshots) is dropped.
const readTurns = (file, opts) => itemsFrom(readJsonl(file), opts);

// A live transcript only ever grows, so re-reading it whole every pass is the
// difference between a few percent of a core and nothing. Read from where the
// last pass stopped, and never past the final newline: the tail of an active
// file is a half-written record.
function readTurnsSince(file, fromByte, opts) {
  const size = fs.statSync(file).size;
  if (fromByte >= size) return { items: [], nextByte: size };

  const length = size - fromByte;
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(file, "r");
  try { fs.readSync(handle, buffer, 0, length, fromByte); } finally { fs.closeSync(handle); }

  const text = buffer.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { items: [], nextByte: fromByte };

  const complete = text.slice(0, lastNewline + 1);
  const records = complete.split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { items: itemsFrom(records, opts), nextByte: fromByte + Buffer.byteLength(complete, "utf8") };
}

function itemsFrom(records, { thinking }) {
  const items = [];
  for (const rec of records) {
    // Skip anything relay wrote, or the two sides echo each other forever.
    if (rec.relayOrigin) continue;
    const content = rec.message?.content;

    if (rec.type === "user") {
      if (Array.isArray(content) && content.some((c) => c.type === "tool_result")) {
        for (const block of content.filter((c) => c.type === "tool_result")) {
          items.push({ kind: "tool_result", id: block.tool_use_id, text: resultText(block.content) });
        }
        continue;
      }
      const text = textOf(content);
      const parts = Array.isArray(content) ? content : [];
      const images = parts.filter((c) => c.type === "image").map(saveImage).filter(Boolean);
      const files = parts.filter((c) => c.type === "document").map(saveDocument).filter(Boolean);
      if (text.trim() || images.length || files.length) {
        const note = files.map(describeFile).join("\n");
        items.push({ kind: "user", text: note ? `${text}\n\n${note}`.trim() : text, images });
      }
      continue;
    }

    if (rec.type !== "assistant" || !Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "text" && block.text.trim()) {
        items.push({ kind: "assistant", text: block.text });
      } else if (block.type === "thinking" && thinking && block.thinking?.trim()) {
        // Codex reasoning items carry server-encrypted content we cannot forge,
        // so Claude's thinking is carried as plain assistant text instead.
        items.push({ kind: "assistant", text: `[thinking]\n${block.thinking}` });
      } else if (block.type === "tool_use") {
        items.push({ kind: "tool_call", id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
  }
  return items;
}

// ---------------------------------------------------- writing the rollout

const stamp = () => new Date().toISOString();

const eventMsg = (payload) => ({ timestamp: stamp(), type: "event_msg", payload });
const responseItem = (payload) => ({ timestamp: stamp(), type: "response_item", payload });

function userRecords(text, turn, images = []) {
  // Codex carries pasted screenshots as local_images beside the text, and as
  // input_image parts in the message itself. The part must be a data URI: the
  // thread is replayed to the API, which rejects a file:// URL outright and
  // fails every turn after it.
  const content = [{ type: "input_text", text }];
  for (const file of images) {
    const url = dataUrlFor(file);
    if (url) content.push({ type: "input_image", image_url: url, detail: "auto" });
  }
  return [
    eventMsg({ type: "task_started", turn_id: turn, started_at: Math.floor(Date.now() / 1000), model_context_window: null, collaboration_mode_kind: "default" }),
    eventMsg({ type: "user_message", message: text, local_images: images, local_audio: [], text_elements: [] }),
    responseItem({ type: "message", role: "user", content }),
  ];
}

function assistantRecords(text) {
  return [
    eventMsg({ type: "agent_message", message: text, phase: null, memory_citation: null }),
    responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }),
  ];
}

// Claude's tool names are not Codex's. Keeping the real name in the arguments
// means nothing is lost even where the label does not match a registered tool.
function toolCallRecords(item, callId) {
  return [responseItem({
    type: "function_call",
    id: shortId("fc"),
    name: item.name === "Bash" || item.name === "PowerShell" ? "shell" : item.name,
    arguments: JSON.stringify(item.input),
    call_id: callId,
  })];
}

function toolOutputRecords(text, callId) {
  return [responseItem({
    type: "function_call_output",
    id: shortId("fco"),
    call_id: callId,
    output: [{ type: "input_text", text: text || "(no output)" }],
  })];
}

// Tool activity as prose, for when native call items are not wanted.
function toolAsText(item) {
  const input = item.input?.command ?? item.input?.file_path ?? item.input?.pattern ?? JSON.stringify(item.input);
  return `[${item.name}] ${String(input).slice(0, 2000)}`;
}

function buildRecords(items, { tools }) {
  const records = [];
  const callIds = new Map();
  let turn = 0;
  let pendingClose = false;

  const closeTurn = () => {
    if (!pendingClose) return;
    records.push(eventMsg({ type: "task_complete", turn_id: `relay-turn-${turn}`, last_agent_message: null, started_at: Math.floor(Date.now() / 1000) }));
    pendingClose = false;
  };

  for (const item of items) {
    if (item.kind === "user") {
      closeTurn();
      turn++;
      records.push(...userRecords(item.text, `relay-turn-${turn}`, item.images ?? []));
      pendingClose = true;
    } else if (item.kind === "assistant") {
      records.push(...assistantRecords(item.text));
    } else if (item.kind === "tool_call") {
      if (tools === "text") {
        records.push(...assistantRecords(toolAsText(item)));
      } else {
        const callId = `call_${crypto.randomBytes(12).toString("hex")}`;
        callIds.set(item.id, callId);
        records.push(...toolCallRecords(item, callId));
      }
    } else if (item.kind === "tool_result") {
      const text = item.text.slice(0, 20000);
      if (tools === "text") {
        records.push(...assistantRecords(`-> ${text.slice(0, 2000)}`));
      } else {
        const callId = callIds.get(item.id);
        // A result with no matching call would be rejected on replay, so drop it.
        if (callId) records.push(...toolOutputRecords(text, callId));
      }
    }
  }
  closeTurn();
  return records;
}

// The header carries fields we cannot invent (base instructions, history mode),
// so it is cloned from a rollout Codex wrote and only the identity is replaced.
function buildMeta(threadId, cwd) {
  const donor = findDonorMeta();
  if (!donor) die("no existing Codex session to copy a header from. Run Codex once, then retry.");
  return {
    timestamp: stamp(),
    type: "session_meta",
    payload: {
      ...donor,
      session_id: threadId,
      id: threadId,
      timestamp: stamp(),
      cwd,
      originator: "Claude Code",
      context_window: { window_id: uuidv7() },
      git: gitInfo(cwd) ?? donor.git ?? null,
    },
  };
}

function findDonorMeta() {
  const rollouts = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        rollouts.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(CODEX_SESSIONS);
  rollouts.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of rollouts) {
    const first = readJsonl(file)[0];
    if (first?.type === "session_meta" && first.payload?.base_instructions) return first.payload;
  }
  return null;
}

// Codex lists recent chats from a database, not by scanning session files, so
// a rollout with no row there is invisible however well formed it is. Paths are
// stored in the Windows verbatim form, the same one the import ledger uses.
const CODEX_STATE_DB = path.join(HOME, ".codex", "state_5.sqlite");
const verbatim = (p) => (p.startsWith("\\\\?\\") ? p : `\\\\?\\${p}`);

const THREAD_COLUMNS = "id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, git_sha, git_branch, git_origin_url, cli_version, first_user_message, memory_mode, created_at_ms, updated_at_ms, preview, recency_at, recency_at_ms, history_mode, is_pinned";
const THREAD_VALUES = "?,?,?,?,'vscode','openai',?,?,'{\"type\":\"read-only\"}','on-request',0,0,0,?,?,?,?,?,'enabled',?,?,?,?,?,'legacy',0";

// A session the Codex plugin has already transferred has a thread waiting for
// it. Match on the path alone: the ledger stores Windows verbatim paths and a
// hash of a transcript that keeps growing, which is why the plugin's own
// lookup never matches on Windows.
function ledgerThreadFor(transcript) {
  const ledger = readJson(path.join(HOME, ".codex", "external_agent_session_imports.json"), null);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const wanted = path.resolve(transcript).toLowerCase();
  const hit = records.filter((r) => {
    const source = String(r?.source_path ?? "").replace(/^\\\\\?\\/, "").toLowerCase();
    return source === wanted && typeof r?.imported_thread_id === "string";
  }).at(-1);
  return hit?.imported_thread_id ?? null;
}

function rolloutForThread(threadId) {
  let found = null;
  const walk = (dir) => {
    if (found || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) found = full;
    }
  };
  walk(CODEX_SESSIONS);
  return found;
}

function rolloutPathFor(threadId) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  // The directory and filename use local time; the header timestamp is UTC.
  const dir = path.join(CODEX_SESSIONS, String(now.getFullYear()), p(now.getMonth() + 1), p(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const name = `rollout-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${threadId}.jsonl`;
  return path.join(dir, name);
}

const writeRecords = (file, records, append) =>
  fs[append ? "appendFileSync" : "writeFileSync"](file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

// --------------------------------------------------- reading Codex's side

// Everything the rollout gained past what relay wrote is work done in Codex.
function readCodexItems(file, fromRecord) {
  const items = [];
  const names = new Map();
  for (const rec of readJsonl(file).slice(fromRecord)) {
    const p = rec.payload;
    if (!p) continue;
    if (rec.type === "event_msg" && p.type === "user_message" && p.message?.trim()) {
      items.push({ kind: "user", text: p.message });
    } else if (rec.type === "response_item" && p.type === "message" && p.role === "assistant") {
      const text = (p.content ?? []).map((c) => c.text ?? "").join("");
      if (text.trim()) items.push({ kind: "assistant", text });
    } else if (rec.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      names.set(p.call_id, p.name);
      items.push({ kind: "tool_call", name: p.name, input: p.arguments ?? p.input });
    } else if (rec.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      const text = Array.isArray(p.output) ? p.output.map((o) => o.text ?? "").join("") : String(p.output ?? "");
      items.push({ kind: "tool_result", name: names.get(p.call_id) ?? "tool", text });
    }
  }
  return items;
}

// ---------------------------------------------------- writing Claude's side

const synthetic = (text) => ({
  id: crypto.randomUUID(), type: "message", role: "assistant", model: "<synthetic>",
  stop_reason: "stop_sequence", stop_sequence: "",
  content: [{ type: "text", text }],
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

// Codex tool activity arrives as text rather than as tool_use blocks: a Claude
// tool_use must name a tool Claude actually has, and Codex's are not the same.
function claudeRecords(items, ctx) {
  const records = [];
  let parent = ctx.parentUuid;

  const push = (record) => {
    record.uuid = crypto.randomUUID();
    record.timestamp = stamp();
    records.push(record);
    parent = record.uuid;
  };
  const base = () => ({
    parentUuid: parent, isSidechain: false, userType: "external", entrypoint: "relay",
    cwd: ctx.cwd, sessionId: ctx.sessionId, version: ctx.version, gitBranch: ctx.gitBranch,
    relayOrigin: "codex",
  });
  const say = (text) => push({ ...base(), type: "assistant", message: synthetic(text) });

  for (const item of items) {
    if (item.kind === "user") push({ ...base(), type: "user", message: { role: "user", content: `[in Codex] ${item.text}` } });
    else if (item.kind === "assistant") say(item.text);
    else if (item.kind === "tool_call") {
      const args = typeof item.input === "string" ? item.input : JSON.stringify(item.input);
      say(`[Codex ran ${item.name}]\n${String(args).slice(0, 4000)}`);
    } else if (item.kind === "tool_result" && item.text.trim()) say(`[result]\n${item.text.slice(0, 8000)}`);
  }
  return records;
}

function claudeContext(file) {
  const records = readJsonl(file);
  const anchor = [...records].reverse().find((r) => r.sessionId) ?? {};
  return {
    parentUuid: records[records.length - 1]?.uuid ?? null,
    sessionId: anchor.sessionId ?? path.basename(file, ".jsonl"),
    cwd: anchor.cwd ?? process.cwd(),
    version: anchor.version ?? "2.1.263",
    gitBranch: anchor.gitBranch ?? null,
  };
}

// ------------------------------------- adopting a chat that began in Codex

// Every Codex rollout sitting in this project that relay did not write itself.
function codexThreadsFor(cwd, ours) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") && !ours.has(full)) {
        const meta = firstRecordOf(full);
        const theirs = String(meta?.payload?.cwd ?? "").toLowerCase();
        // A null cwd asks for every project, which is what the daemon wants.
        if (meta?.type === "session_meta" && theirs && (!cwd || theirs === cwd.toLowerCase())) {
          found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        }
      }
    }
  };
  walk(CODEX_SESSIONS);
  return found.sort((a, b) => b.mtime - a.mtime);
}

// Claude opens a session by reading its transcript, so starting one from a
// Codex thread means writing that transcript rather than driving the CLI.
function adoptFromCodex(cwd, rollout) {
  const items = readCodexItems(rollout, 0);
  if (items.length === 0) return null;

  const sessionId = crypto.randomUUID();
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${sessionId}.jsonl`);

  const ctx = {
    parentUuid: null, sessionId, cwd,
    version: "2.1.263", gitBranch: gitInfo(cwd)?.branch ?? null,
  };
  writeRecords(transcript, claudeRecords(items, ctx), false);

  const state = loadState();
  state.threads[transcript] = {
    threadId: path.basename(rollout).replace(/^rollout-.*?-(.{36})\.jsonl$/, "$1"),
    rollout, transcript, cwd,
    title: `Started in Codex: ${path.basename(cwd)}`,
    itemCount: readTurns(transcript, { thinking: true }).length,
    codexRecords: countLines(rollout),
    updatedAt: stamp(),
  };
  saveState(state);
  return { transcript, moved: items.length };
}

// ------------------------------------------------------------------- state

const loadState = () => readJson(STATE_FILE, { threads: {} });

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ------------------------------------------------------------------ commands

// Counting newlines beats parsing every record just to learn how many there are.
function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, "utf8");
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

// A session file's header is its first line. Reading the whole file to reach it
// costs megabytes per rollout, and the watcher does this across every one.
function firstRecordOf(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(65536);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.indexOf("\n");
    return JSON.parse(end === -1 ? text : text.slice(0, end));
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function resolvePair(opts) {
  const cwd = normaliseCwd(opts.cwd ?? process.cwd());
  const transcript = opts.session ?? findTranscript(cwd);
  if (!transcript) die(`no Claude session found for ${cwd}`);
  if (!fs.existsSync(transcript)) die(`no such transcript: ${transcript}`);
  return { cwd, transcript: path.resolve(transcript), key: path.resolve(transcript), state: loadState() };
}

// Codex owns the chats list, so the thread has to be one Codex made. Take the
// one an earlier transfer left behind, else ask Codex for a fresh one.
async function pairWith(ctx, opts = {}) {
  const title = `Relayed from Claude Code: ${path.basename(ctx.cwd)}`;

  // --new skips the adopt path, for when an existing thread is already messy.
  const existing = opts.fresh ? null : ledgerThreadFor(ctx.transcript);
  const existingRollout = existing && rolloutForThread(existing);
  if (existingRollout) {
    // A thread with a body already holds this conversation, however it got
    // there. Writing it again is how you end up reading everything twice.
    const hasBody = countLines(existingRollout) > 1;
    return { threadId: existing, rollout: existingRollout, title, adopted: true, importCarriedBody: hasBody };
  }

  const created = await importClaudeSession(ctx.cwd, ctx.transcript, title);
  const rollout = rolloutForThread(created.threadId);
  if (!rollout) throw new Error("Codex imported the session but wrote no file for it");

  // The import writes the conversation as plain messages, and relay is about to
  // write the same conversation with its tool calls and images. Keep the header
  // Codex wrote and drop its body, or every turn appears twice. A thread this
  // new has not been read yet, so there is nothing to disturb.
  let importCarriedBody = true;
  try {
    const header = firstRecordOf(rollout);
    if (header) {
      writeRecords(rollout, [header], false);
      importCarriedBody = false;
    }
  } catch {
    // Codex still holds the file: leave its version alone and carry on from here.
  }
  return { threadId: created.threadId, rollout, title, adopted: false, importCarriedBody };
}

async function toCodex(ctx, opts) {
  const prior = ctx.state.threads[ctx.key];

  // Once a pairing knows where it stopped, only the new bytes are read. A
  // pairing made before that was recorded falls back to reading it whole.
  const incremental = prior?.claudeBytes != null;
  const slice = incremental
    ? readTurnsSince(ctx.transcript, prior.claudeBytes, { thinking: opts.thinking })
    : null;
  const items = incremental ? slice.items : readTurns(ctx.transcript, { thinking: opts.thinking });
  const fresh = incremental ? slice.items : items.slice(prior?.itemCount ?? 0);
  const nextByte = incremental ? slice.nextByte : fs.statSync(ctx.transcript).size;

  if (prior && fresh.length === 0) {
    // Record where we stopped even when nothing moved, or a pairing made
    // before offsets existed never gets one and re-reads the file forever.
    if (nextByte !== prior.claudeBytes) {
      ctx.state.threads[ctx.key] = { ...prior, claudeBytes: nextByte, updatedAt: stamp() };
      saveState(ctx.state);
    }
    return { moved: 0, thread: prior };
  }

  const pair = prior ?? (await pairWith(ctx, opts));
  const { threadId, rollout, title } = pair;

  // Codex already wrote this conversation and we could not clear it, so start
  // from here rather than saying everything twice.
  if (!prior && pair.importCarriedBody) fresh.length = 0;
  // A thread Codex has just created has a path and no file, so it needs the
  // header before anything else. An adopted thread already has one.
  if (!fs.existsSync(rollout)) {
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    writeRecords(rollout, [buildMeta(threadId, ctx.cwd), ...userRecords(title, "relay-turn-0")], false);
  }
  const records = buildRecords(fresh, { tools: opts.tools });
  if (records.length) writeRecords(rollout, records, true);
  // Report what was written, not what was read: adopting a thread that already
  // holds the conversation reads everything and sends none of it.
  const moved = records.length ? fresh.length : 0;

  ctx.state.threads[ctx.key] = {
    ...(prior ?? {}), threadId, rollout, title, cwd: ctx.cwd, transcript: ctx.transcript,
    itemCount: incremental ? (prior.itemCount ?? 0) + fresh.length : items.length,
    claudeBytes: nextByte,
    codexRecords: countLines(rollout), updatedAt: stamp(),
  };
  saveState(ctx.state);
  return { moved, thread: ctx.state.threads[ctx.key], created: !prior };
}

function toClaude(ctx) {
  const prior = ctx.state.threads[ctx.key];
  if (!prior || !fs.existsSync(prior.rollout)) return { moved: 0 };

  const items = readCodexItems(prior.rollout, prior.codexRecords ?? 0);
  if (items.length === 0) return { moved: 0 };

  // Never append to a transcript Claude is still writing to, or our records
  // land in the middle of a turn the extension has not finished.
  if (Date.now() - fs.statSync(ctx.transcript).mtimeMs < IDLE_BEFORE_WRITE_MS) return { moved: 0, held: items.length };

  writeRecords(ctx.transcript, claudeRecords(items, claudeContext(ctx.transcript)), true);
  ctx.state.threads[ctx.key] = {
    ...prior,
    codexRecords: countLines(prior.rollout),
    // Our own records are skipped on read, but stepping past them keeps the
    // next pass from re-reading what we just wrote.
    claudeBytes: fs.statSync(ctx.transcript).size,
    updatedAt: stamp(),
  };
  saveState(ctx.state);
  return { moved: items.length };
}

async function sync(opts, quiet = false) {
  const ctx = resolvePair(opts);
  const up = await toCodex(ctx, opts);
  ctx.state = loadState();
  const down = toClaude(ctx);

  if (up.created) {
    console.log("relay: paired this session with a new Codex thread");
    console.log(`relay: open Codex, it is at the top of your recent chats as "${up.thread.title}"`);
  }
  if (up.moved) console.log(`relay: sent ${up.moved} items to Codex`);
  if (down.moved) console.log(`relay: brought ${down.moved} items back into Claude`);
  if (down.held) console.log(`relay: holding ${down.held} items from Codex until Claude is idle`);
  if (!quiet && !up.moved && !down.moved && !up.created) console.log("relay: already in step");
  return up.thread;
}

function status() {
  const state = loadState();
  const rows = Object.entries(state.threads);
  if (rows.length === 0) return console.log("relay: nothing carried yet");
  for (const [, t] of rows) {
    const behind = fs.existsSync(t.rollout) ? countLines(t.rollout) - (t.codexRecords ?? 0) : 0;
    console.log(`\n${path.basename(t.cwd)}`);
    console.log(`  codex thread  "${t.title}"`);
    console.log(`  sent          ${t.itemCount} items to Codex`);
    console.log(`  waiting       ${behind > 0 ? `${behind} records from Codex` : "nothing"}`);
    console.log(`  updated       ${t.updatedAt}`);
  }
}

// Start the watcher at every logon, with no window, so the two sides stay in
// step without anything being typed. Windows only, which is where this runs.
const TOOLS_DIR = path.dirname(new URL(import.meta.url).pathname.slice(1));
const STARTUP_DIR = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_FILE = path.join(STARTUP_DIR, "relay.vbs");

// The Startup folder needs no elevation, unlike a scheduled task, and the user
// can see and delete the entry themselves.
function install() {
  const target = path.join(TOOLS_DIR, "relay.mjs");
  const script = `CreateObject("WScript.Shell").Run "node ""${target}"" --watch --interval 15", 0, False\n`;
  fs.writeFileSync(path.join(TOOLS_DIR, "relay-hidden.vbs"), script, "ascii");

  if (!fs.existsSync(STARTUP_DIR)) die(`no Startup folder at ${STARTUP_DIR}`);
  fs.writeFileSync(STARTUP_FILE, script, "ascii");

  spawn("wscript.exe", [STARTUP_FILE], { detached: true, stdio: "ignore" }).unref();
  console.log("relay: installed. It starts at every logon and is running now.");
  console.log("relay: nothing to type again. Remove it with  relay --uninstall");
}

function uninstall() {
  if (fs.existsSync(STARTUP_FILE)) {
    fs.unlinkSync(STARTUP_FILE);
    console.log("relay: removed from startup. Your paired chats are untouched.");
    console.log("relay: a watcher already running stops at your next logout.");
  } else {
    console.log("relay: it was not installed");
  }
}

function reset(opts) {
  const ctx = resolvePair(opts);
  if (ctx.state.threads[ctx.key]) {
    delete ctx.state.threads[ctx.key];
    saveState(ctx.state);
    console.log("relay: unpaired, next sync starts a fresh Codex thread");
  } else {
    console.log("relay: nothing paired for this project");
  }
}

// Anything untouched for a day is finished work, not a chat being switched.
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// A Codex thread per throwaway chat buries the list. Wait until a session is
// actually a conversation before pairing it. An existing pair keeps syncing
// however small it is, so nothing already carried is dropped.
const MIN_ITEMS_TO_PAIR = 6;

// Pairing is for the chat in front of you. A day-wide window plus every
// session in every project opens a thread for work you finished this morning.
// An existing pair keeps syncing however long it has been quiet.
const PAIR_WINDOW_MS = 30 * 60 * 1000;

const recentlyTouched = (file) => Date.now() - fs.statSync(file).mtimeMs < ACTIVE_WINDOW_MS;

// Every transcript across every project that has been written to lately.
function activeSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const found = [];
  for (const entry of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, entry);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try { if (recentlyTouched(file)) found.push(file); } catch { /* vanished */ }
    }
  }
  return found;
}

// Stamped after a pass so the next one can tell at a glance that nothing moved.
function rememberMtimes(key) {
  const state = loadState();
  const thread = state.threads[key];
  if (!thread) return;
  thread.claudeMtime = fs.existsSync(key) ? fs.statSync(key).mtimeMs : 0;
  thread.codexMtime = fs.existsSync(thread.rollout) ? fs.statSync(thread.rollout).mtimeMs : 0;
  saveState(state);
}

// Discovery only needs the cwd, and it is on an early record, so read the head
// of the file rather than parsing megabytes of conversation to find it.
function cwdOf(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(65536);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try { const parsed = JSON.parse(line); if (parsed.cwd) return parsed.cwd; } catch { /* truncated tail */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// One pass over everything: keep known pairs in step, then adopt any chat that
// began on one side only, whichever side that is.
async function syncAll(opts) {
  const say = [];
  let state = loadState();

  for (const [key, thread] of Object.entries(state.threads)) {
    if (!fs.existsSync(key)) continue;
    // Neither side has been written to, so there is nothing to read. Without
    // this the watcher re-parses every transcript on every pass, which on an
    // 8MB session is most of a core spent finding no change.
    const claudeMtime = fs.statSync(key).mtimeMs;
    const codexMtime = fs.existsSync(thread.rollout) ? fs.statSync(thread.rollout).mtimeMs : 0;
    if (thread.claudeMtime === claudeMtime && thread.codexMtime === codexMtime) continue;
    try {
      const ctx = { cwd: thread.cwd, transcript: key, key, state: loadState() };
      const up = await toCodex(ctx, opts);
      ctx.state = loadState();
      const down = toClaude(ctx);
      if (up.moved) say.push(`${path.basename(thread.cwd)}: sent ${up.moved} to Codex`);
      if (down.moved) say.push(`${path.basename(thread.cwd)}: brought ${down.moved} back to Claude`);
      rememberMtimes(key);
    } catch (error) {
      say.push(`${path.basename(thread.cwd)}: ${error.message}`);
    }
  }

  // A chat started in Claude with no Codex thread yet.
  state = loadState();
  if (fs.existsSync(CLAUDE_PROJECTS)) {
    // Every live session in the project, not just the newest one. Two chats
    // open at once is ordinary, and taking only the newest meant the second
    // was never looked at as long as the first kept being written to.
    for (const transcript of activeSessions()) {
      if (state.threads[transcript]) continue;
      if (Date.now() - fs.statSync(transcript).mtimeMs > PAIR_WINDOW_MS) continue;
      const cwd = cwdOf(transcript);
      if (!cwd) continue;
      try {
        const ctx = { cwd: normaliseCwd(cwd), transcript, key: transcript, state: loadState() };
        if (readTurns(transcript, { thinking: false }).length < MIN_ITEMS_TO_PAIR) continue;
        const up = await toCodex(ctx, opts);
        if (up.created) say.push(`${path.basename(ctx.cwd)}: opened a Codex thread, "${up.thread.title}"`);
      } catch (error) {
        // Never silent: a pairing that fails looks exactly like one that was
        // never attempted, which is indistinguishable from the tool ignoring you.
        say.push(`${path.basename(transcript)}: could not pair, ${error.message}`);
      }
    }
  }

  // A chat started in Codex with no Claude session yet.
  state = loadState();
  const ours = new Set(Object.values(state.threads).map((t) => t.rollout));
  const adopted = new Set(Object.values(state.threads).map((t) => t.cwd.toLowerCase()));
  for (const { file, mtime } of codexThreadsFor(null, ours, true)) {
    if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
    const cwd = firstRecordOf(file)?.payload?.cwd;
    if (!cwd || adopted.has(String(cwd).toLowerCase())) continue;
    try {
      const result = adoptFromCodex(normaliseCwd(cwd), file);
      if (result) {
        adopted.add(String(cwd).toLowerCase());
        say.push(`${path.basename(cwd)}: started a Claude session from Codex, ${result.moved} items`);
      }
    } catch { /* retried next pass */ }
  }

  return say;
}

async function watch(opts) {
  console.log(`relay: watching every project, checking every ${opts.interval}s. Ctrl+C to stop.`);
  // A watcher started before an update keeps running the old code for as long
  // as the machine stays on, which is how a fix can look like it did nothing.
  const ownFile = new URL(import.meta.url).pathname.slice(1);
  const startedWith = fs.statSync(ownFile).mtimeMs;

  for (;;) {
    if (fs.existsSync(ownFile) && fs.statSync(ownFile).mtimeMs !== startedWith) {
      console.log("relay: updated on disk, restarting on the new version");
      spawn(process.execPath, [ownFile, ...process.argv.slice(2)], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    try {
      for (const line of await syncAll(opts)) console.log(`relay: ${line}`);
    } catch (error) {
      console.error(`relay: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }
}

const HELP = `relay - keep a Claude Code session and a Codex thread as one conversation

Both directions. Codex work appears in Claude when you RESUME that session;
a window already open never re-reads its own transcript.

  relay                sync both ways, once
  relay --watch        keep them in step (what --install runs)
  relay --status       what is paired with what
  relay --new          start a fresh Codex thread for this session
  relay --reset        unpair this session
  relay --install      run the watcher at every logon
  relay --uninstall    stop that

  --cwd <dir>          project directory (default: current)
  --session <file>     a specific Claude transcript
  --tools native|text  carry tool calls as call items or as prose (default: native)
  --no-thinking        leave Claude's reasoning out
  --interval <sec>     poll interval for --watch (default: 10)
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  if (!["native", "text"].includes(opts.tools)) die("--tools takes native or text");
  if (opts.install) return install();
  if (opts.uninstall) return uninstall();
  if (opts.status) return status();
  if (opts.reset) return reset(opts);
  if (opts.watch) return watch(opts);
  // A fresh thread means forgetting the old pairing first.
  if (opts.fresh) reset(opts);
  return sync(opts);
}

// Not every command returns a promise, so normalise before catching.
Promise.resolve(main()).catch((error) => die(error.message));
