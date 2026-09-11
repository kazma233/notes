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
 *     "tapd": { "command": "uvx", "args": ["mcp-server-tapd"], "env": { "TAPD_ACCESS_TOKEN": "${TAPD_ACCESS_TOKEN}" } },
 *     "db_mcp": { "url": "http://localhost:8320/mcp", "headers": {} }
 *   }
 * }
 *
 * env / headers 的值支持 ${VAR} 从 pi 进程环境变量展开，避免把密钥明文写进配置文件。
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
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve, dirname } from "node:path";

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

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string };
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

/** 把配置里的 ${VAR} 展开为 pi 进程环境变量值；未定义则留空，避免把密钥明文写进配置。 */
function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => env[key] ?? "");
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
    && (value.enabled === undefined || typeof value.enabled === "boolean");
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
}

class StdioTransport implements McpTransport {
  private child!: ChildProcess;
  private rl: ReturnType<typeof createInterface>;
  private nextId = 0;
  private failure: Error | null = null;
  private stderrLogged = false;
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();

  constructor(private cfg: McpServerConfig, private onLog: (msg: string) => void) {}

  async start(): Promise<void> {
    const env = { ...process.env, ...Object.fromEntries(
      Object.entries(this.cfg.env ?? {}).map(([k, v]) => [k, expandEnv(v)]),
    ) };
    this.child = spawn(this.cfg.command!, this.cfg.args ?? [], {
      env, stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cfg.cwd || undefined,
    });
    this.rl = createInterface({ input: this.child.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    this.child.stderr!.on("data", () => {
      if (!this.stderrLogged) {
        this.stderrLogged = true;
        this.onLog("Server 输出了 stderr，内容已隐藏以避免泄露敏感信息");
      }
    });
    this.child.on("error", (error) => this.fail(new Error(`stdio 启动失败: ${error.message}`)));
    this.child.stdin!.on("error", (error) => this.fail(new Error(`stdio 写入失败: ${error.message}`)));
    this.child.on("exit", (code, sig) => {
      this.fail(new Error(`stdio exited (code=${code}, signal=${sig})`));
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
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
      const onAbort = () => this.rejectPending(id, new Error(`请求已取消: ${method}`));
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
    this.fail(new Error("MCP stdio transport 已关闭"));
    this.rl?.close();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

class StreamableHttpTransport implements McpTransport {
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
      if (signal?.aborted) throw new Error(`请求已取消: ${method}`);
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

  constructor(private transport: McpTransport) {}

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

/** 把 MCP 返回的 content 数组折叠成一段文本，供 pi 工具返回；图片/资源用占位描述。 */
function mcpContentToText(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const it = item as any;
    if (it.type === "text") parts.push(String(it.text ?? ""));
    else if (it.type === "image") parts.push(`[image: ${it.mimeType ?? "unknown"}]`);
    else if (it.type === "resource") parts.push(`[resource: ${it.resource?.uri ?? it.resource?.text ?? "unknown"}]`);
    else parts.push(JSON.stringify(it));
  }
  return parts.join("\n") || "（空响应）";
}

export default function (pi: ExtensionAPI) {
  const clients = new Map<string, McpClient>();
  const log: string[] = [];

  const appendLog = (message: string): void => {
    log.push(message);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  };

  pi.on("session_start", async (_event, ctx) => {
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
      appendLog(`来自 ${source.path}，共 ${count} 个 Server`);
    }

    const entries = [...servers.entries()];
    if (entries.length === 0) {
      appendLog("配置中没有可用的 MCP Server。");
      return;
    }

    // 单个 Server 连接超时：超时竞速跳过，不影响其他 Server。
    const results = await Promise.all(entries.map(async ([name, cfg]) => {
      let transport: McpTransport | null = null;
      const connectController = new AbortController();
      const connecting = (async (): Promise<{ client: McpClient; tools: McpTool[] }> => {
        if (cfg.command && cfg.command.trim()) {
          const t = new StdioTransport(cfg, (m) => appendLog(`[${name}] ${m}`));
          await t.start();
          transport = t;
        } else if (cfg.url && cfg.url.trim()) {
          const headers = Object.fromEntries(
            Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]),
          );
          transport = new StreamableHttpTransport(cfg.url, headers);
        } else {
          throw new Error("Server 需配置 command 或 url");
        }
        const client = new McpClient(transport);
        await client.initialize(connectController.signal);
        const tools = await client.listTools(connectController.signal);
        return { client, tools };
      })();
      let timeoutId: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          connectController.abort();
          reject(new Error(`连接超时 > ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);
        timeoutId.unref();
      });
      try {
        return { name, ...(await Promise.race([connecting, timeout])), error: null as Error | null };
      } catch (e) {
        connectController.abort();
        if (transport) await transport.close().catch(() => {});
        return { name, client: null as McpClient | null, tools: [] as McpTool[], error: e as Error };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }));

    // 冲突去重：sanitize 后可能撞名，后到的让位。
    const seen = new Set<string>();
    let registered = 0;
    for (const r of results) {
      const client = r.client;
      if (!client) {
        appendLog(`[${r.name}] 连接失败[跳过]: ${r.error?.message ?? "unknown"}`);
        continue;
      }
      clients.set(r.name, client);
      for (const tool of r.tools) {
        const toolName = makeToolName(r.name, tool.name);
        if (!toolName) {
          appendLog(`[${r.name}] 工具名无有效字符，已跳过`);
          continue;
        }
        if (seen.has(toolName)) {
          appendLog(`[${r.name}] 工具名冲突（${toolName}）已被其他 Server 占用，跳过`);
          continue;
        }
        seen.add(toolName);
        const label = tool.title || tool.annotations?.title || tool.name;
        const description = tool.description || label;
        const serverName = r.name; // 绑定到闭包，execute 用
        const rawToolName = tool.name;
        pi.registerTool({
          name: toolName,
          label: `${label} (${serverName})`,
          description: `${description}\n\n[由 MCP Server \"${serverName}\" 桥接提供]`,
          parameters: jsonSchemaToTypeBox(tool.inputSchema ?? {}),
          async execute(_toolCallId, params, signal, _onUpdate) {
            if (signal?.aborted) throw new Error(`MCP Server "${serverName}" 工具 "${rawToolName}" 已取消`);
            const c = clients.get(serverName);
            if (!c) throw new Error(`MCP Server "${serverName}" 已断开`);
            try {
              const res: any = await c.callTool(rawToolName, (params as Record<string, unknown>) ?? {}, signal);
              const text = mcpContentToText(res?.content);
              const details = { structuredContent: res?.structuredContent ?? null };
              if (res?.isError) {
                throw new Error(text || "MCP 工具执行失败");
              }
              return { content: [{ type: "text", text: text || "（空响应）" }], details };
            } catch (e) {
              throw new Error(`请求 MCP Server "${serverName}" 工具 "${rawToolName}" 失败: ${String(e)}`);
            }
          },
        });
        registered++;
      }
      appendLog(`[${r.name}] 连接成功，注册 ${r.tools.length} 个工具`);
    }
    appendLog(`MCP 桥接完成：共注册 ${registered} 个工具`);
  });

  pi.on("session_shutdown", async () => {
    const closing = [...clients.entries()];
    clients.clear();
    await Promise.allSettled(closing.map(async ([name, client]) => {
      await client.close();
      appendLog(`[${name}] 已关闭`);
    }));
  });

  pi.registerCommand("mcp", {
    description: "查看 MCP 桥接状态（连接的 Server、工具数与会话日志）",
    handler: async (_args, ctx) => {
      const lines = [...log];
      if (clients.size === 0) {
        lines.push(`当前没有连接的 MCP Server。检查全局 ${join(dirname(getAgentDir()), "mcp.json")} 或项目 ${join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json")}。`);
      }
      for (const [name] of clients) lines.push(`- ${name}: 已连接`);
      const report = lines.join("\n");
      // 命令的返回值会被 pi 丢弃，必须主动输出；无 UI 模式退回 stderr，避免污染 JSON 事件流。
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      else console.error(report);
    },
  });
}
