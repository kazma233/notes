/**
 * pi 桥接扩展：读取全局 mcp.json 与项目 .pi/mcp.json，合并后把每个 MCP Server 的工具注册为 pi 工具。
 *
 * 配置来源：
 * - 全局：~/.pi/mcp.json（agent 目录的上一级），始终读取（属于用户自身环境）。
 * - 项目：<cwd>/.pi/mcp.json，仅在项目受信任时读取（仓库可控）。
 * - 同名 Server 项目覆盖全局；项目条目 enabled: false 可显式禁用继承的全局 Server。
 *
 * 配置格式（与 Codex config.toml 的 MCP Server 语义一致，遵循 MCP 标准）：
 * {
 *   "mcpServers": {
 *     "tapd": { "command": "uvx", "args": ["mcp-server-tapd"], "env": { "TAPD_ACCESS_TOKEN": "${TAPD_ACCESS_TOKEN}" }, "idleTimeout": 10 },
 *     "db_mcp": { "url": "http://localhost:8320/mcp", "headers": {} }
 *   }
 * }
 *
 * env / headers 的值支持 ${VAR} 插值，避免把密钥明文写进配置文件。
 *
 * 工具命名规则：mcp__{server}__{tool}，LLM 调它即转发到对应 MCP Server 的 tools/call。
 *
 * 说明：
 * - 支持两种 transport：stdio（command/args/env/cwd）与 streamable HTTP（url、headers）。
 * - 在 session_start 时连接所有 Server 并注册工具；失败的单 Server 跳过，不影响其他。
 * - /mcp 命令列出各 Server 的连接状态与工具数，便于排查。
 * - 密钥只在 spawn 子进程环境 / HTTP header 中使用，绝不打印到日志或返回给模型。
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

// 请求超时：MCP Server 可能执行较久，默认 5 分钟。
const REQUEST_TIMEOUT_MS = 300_000;
// 连接（spawn/握手/拉取工具列表）单 Server 超时，避免拖慢启动。
const CONNECT_TIMEOUT_MS = 30_000;
// 会话结束时最多等待 5 秒释放远端 HTTP session，避免收尾阶段被服务端卡住。
const CLOSE_TIMEOUT_MS = 5_000;
// /mcp 仅保留有限的状态信息，防止异常 Server 用日志持续占用会话内存。
const MAX_LOG_ENTRIES = 200;
// MCP 协议版本：与主流 SDK 及 tapd/db_mcp 等 Server 兼容。
const PROTOCOL_VERSION = "2025-06-18";
// 连接无调用达到该时长后释放，下一次工具调用会重新建立连接。
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// 连接失败采用有上限的指数退避，避免 Server 异常时持续拉起进程/请求。
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
// 单次工具结果的模型可见文本上限，防止异常 Server 膨胀上下文与会话文件。
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const MAX_BINARY_RESOURCE_BYTES = 10 * 1024 * 1024;

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** 空闲回收时间，单位分钟；0 表示不回收。 */
  idleTimeout?: number;
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string };
}

/** 已连接的 Server 及其实际注册工具数（撞名或无效工具名会被跳过，因此可能少于 Server 声明的数量）。 */
interface RegisteredClient {
  config: McpServerConfig;
  client: McpClient | null;
  toolCount: number;
  toolNames: Set<string>;
  status: "connecting" | "connected" | "disconnected" | "idle" | "closed";
  lastUsedAt: number;
  retryAttempt: number;
  retryTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  connectPromise?: Promise<boolean>;
  inFlight: number;
  stopping: boolean;
}

/** MCP inputSchema 本身就是 JSON Schema，原样保留可避免桥接层丢失引用和约束。 */
function jsonSchemaToTypeBox(schema: unknown): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return Type.Any();
  return Type.Unsafe(schema);
}

