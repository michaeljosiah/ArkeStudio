import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { permits, type AgentConfinement } from "@arke-studio/contracts";
import { object, type JsonObject } from "./rpc.js";

export interface DynamicFunction { type: "function"; name: string; description: string; inputSchema: JsonObject }
export type ToolContent = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };
export interface ToolResult { success: boolean; contentItems: ToolContent[] }
export interface ToolSession {
  root: string;
  confinement: AgentConfinement;
  worldQueryUrl?: string;
  worldTools: Map<string, DynamicFunction>;
  inputModalities?: ("text" | "image")[];
}
export interface ExecutedTool { result: ToolResult; summary?: string }
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TEXT = 128 * 1024;
const textResult = (text: string): ToolResult => ({ success: true, contentItems: [{ type: "inputText", text }] });
export class ConfinementError extends Error { constructor() { super("Denied by Arke Studio confinement."); } }
export function within(root: string, target: string): boolean {
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const base = fold(root); const path = fold(target);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}
export async function resolveRoot(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  if (!(await lstat(root)).isDirectory()) throw new Error("Codex needs a session directory.");
  return root;
}

/** Refuse linked path segments before opening. Search uses this for every discovered leaf too. */
export async function confinedPath(root: string, raw: string, write = false): Promise<string> {
  if (!raw || raw.includes("\0")) throw new ConfinementError();
  const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!within(root, target) || !within(root, await realpath(root))) throw new ConfinementError();
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new ConfinementError();
      if (!within(root, await realpath(current))) throw new ConfinementError();
      if (i < parts.length - 1 && !stat.isDirectory()) throw new ConfinementError();
    } catch (error) {
      if (write && object(error).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

function schema(properties: JsonObject, required: string[]): JsonObject { return { type: "object", properties, required, additionalProperties: false }; }
const string = { type: "string" };
const FILE_TOOLS: DynamicFunction[] = [
  { type: "function", name: "read", description: "Read a file in this session. PNG, JPEG, GIF and WebP return actual image content. Text reads may use offset and limit.", inputSchema: schema({ path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: MAX_TEXT } }, ["path"]) },
  { type: "function", name: "list", description: "List one directory in this session. Links are excluded.", inputSchema: schema({ path: string }, []) },
  { type: "function", name: "search", description: "Find literal text inside this session's text files. No shell or regular expressions. Results include file names and line numbers.", inputSchema: schema({ query: string, path: string, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["query"]) },
  { type: "function", name: "write", description: "Write a UTF-8 file inside this session. Creates parent directories. Only proposal files may be changed.", inputSchema: schema({ path: string, content: string }, ["path", "content"]) },
  { type: "function", name: "edit", description: "Replace exactly one matching text passage inside a session file. Refuses zero or multiple matches.", inputSchema: schema({ path: string, oldText: string, newText: string }, ["path", "oldText", "newText"]) },
];
const INTENTS = { read: "read", list: "list", search: "search", write: "edit", edit: "edit" } as const;

export function toolsFor(session: ToolSession): DynamicFunction[] {
  return [...FILE_TOOLS.filter(tool => permits(session.confinement, INTENTS[tool.name as keyof typeof INTENTS])), ...session.worldTools.values()];
}

/** Only the coordinator's captured endpoint is accepted. No redirect or ambient-world fallback. */
export async function worldRequest(url: string, method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/mcp(?:\/[0-9a-f]{64})?$/.test(parsed.pathname)) throw new ConfinementError();
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error("The prepared world-query endpoint is no longer available.");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 2 * 1024 * 1024) { await response.body?.cancel(); throw new Error("World-query response exceeds the session limit."); }
  if (!response.body) throw new Error("World-query returned no response.");
  const chunks: Uint8Array[] = []; let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error("World-query response exceeds the session limit.");
    chunks.push(chunk);
  }
  const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (body.error) throw new Error("The prepared world-query request was refused.");
  return object(body.result);
}