/** 工具名/服务名清理：仅保留字母数字下划线。 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function makeToolName(server: string, tool: string): string {
  const serverName = sanitizeName(server);
  const toolName = sanitizeName(tool);
  if (!serverName || !toolName) return "";
  return `mcp__${serverName}__${toolName}`;
}

/** 把配置里的 ${VAR} 展开为 pi 进程环境变量值；未定义直接报错，避免带空凭据启动。 */
function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => {
    if (env[key] === undefined) throw new Error(`环境变量 ${key} 未设置`);
    return env[key]!;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) return false;
  return (value.command === undefined || typeof value.command === "string")
    && (value.args === undefined || (Array.isArray(value.args) && value.args.every((item) => typeof item === "string")))
    && (value.env === undefined || isStringRecord(value.env))
    && (value.cwd === undefined || typeof value.cwd === "string")
    && (value.url === undefined || typeof value.url === "string")
    && (value.headers === undefined || isStringRecord(value.headers))
    && (value.enabled === undefined || typeof value.enabled === "boolean")
    && (value.idleTimeout === undefined || (typeof value.idleTimeout === "number" && Number.isFinite(value.idleTimeout) && value.idleTimeout >= 0));
}

/**
 * 补齐 Server 运行目录。相对 cwd 与缺省 cwd 都基于当前项目根解析，
 * 这样全局配置里的 Server 也能感知当前项目。
 */
function resolveServerConfig(config: McpServerConfig, projectCwd: string): McpServerConfig {
  return {
    ...config,
    cwd: config.cwd ? resolve(projectCwd, config.cwd) : projectCwd,
  };
}

/** 读取并校验一份 MCP 配置；失败只记日志并返回 null，避免单个坏文件影响其他配置源。 */
async function loadMcpServers(
  configPath: string,
  appendLog: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    appendLog(`读取 ${configPath} 失败: ${String(error)}`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      throw new Error("需包含对象类型的 mcpServers");
    }
    return parsed.mcpServers;
  } catch (error) {
    appendLog(`${configPath} 配置无效: ${String(error)}`);
    return null;
  }
}

// ---------- Transport：屏蔽 stdio 与 HTTP 差异，统一 request/notify/close ----------
interface McpTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): void;
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
  onclose?: () => void;
  onnotification?: (method: string, params: unknown) => void;
}

class StdioTransport implements McpTransport {
  onclose?: () => void;
  onnotification?: (method: string, params: unknown) => void;
  private child!: ChildProcess;
  private rl: ReturnType<typeof createInterface>;
  private nextId = 0;
  private failure: Error | null = null;
  private closeNotified = false;
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();

  constructor(private cfg: McpServerConfig) {}