export async function discoverWorldTools(session: ToolSession, signal?: AbortSignal): Promise<void> {
  if (!session.worldQueryUrl || !permits(session.confinement, "world-query")) return;
  const response = await worldRequest(session.worldQueryUrl, "tools/list", {}, signal);
  if (!Array.isArray(response.tools)) throw new Error("World-query returned an invalid tool catalog.");
  for (const raw of response.tools) {
    const tool = object(raw);
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name) || typeof tool.description !== "string") throw new Error("World-query returned an invalid tool.");
    if (tool.name === "fetch_url" && !permits(session.confinement, "web")) continue;
    const name = `world_${tool.name}`;
    session.worldTools.set(name, { type: "function", name, description: tool.description, inputSchema: object(tool.inputSchema) });
  }
}

function argument(args: JsonObject, name: string): string {
  const value = args[name]; if (typeof value !== "string") throw new Error(`The ${name} argument must be text.`); return value;
}
function bounded(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid text range or result limit.");
  return value;
}
function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { validatePng(bytes); return "image/png"; }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}
function validatePng(bytes: Buffer): void {
  // A signature alone accepted a corrupt PNG in the real protocol smoke: Codex replaced its
  // image with "could not be processed", after a read receipt had already been recorded.
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const invalid = () => { throw new Error("The PNG image is corrupt or exceeds the image limit."); };
  let offset = 8; let ended = false; let header: Buffer | null = null; const imageData: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const kind = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid();
    if (offset === 8 && (kind !== "IHDR" || length !== 13)) invalid();
    if (kind === "IHDR") { if (header || length !== 13) invalid(); header = data; }
    if (kind === "IDAT") imageData.push(data);
    offset = end;
    if (kind === "IEND") { if (length !== 0 || offset !== bytes.length) invalid(); ended = true; break; }
  }
  if (!header || !ended || imageData.length === 0) return invalid();
  const width = header.readUInt32BE(0); const height = header.readUInt32BE(4); const depth = header[8]!;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[header[9]!];
  if (!width || !height || width * height > 32_000_000 || !channels || ![1, 2, 4, 8, 16].includes(depth) || header[10] !== 0 || header[11] !== 0 || header[12]! > 1) invalid();
  const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: 128 * 1024 * 1024 });
  if (header[12] === 0 && inflated.length !== height * (1 + Math.ceil(width * channels! * depth / 8))) invalid();
}
async function readBytes(root: string, raw: string): Promise<Buffer> {
  const path = await confinedPath(root, raw);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE) throw new Error("This file cannot be read by the session (not a regular file or over 16 MB).");
    // Bound the read itself, since another writer may grow a file after the stat.
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, total);
      total += bytesRead; if (total > MAX_FILE) throw new Error("This file exceeds the session read limit.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

async function writeText(root: string, raw: string, content: string, signal: AbortSignal): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE) throw new Error("The proposed file exceeds 16 MB.");
  const path = await confinedPath(root, raw, true);
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  await confinedPath(root, raw, true);
  signal.throwIfAborted();
  const temporary = join(dirname(path), `.arke-codex-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    signal.throwIfAborted(); await handle.writeFile(content, "utf8");
    await handle.close();
    await confinedPath(root, raw, true); signal.throwIfAborted();
    // Replace atomically: interruption must not leave an existing proposal file truncated.
    await rename(temporary, path);
  } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
}

const rootQueues = new Map<string, Promise<void>>();
export async function executeTool(session: ToolSession, name: string, args: JsonObject, signal: AbortSignal): Promise<ExecutedTool> {
  // The whole edit read/replace is one operation, including across sessions sharing a proposal.
  // Reads queue too, so a parallel tool cannot observe half a mutation or an intermediate file.
  const key = process.platform === "win32" ? session.root.toLowerCase() : session.root;
  const work = (rootQueues.get(key) ?? Promise.resolve()).then(() => executeOneTool(session, name, args, signal));
  const settled = work.then(() => {}, () => {}); rootQueues.set(key, settled);
  try { return await work; } finally { if (rootQueues.get(key) === settled) rootQueues.delete(key); }
}

async function executeOneTool(session: ToolSession, name: string, args: JsonObject, signal: AbortSignal): Promise<ExecutedTool> {
  signal.throwIfAborted();
  const definition = toolsFor(session).find(tool => tool.name === name);
  if (!definition) throw new ConfinementError();
  const allowed = Object.keys(object(definition.inputSchema.properties));
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new ConfinementError();
  if (session.worldTools.has(name)) {
    if (!session.worldQueryUrl) throw new ConfinementError();
    const result = await worldRequest(session.worldQueryUrl, "tools/call", { name: name.slice(6), arguments: args }, signal);
    signal.throwIfAborted();
    if (!Array.isArray(result.content) || result.content.some(item => object(item).type !== "text" || typeof object(item).text !== "string")) throw new Error("World-query returned unsupported content.");
    return { result: { success: result.isError !== true, contentItems: result.content.map(item => ({ type: "inputText", text: object(item).text as string })) }, ...(result.isError === true ? {} : { summary: `read the world: ${name.slice(6).replaceAll("_", " ")}` }) };
  }
  if (name === "read") {
    const raw = argument(args, "path"); const bytes = await readBytes(session.root, raw); signal.throwIfAborted();
    const mime = imageType(bytes);
    if (mime && session.inputModalities && !session.inputModalities.includes("image")) throw new Error("This model does not accept image input.");
    if (mime) return { result: { success: true, contentItems: [{ type: "inputText", text: `Read image ${basename(raw)}.` }, { type: "inputImage", imageUrl: `data:${mime};base64,${bytes.toString("base64")}` }] }, summary: `read ${basename(raw)}` };
    if (bytes.includes(0)) throw new Error("This binary format cannot be read as text or an image.");
    const source = bytes.toString("utf8"); const offset = bounded(args.offset, 0, source.length); const limit = bounded(args.limit, MAX_TEXT, MAX_TEXT, 1);
    return { result: textResult(source.slice(offset, offset + limit) + (offset + limit < source.length ? `\n[More text remains; continue at offset ${offset + limit}.]` : "")), summary: `read ${basename(raw)}` };
  }
  if (name === "list") {
    const path = await confinedPath(session.root, args.path === undefined ? "." : argument(args, "path"));
    const entries = await readdir(path, { withFileTypes: true }); signal.throwIfAborted();
    return { result: textResult(entries.filter(entry => !entry.isSymbolicLink()).slice(0, 1000).map(entry => entry.name + (entry.isDirectory() ? "/" : "")).join("\n")), summary: "listed the proposal" };
  }
  if (name === "search") {
    const query = argument(args, "query"); if (!query || query.length > 1000) throw new Error("Search needs 1 to 1000 characters.");
    const limit = bounded(args.limit, 30, 100, 1); const found: string[] = [];
    const start = await confinedPath(session.root, args.path === undefined ? "." : argument(args, "path"));
    let examined = 0;
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        signal.throwIfAborted(); if (++examined > 3000 || found.length >= limit) return;
        if (entry.isSymbolicLink()) continue;
        const target = await confinedPath(session.root, join(path, entry.name));
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && (await lstat(target)).size <= 1024 * 1024) {
          const bytes = await readBytes(session.root, target); if (bytes.includes(0) || imageType(bytes)) continue;
          const lines = bytes.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && found.length < limit; i++) if (lines[i]!.includes(query)) found.push(`${relative(session.root, target)}:${i + 1}: ${lines[i]!.slice(0, 1000)}`);
        }
      }
    };
    await walk(start);
    return { result: textResult(found.join("\n") + (found.length >= limit || examined > 3000 ? "\n[Search limit reached.]" : "")), summary: "searched the proposal" };
  }
  const raw = argument(args, "path"); let content: string;
  if (name === "edit") {
    const original = (await readBytes(session.root, raw)).toString("utf8"); const old = argument(args, "oldText");
    if (!old || original.indexOf(old) < 0 || original.indexOf(old) !== original.lastIndexOf(old)) throw new Error("Edit needs exactly one matching passage.");
    content = original.replace(old, () => argument(args, "newText"));
  } else content = argument(args, "content");
  signal.throwIfAborted(); await writeText(session.root, raw, content, signal);
  return { result: textResult(`Updated ${basename(raw)}.`), summary: `edited ${basename(raw)}` };
}