  async start(): Promise<void> {
    const env = { ...process.env, ...Object.fromEntries(
      Object.entries(this.cfg.env ?? {}).map(([key, value]) => [key, expandEnv(value)]),
    ) };
    this.child = spawn(this.cfg.command!, this.cfg.args ?? [], {
      env, stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cfg.cwd || undefined,
    });
    this.rl = createInterface({ input: this.child.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    // stderr 必须持续消费，否则管道缓冲写满会阻塞 Server 进程；内容不记录，避免泄露敏感信息。
    this.child.stderr!.on("data", () => {});
    this.child.on("error", (error) => this.fail(new Error(`stdio 启动失败: ${error.message}`)));
    this.child.stdin!.on("error", (error) => this.fail(new Error(`stdio 写入失败: ${error.message}`)));
    this.child.on("exit", (code, sig) => {
      this.fail(new Error(`stdio exited (code=${code}, signal=${sig})`));
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.onclose?.();
    }
    for (const id of this.pending.keys()) this.rejectPending(id, error);
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    pending.reject(error);
  }

  private resolvePending(id: number, value: any): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    pending.resolve(value);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (typeof msg.method === "string") {
      this.onnotification?.(msg.method, msg.params);
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      if (msg.error) this.rejectPending(msg.id, new Error(msg.error?.message || "MCP error"));
      else this.resolvePending(msg.id, msg.result);
    }
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new Error(`请求已取消: ${method}`));
    const id = ++this.nextId;
    const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(id, new Error(`timeout: ${method} > ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.notify("notifications/cancelled", { requestId: id, reason: `请求已取消: ${method}` });
        this.rejectPending(id, new Error(`请求已取消: ${method}`));
      };
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (!this.child.stdin?.writable) throw new Error("stdio 输入流不可写");
        this.child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (this.failure || !this.child.stdin?.writable) return;
    try { this.child.stdin.write(JSON.stringify(payload) + "\n"); } catch { /* 会在后续请求中暴露连接失败 */ }
  }

  async close(): Promise<void> {
    this.closeNotified = true;
    this.fail(new Error("MCP stdio transport 已关闭"));
    this.rl?.close();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

class StreamableHttpTransport implements McpTransport {
  onclose?: () => void;
  onnotification?: (method: string, params: unknown) => void;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 0;

  constructor(private url: string, private headers: Record<string, string>) {}

  private requestHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private parseSse(text: string): any[] {
    // SSE 可能含多条 event（message/close 等），按空行分块，每条 data 单独解析为一个 JSON。
    const events: any[] = [];
    let data: string[] = [];
    const flush = () => {
      if (data.length) {
        const joined = data.join("\n");
        try { events.push(JSON.parse(joined)); } catch { /* 丢弃损坏的 data */ }
        data = [];
      }
    };
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") { flush(); continue; }
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
      else if (line.startsWith("event:")) flush();
    }
    flush();
    return events;
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
    const id = ++this.nextId;
    const body = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        this.notify("notifications/cancelled", { requestId: id, reason: `请求已取消: ${method}` });
        throw new Error(`请求已取消: ${method}`);
      }
      throw error;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    let msgs: any[];
    try {
      msgs = contentType.includes("text/event-stream") ? this.parseSse(text) : [JSON.parse(text)];
    } catch (e) {
      throw new Error(`HTTP 响应解析失败: ${String(e)}`);
    }
    for (const notification of msgs) {
      if (notification && typeof notification.method === "string") {
        this.onnotification?.(notification.method, notification.params);
      }
    }
    const msg = msgs.find((m) => m && m.id === id);
    if (!msg) throw new Error("HTTP 响应无匹配 JSON-RPC 消息");
    if (msg.error) throw new Error(msg.error?.message || "MCP error");
    return msg.result;
  }

  notify(method: string, params?: unknown): void {
    void fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {});
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
    } catch {
      // HTTP Server 可不支持 DELETE；关闭是资源回收的尽力而为操作。
    } finally {
      this.sessionId = null;
    }
  }
}

// ---------- MCP Client：握手 + 工具列表 + 调用 ----------
class McpClient {
  private tools: McpTool[] = [];

  onclose?: () => void;
  onnotification?: (method: string, params: unknown) => void;

  constructor(private transport: McpTransport) {
    transport.onclose = () => this.onclose?.();
    transport.onnotification = (method, params) => this.onnotification?.(method, params);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const result = await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
    }, signal);
    if (typeof result?.protocolVersion !== "string") {
      throw new Error("initialize 响应缺少协商后的 protocolVersion");
    }
    this.transport.setProtocolVersion?.(result.protocolVersion);
    this.transport.notify("notifications/initialized");
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await this.transport.request("tools/list", cursor ? { cursor } : undefined, signal);
      all.push(...(res.tools ?? []));
      cursor = res.nextCursor ?? undefined;
    } while (cursor);
    this.tools = all;
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return this.transport.request("tools/call", { name, arguments: args }, signal);
  }

  close(): Promise<void> { return this.transport.close(); }
}

type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function limitOutputText(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const lines = value.split(/\r?\n/);
  let limited = lines.length > MAX_OUTPUT_LINES
    ? `${lines.slice(0, MAX_OUTPUT_LINES).join("\n")}\n[输出已按行数截断]`
    : value;
  if (Buffer.byteLength(limited, "utf8") <= maxBytes) return limited;

  let end = Math.min(limited.length, maxBytes);
  while (end > 0 && Buffer.byteLength(limited.slice(0, end), "utf8") > Math.max(0, maxBytes - 32)) end--;
  limited = `${limited.slice(0, end)}\n[输出已按字节数截断]`;
  return limited;
}

/** 保留 MCP 原生文本/图片内容；无法映射到 Pi 的资源类型时只返回安全的引用信息。 */
function mcpContentToPiContent(
  content: unknown,
  structuredContent?: unknown,
  materializeResource?: (blob: string, mimeType: string) => string | null,
): PiToolContent[] {
  const result: PiToolContent[] = [];
  let textBytes = 0;
  const boundedText = (value: string): string => {
    const remaining = MAX_OUTPUT_BYTES - textBytes;
    if (remaining <= 0) return "";
    const next = limitOutputText(value, remaining);
    textBytes += Buffer.byteLength(next, "utf8");
    return next;
  };
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const it = item as any;
      if (it.type === "text") {
        const text = boundedText(String(it.text ?? ""));
        if (text) result.push({ type: "text", text });
      } else if (it.type === "image" && typeof it.data === "string") {
        const mimeType = String(it.mimeType ?? "application/octet-stream");
        if (Buffer.byteLength(it.data, "base64") <= MAX_BINARY_RESOURCE_BYTES) {
          result.push({ type: "image", data: it.data, mimeType });
        } else {
          const path = materializeResource?.(it.data, mimeType);
          result.push({ type: "text", text: path ? `[image 已保存到文件] ${path}` : "[image 过大，已省略]" });
        }
      } else if (it.type === "resource") {
        const resource = it.resource ?? {};
        if (typeof resource.blob === "string") {
          const mimeType = String(resource.mimeType ?? "application/octet-stream");
          if (mimeType.startsWith("image/") && Buffer.byteLength(resource.blob, "base64") <= MAX_BINARY_RESOURCE_BYTES) {
            result.push({ type: "image", data: resource.blob, mimeType });
          } else {
            const path = materializeResource?.(resource.blob, mimeType);
            result.push({ type: "text", text: path ? `[resource 已保存到文件] ${path}` : "[resource 二进制内容过大，已省略]" });
          }
        } else {
          const uri = resource.uri ? `\nURI: ${String(resource.uri)}` : "";
          const text = typeof resource.text === "string" ? `\n${resource.text}` : "";
          const resourceText = boundedText(`[resource]${uri}${text}`);
          if (resourceText) result.push({ type: "text", text: resourceText });
        }
      } else if (it.type === "resource_link") {
        const linkText = boundedText(`[resource_link] ${String(it.uri ?? it.name ?? "unknown")}`);
        if (linkText) result.push({ type: "text", text: linkText });
      } else {
        const otherText = boundedText(JSON.stringify(it) ?? "");
        if (otherText) result.push({ type: "text", text: otherText });
      }
    }
  }
  if (result.length === 0 && structuredContent !== undefined) {
    const structuredText = boundedText(JSON.stringify(structuredContent) ?? "");
    if (structuredText) result.push({ type: "text", text: structuredText });
  }
  return result.length > 0 ? result : [{ type: "text", text: "（空响应）" }];
}

function mcpContentToText(content: unknown, structuredContent?: unknown): string {
  return mcpContentToPiContent(content, structuredContent)
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n") || "（返回了图片内容）";
}

function boundStructuredContent(value: unknown): unknown {
  if (value === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    return { truncated: true, reason: "structuredContent 无法序列化" };
  }
  if (Buffer.byteLength(serialized, "utf8") <= 16 * 1024) return value;
  return {
    truncated: true,
    reason: "structuredContent 超过 16 KiB，已省略原始内容",
    preview: limitOutputText(serialized, 2 * 1024),
  };
}

export default function (pi: ExtensionAPI) {
  const clients = new Map<string, RegisteredClient>();
  const log: string[] = [];
  let shuttingDown = false;
  let resourceDir: string | undefined;
  let resourceSequence = 0;
  const resourceFiles = new Set<string>();

  const appendLog = (message: string): void => {
    log.push(message);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  };

  const materializeResource = (blob: string, mimeType: string): string | null => {
    const bytes = Buffer.byteLength(blob, "base64");
    if (bytes > MAX_BINARY_RESOURCE_BYTES) return null;
    try {
      resourceDir ??= mkdtempSync(join(tmpdir(), "pi-mcp-resource-"));
      const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "") || "bin";
      const path = join(resourceDir, `resource-${++resourceSequence}.${extension}`);
      writeFileSync(path, Buffer.from(blob, "base64"), { flag: "wx", mode: 0o600 });
      resourceFiles.add(path);
      return path;
    } catch (error) {
      appendLog(`MCP resource 保存失败: ${String(error)}`);
      return null;
    }
  };

  const cleanupResources = (): void => {
    for (const path of resourceFiles) {
      try { unlinkSync(path); } catch { /* 临时文件可能已被用户移走 */ }
    }
    resourceFiles.clear();
    if (resourceDir) {
      try { rmdirSync(resourceDir); } catch { /* 目录非空时保留，避免误删其他文件 */ }
      resourceDir = undefined;
    }
  };

  const registeredToolNames = new Set<string>();
  const idleTimeoutMs = (entry: RegisteredClient): number => entry.config.idleTimeout === undefined
    ? DEFAULT_IDLE_TIMEOUT_MS
    : entry.config.idleTimeout * 60 * 1000;
  const clearIdleTimer = (entry: RegisteredClient): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  };
  const clearRetryTimer = (entry: RegisteredClient): void => {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  };

  const scheduleIdleReclaim = (name: string, entry: RegisteredClient): void => {
    clearIdleTimer(entry);
    const timeout = idleTimeoutMs(entry);
    if (timeout <= 0 || entry.status !== "connected") return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (shuttingDown || entry.status !== "connected") return;
      if (entry.inFlight > 0 || Date.now() - entry.lastUsedAt < timeout) {
        scheduleIdleReclaim(name, entry);
        return;
      }
      void disconnectServer(name, entry, "空闲回收", false);
    }, timeout);
    entry.idleTimer.unref();
  };

  const scheduleReconnect = (name: string, entry: RegisteredClient): void => {
    if (shuttingDown || entry.stopping || entry.retryTimer || entry.status === "closed") return;
    const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(entry.retryAttempt, 6));
    entry.retryAttempt++;
    appendLog(`[${name}] 将在 ${Math.ceil(delay / 1000)} 秒后重连（第 ${entry.retryAttempt} 次）`);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      void connectServer(name, entry);
    }, delay);
    entry.retryTimer.unref();
  };

  async function disconnectServer(name: string, entry: RegisteredClient, reason: string, reconnect: boolean): Promise<void> {
    clearIdleTimer(entry);
    clearRetryTimer(entry);
    const oldClient = entry.client;
    entry.client = null;
    entry.status = reconnect ? "disconnected" : "idle";
    if (oldClient) {
      entry.stopping = true;
      await oldClient.close().catch((error) => appendLog(`[${name}] 关闭连接失败: ${String(error)}`));
      entry.stopping = false;
    }
    appendLog(`[${name}] ${reason}`);
    if (reconnect) scheduleReconnect(name, entry);
  }

  function registerServerTools(name: string, entry: RegisteredClient, tools: McpTool[]): void {
    for (const tool of tools) {
      const toolName = makeToolName(name, tool.name);
      if (!toolName) {
        appendLog(`[${name}] 工具名无有效字符，已跳过`);
        continue;
      }
      if (entry.toolNames.has(toolName)) continue;
      if (registeredToolNames.has(toolName)) {
        entry.toolNames.add(toolName);
        continue;
      }
      const label = tool.title || tool.annotations?.title || tool.name;
      const description = tool.description || label;
      const serverName = name;
      const rawToolName = tool.name;
      try {
        pi.registerTool({
          name: toolName,
          label: `${label} (${serverName})`,
          description: `${description}\n\n[由 MCP Server \"${serverName}\" 桥接提供]`,
          parameters: jsonSchemaToTypeBox(tool.inputSchema ?? {}),
          async execute(_toolCallId, params, signal, _onUpdate) {
            if (signal?.aborted) throw new Error(`MCP Server \"${serverName}\" 工具 \"${rawToolName}\" 已取消`);
            const current = clients.get(serverName);
            if (!current) throw new Error(`MCP Server \"${serverName}\" 未初始化`);
            const client = await ensureConnected(serverName, current);
            if (!client) throw new Error(`MCP Server \"${serverName}\" 当前不可用，稍后会自动重连`);
            current.lastUsedAt = Date.now();
            current.inFlight++;
            try {
              let res: any;
              try {
                res = await client.callTool(rawToolName, (params as Record<string, unknown>) ?? {}, signal);
              } catch (error) {
                if (!signal?.aborted && current.client === client) {
                  void disconnectServer(serverName, current, `连接失效: ${String(error)}`, true);
                }
                throw error;
              }
              const content = mcpContentToPiContent(res?.content, res?.structuredContent, materializeResource);
              if (res?.isError) throw new Error(mcpContentToText(res?.content, res?.structuredContent) || "MCP 工具执行失败");
              return { content, details: { structuredContent: boundStructuredContent(res?.structuredContent) } };
            } catch (error) {
              throw new Error(`请求 MCP Server \"${serverName}\" 工具 \"${rawToolName}\" 失败: ${String(error)}`);
            } finally {
              current.inFlight--;
              current.lastUsedAt = Date.now();
              scheduleIdleReclaim(serverName, current);
            }
          },
        });
        registeredToolNames.add(toolName);
        entry.toolNames.add(toolName);
      } catch (error) {
        appendLog(`[${name}] 注册工具 ${toolName} 失败: ${String(error)}`);
      }
    }
    entry.toolCount = entry.toolNames.size;
  }

  async function refreshServerTools(name: string, entry: RegisteredClient, client: McpClient): Promise<void> {
    if (entry.client !== client || entry.status !== "connected") return;
    try {
      const tools = await client.listTools();
      if (entry.client !== client || entry.status !== "connected") return;
      registerServerTools(name, entry, tools);
      appendLog(`[${name}] 工具目录已刷新，共 ${tools.length} 个工具`);
    } catch (error) {
      if (entry.client === client) await disconnectServer(name, entry, `工具目录刷新失败: ${String(error)}`, true);
    }
  }

  async function connectServer(name: string, entry: RegisteredClient): Promise<boolean> {
    if (shuttingDown || entry.status === "closed") return false;
    if (entry.connectPromise) return entry.connectPromise;
    clearRetryTimer(entry);
    entry.status = "connecting";
    const connectPromise = (async (): Promise<boolean> => {
      let transport: McpTransport | null = null;
      let client: McpClient | null = null;
      const connectController = new AbortController();
      const timeoutId = setTimeout(() => connectController.abort(), CONNECT_TIMEOUT_MS);
      timeoutId.unref();
      try {
        const cfg = entry.config;
        if (cfg.command && cfg.command.trim()) {
          const stdioTransport = new StdioTransport(cfg);
          await stdioTransport.start();
          transport = stdioTransport;
        } else if (cfg.url && cfg.url.trim()) {
          const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
          transport = new StreamableHttpTransport(cfg.url, headers);
        } else {
          throw new Error("Server 需配置 command 或 url");
        }
        client = new McpClient(transport);
        entry.client = client;
        client.onclose = () => {
          if (!entry.stopping && entry.client === client) void disconnectServer(name, entry, "连接已断开", true);
        };
        client.onnotification = (method) => {
          if (method === "notifications/tools/list_changed") void refreshServerTools(name, entry, client!);
        };
        await client.initialize(connectController.signal);
        const tools = await client.listTools(connectController.signal);
        if (entry.client !== client) return false;
        entry.status = "connected";
        entry.retryAttempt = 0;
        entry.lastUsedAt = Date.now();
        registerServerTools(name, entry, tools);
        scheduleIdleReclaim(name, entry);
        appendLog(`[${name}] 连接成功，注册 ${entry.toolCount} 个工具`);
        return true;
      } catch (error) {
        if (entry.client === client) entry.client = null;
        entry.status = "disconnected";
        if (transport) await transport.close().catch(() => {});
        appendLog(`[${name}] 连接失败: ${String(error)}`);
        scheduleReconnect(name, entry);
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    entry.connectPromise = connectPromise;
    try {
      return await connectPromise;
    } finally {
      if (entry.connectPromise === connectPromise) entry.connectPromise = undefined;
    }
  }

  async function ensureConnected(name: string, entry: RegisteredClient): Promise<McpClient | null> {
    if (entry.status === "connected" && entry.client) {
      entry.lastUsedAt = Date.now();
      scheduleIdleReclaim(name, entry);
      return entry.client;
    }
    clearRetryTimer(entry);
    const connected = await connectServer(name, entry);
    return connected ? entry.client : null;
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    const previous = [...clients.entries()];
    clients.clear();
    await Promise.allSettled(previous.map(([name, entry]) => disconnectServer(name, entry, "会话重启关闭", false)));
    const globalConfigPath = join(dirname(getAgentDir()), "mcp.json");
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json");

    // 全局配置属于用户自身环境，始终读取；项目配置可被仓库控制，只在项目受信任时读取。
    const sources = [{ path: globalConfigPath, label: "全局" }];
    if (ctx.isProjectTrusted()) {
      sources.push({ path: projectConfigPath, label: "项目" });
    } else if (existsSync(projectConfigPath)) {
      appendLog(`项目未受信任，已跳过 ${projectConfigPath}。`);
    }

    if (sources.every((source) => !existsSync(source.path))) {
      appendLog(`未找到 MCP 配置（${globalConfigPath} 或 ${projectConfigPath}），未注册任何 MCP 工具。`);
      return;
    }

    // 同名 Server 项目覆盖全局；项目条目 enabled: false 可显式禁用继承的全局 Server。
    const servers = new Map<string, McpServerConfig>();
    for (const source of sources) {
      if (!existsSync(source.path)) continue;
      const declared = await loadMcpServers(source.path, appendLog);
      if (!declared) continue;
      let count = 0;
      for (const [name, value] of Object.entries(declared)) {
        if (!isMcpServerConfig(value)) {
          appendLog(`[${name}] 配置字段类型无效，已跳过`);
          continue;
        }
        if (value.enabled === false) {
          servers.delete(name);
          appendLog(`[${name}] 在${source.label}配置中被禁用`);
          continue;
        }
        servers.set(name, resolveServerConfig(value, ctx.cwd));
        count++;
      }
      appendLog(`配置来源：${source.path}（${count} 个 Server）`);
    }

    const entries = [...servers.entries()];
    if (entries.length === 0) {
      appendLog("配置中没有可用的 MCP Server。");
      return;
    }

    for (const [name, config] of entries) {
      clients.set(name, {
        config,
        client: null,
        toolCount: 0,
        toolNames: new Set(),
        status: "disconnected",
        lastUsedAt: Date.now(),
        retryAttempt: 0,
        inFlight: 0,
        stopping: false,
      });
    }
    await Promise.all([...clients.entries()].map(([name, entry]) => connectServer(name, entry)));

  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const closing = [...clients.entries()];
    clients.clear();
    await Promise.allSettled(closing.map(async ([name, entry]) => {
      entry.status = "closed";
      clearIdleTimer(entry);
      clearRetryTimer(entry);
      if (entry.client) await entry.client.close().catch((error) => appendLog(`[${name}] 关闭连接失败: ${String(error)}`));
      appendLog(`[${name}] 已关闭`);
    }));
    cleanupResources();
  });

  pi.registerCommand("mcp", {
    description: "查看 MCP 桥接状态（连接的 Server、工具数与会话日志）",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      if (clients.size === 0) {
        lines.push("当前没有连接的 MCP Server。");
        if (log.length === 0) {
          lines.push(`检查全局 ${join(dirname(getAgentDir()), "mcp.json")} 或项目 ${join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json")}。`);
        }
      } else {
        const connected = [...clients.values()].filter((entry) => entry.status === "connected").length;
        const total = [...clients.values()].reduce((sum, entry) => sum + entry.toolCount, 0);
        lines.push(`MCP Server：${connected}/${clients.size} 已连接，共注册 ${total} 个工具`);
        for (const [name, entry] of clients) lines.push(`- ${name}: ${entry.status}，${entry.toolCount} 个工具`);
      }
      // 配置来源、跳过与失败原因单独成段，避免与状态行混在一起。
      if (log.length > 0) lines.push("", ...log);
      const report = lines.join("\n");
      // 命令的返回值会被 pi 丢弃，必须主动输出；无 UI 模式退回 stderr，避免污染 JSON 事件流。
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      else console.error(report);
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "重新连接 MCP Server；不指定名称时重新连接全部 Server",
    handler: async (args) => {
      const target = args.trim();
      const selected = target ? [[target, clients.get(target)] as const] : [...clients.entries()];
      for (const [name, entry] of selected) {
        if (!entry) {
          appendLog(`[${name}] 未找到 MCP Server`);
          continue;
        }
        await disconnectServer(name, entry, "手动断开并重连", false);
        entry.status = "disconnected";
        await connectServer(name, entry);
      }
    },
  });
}
