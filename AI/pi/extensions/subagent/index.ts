/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BackgroundTaskRegistry, type BackgroundTaskRecord } from "./background.ts";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentLine, formatAgentList } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_STDERR_BYTES = 50 * 1024;
const MAX_SUBAGENT_DEPTH = 1;
const MAX_LISTED_AGENTS = 50;
const TRUNCATION_MARKER_RESERVE = 160;
const SENSITIVE_ARGUMENT_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie)/i;
const TMP_PREFIX = "pi-subagent-";
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const BACKGROUND_TASK_ROOT = path.join(getAgentDir(), "subagent-tasks");

// 工具描述只在扩展加载时生成一次，会话中途增删 agent 文件要靠 /subagent:list 刷新
function describeAgents(agents: AgentConfig[]): string {
	const { text, remaining } = formatAgentList(agents, MAX_LISTED_AGENTS);
	const suffix = remaining > 0 ? ` (${remaining} more not listed)` : "";
	return `Available subagents: ${text}${suffix}.`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function appendCappedText(current: string, value: string, maxBytes: number): string {
	if (Buffer.byteLength(current, "utf8") >= maxBytes) return current;
	const remaining = maxBytes - Buffer.byteLength(current, "utf8");
	const next = Array.from(value).reduce((result, character) => {
		if (Buffer.byteLength(result + character, "utf8") > remaining) return result;
		return result + character;
	}, "");
	return current + next;
}

function getSubagentDepth(): number {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	return Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

function summarizeArgumentValue(key: string, value: unknown, maxLength = 48): string {
	if (SENSITIVE_ARGUMENT_PATTERN.test(key)) return "[redacted]";

	let text: string;
	if (typeof value === "string") text = JSON.stringify(value);
	else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function summarizeUnknownToolCall(toolName: string, args: Record<string, unknown>): string {
	const entries = Object.entries(args).map(([key, value]) => `${key}=${summarizeArgumentValue(key, value)}`);
	return entries.length > 0 ? `${toolName} ${entries.join(" ")}` : toolName;
}

function shortenPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "...";
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/((?:api[-_]?key|token|secret|password)\s*[=:]\s*)[^\s"']+/gi, "$1[redacted]");
}

function formatToolCallSummary(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const preview = command.length > 60 ? `${command.slice(0, 57)}...` : command;
			return `$ ${redactSensitiveText(preview)}`;
		}
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			return `read ${shortenPath(args.file_path ?? args.path)}${offset !== undefined || limit !== undefined ? `:${startLine}${endLine ? `-${endLine}` : ""}` : ""}`;
		}
		case "write": {
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			return `write ${shortenPath(args.file_path ?? args.path)}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit":
			return `edit ${shortenPath(args.file_path ?? args.path)}`;
		case "ls":
			return `ls ${shortenPath(args.path ?? ".")}`;
		case "find":
			return `find ${typeof args.pattern === "string" ? args.pattern : "*"} in ${shortenPath(args.path ?? ".")}`;
		case "grep":
			return `grep /${typeof args.pattern === "string" ? args.pattern : ""}/ in ${shortenPath(args.path ?? ".")}`;
		default:
			return summarizeUnknownToolCall(toolName, args);
	}
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	return themeFg("toolOutput", formatToolCallSummary(toolName, args));
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	exitSignal?: string;
	outputPath?: string;
	step?: number;
	started?: boolean;
	liveActivity?: ActivityItem[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		const output = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.filter((text) => text.trim().length > 0)
			.join("\n\n");
		return output;
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (result.exitCode !== -1 && result.exitCode !== 0) || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function countNewlines(input: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const next = input.indexOf("\n", from);
		if (next < 0) return count;
		count++;
		from = next + 1;
	}
}

/** UTF-8 byte length of one code point; matches Buffer.byteLength, lone surrogates included. */
function utf8LengthOfCodePoint(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}

/** Longest prefix of `input` that fits in `cap` UTF-8 bytes, never splitting a character. */
function takeUtf8PrefixWithinByteCap(input: string, cap: number): string {
	const chunks: string[] = [];
	let bytes = 0;
	for (const character of input) {
		const size = utf8LengthOfCodePoint(character);
		if (bytes + size > cap) break;
		chunks.push(character);
		bytes += size;
	}
	return chunks.join("");
}

function truncateOutput(
	output: string,
	maxBytes = PER_TASK_OUTPUT_CAP,
	maxLines = MAX_OUTPUT_LINES,
	fullOutputPath?: string,
): string {
	const originalBytes = Buffer.byteLength(output, "utf8");
	const originalLines = countNewlines(output) + 1;

	let truncated = output;
	if (originalLines > maxLines) {
		// Keep the first `maxLines` lines: cut at the maxLines-th newline.
		let cut = output.length;
		let from = 0;
		for (let line = 0; line < maxLines; line++) {
			const next = output.indexOf("\n", from);
			if (next < 0) {
				cut = output.length;
				break;
			}
			cut = next;
			from = next + 1;
		}
		truncated = output.slice(0, cut);
	}

	let truncatedBytes = Buffer.byteLength(truncated, "utf8");
	const contentMaxBytes = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE);
	if (truncatedBytes > contentMaxBytes) {
		truncated = takeUtf8PrefixWithinByteCap(truncated, contentMaxBytes);
		truncatedBytes = Buffer.byteLength(truncated, "utf8");
	}

	if (truncatedBytes === originalBytes && originalLines <= maxLines) return output;

	const omittedBytes = Math.max(0, originalBytes - truncatedBytes);
	const omittedLines = Math.max(0, originalLines - (countNewlines(truncated) + 1));
	const omitted = omittedLines > 0 ? `${omittedLines} lines` : `${omittedBytes} bytes`;
	const fullOutputNotice = fullOutputPath
		? `Full output saved to: ${fullOutputPath}. Use read to inspect it.`
		: "Full output is unavailable.";
	return `${truncated}\n\n[Output truncated: ${omitted} omitted. ${fullOutputNotice}]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

type ActivityItem = { kind: "tool" | "text"; text: string; key?: string };

function shortenActivityText(value: unknown, maxLength = 64): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeActivityText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function formatFullArgumentValue(key: string, value: unknown): string {
	if (SENSITIVE_ARGUMENT_PATTERN.test(key)) return "[redacted]";
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function getToolActivity(toolName: string, args: Record<string, any>): string {
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : "...";
		return `$ ${redactSensitiveText(command)}`;
	}
	const entries = Object.entries(args).map(([key, value]) => `${key}=${formatFullArgumentValue(key, value)}`);
	return entries.length > 0 ? `${toolName} ${entries.join(" ")}` : toolName;
}

function getActivityItems(messages: Message[]): ActivityItem[] {
	const items: ActivityItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as any[]) {
			if (part.type === "thinking") {
				const text = shortenActivityText(part.thinking);
				if (text) items.push({ kind: "text", text });
			} else if (part.type === "text") {
				const text = shortenActivityText(part.text);
				if (text) items.push({ kind: "text", text });
			} else if (part.type === "toolCall") {
				items.push({ kind: "tool", text: getToolActivity(part.name, part.arguments || {}) });
			}
		}
	}
	return items;
}

function getParallelActivityItems(result: SingleResult): ActivityItem[] {
	if (result.exitCode === -1 && result.liveActivity?.length) return result.liveActivity;
	return getActivityItems(result.messages);
}

function getParallelActivityLines(result: SingleResult): string[] {
	return getParallelActivityItems(result)
		.slice(-4)
		.map((item) => item.text);
}

function getParallelTaskStatus(result: SingleResult): { label: string; color: "success" | "error" | "warning" | "muted" } {
	if (result.exitCode === -1 && !result.started) return { label: "等待中", color: "muted" };
	if (result.exitCode === -1) return { label: "运行中", color: "warning" };
	if (isFailedResult(result)) return { label: "失败", color: "error" };
	return { label: "已完成", color: "success" };
}

function resolveSecondsToMs(seconds: number | undefined, label: string): number | undefined {
	if (seconds === undefined) return undefined;
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`Invalid ${label}: must be a positive finite number`);
	}
	const milliseconds = seconds * 1000;
	if (milliseconds > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid ${label}: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return milliseconds;
}

type AdmissionRelease = () => void;

interface AdmissionWaiter {
	resolve: (release: AdmissionRelease) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	cancelled: boolean;
}

class SubagentAdmission {
	private active = 0;
	private readonly waiters: AdmissionWaiter[] = [];

	constructor(private readonly limit: number) {}

	acquire(signal?: AbortSignal): Promise<AdmissionRelease> {
		return new Promise((resolve, reject) => {
			const waiter: AdmissionWaiter = { resolve, reject, signal, cancelled: false };
			const cancel = () => {
				if (waiter.cancelled) return;
				waiter.cancelled = true;
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				waiter.signal?.removeEventListener("abort", cancel);
				reject(new Error("Subagent admission wait aborted"));
			};
			waiter.onAbort = cancel;

			if (signal?.aborted) {
				cancel();
				return;
			}

			if (this.active < this.limit) this.grant(waiter);
			else {
				this.waiters.push(waiter);
				signal?.addEventListener("abort", cancel, { once: true });
			}
		});
	}

	private grant(waiter: AdmissionWaiter): void {
		if (waiter.cancelled) return;
		waiter.signal?.removeEventListener("abort", waiter.onAbort!);
		this.active++;
		let released = false;
		waiter.resolve(() => {
			if (released) return;
			released = true;
			this.active--;
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.limit && this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			if (waiter.cancelled) continue;
			this.grant(waiter);
		}
	}
}

// 同一 Pi 进程内的所有 subagent 调用共享 admission，避免多个父工具并行时突破并发上限。
const subagentAdmission = new SubagentAdmission(MAX_CONCURRENCY);

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	onError?: (error: unknown, index: number) => void,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	let firstError: unknown;
	let hasError = false;
	const workers = new Array(limit).fill(null).map(async () => {
		while (!hasError) {
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current], current);
			} catch (error) {
				if (!hasError) {
					hasError = true;
					firstError = error;
					onError?.(error, current);
				}
				return;
			}
		}
	});
	await Promise.all(workers);
	if (hasError) throw firstError;
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

const liveOutputDirs = new Set<string>();

async function writeOutputToTempFile(agentName: string, output: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-output-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `${safeName}.md`);
	liveOutputDirs.add(tmpDir);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, output, { encoding: "utf-8", mode: 0o600 });
	});
	return filePath;
}

/**
 * Remove stale subagent temp dirs left behind by crashed or killed processes.
 * `lstat` is deliberate: a symlink named with our prefix must not be followed.
 */
async function sweepStaleSubagentTempDirs(maxAgeMs = TMP_MAX_AGE_MS): Promise<void> {
	const root = os.tmpdir();
	let names: string[];
	try {
		names = await fs.promises.readdir(root);
	} catch {
		return;
	}
	const now = Date.now();
	await Promise.all(
		names
			.filter((name) => name.startsWith(TMP_PREFIX))
			.map(async (name) => {
				const full = path.join(root, name);
				try {
					const stats = await fs.promises.lstat(full);
					if (!stats.isDirectory()) return;
					if (now - stats.mtimeMs < maxAgeMs) return;
					await fs.promises.rm(full, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}),
	);
}

async function getOutputPreview(agentName: string, output: string, maxBytes = PER_TASK_OUTPUT_CAP): Promise<{ content: string; outputPath?: string }> {
	const preview = truncateOutput(output, maxBytes);
	if (preview === output) return { content: output };

	const outputPath = await writeOutputToTempFile(agentName, output);
	return {
		content: truncateOutput(output, maxBytes, MAX_OUTPUT_LINES, outputPath),
		outputPath,
	};
}

async function getResultOutputPreview(result: SingleResult, maxBytes = PER_TASK_OUTPUT_CAP): Promise<string> {
	const preview = await getOutputPreview(result.agent, getResultOutput(result), maxBytes);
	result.outputPath = preview.outputPath;
	return preview.content;
}

async function getFinalOutputPreview(result: SingleResult, maxBytes = PER_TASK_OUTPUT_CAP): Promise<string> {
	const preview = await getOutputPreview(result.agent, getFinalOutput(result.messages), maxBytes);
	result.outputPath = preview.outputPath;
	return preview.content;
}

function terminateChildProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		if (proc.pid !== undefined) {
			const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.unref();
			return;
		}
		proc.kill(signal);
		return;
	}

	if (proc.pid !== undefined) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		}
	}
	proc.kill(signal);
}

function resolveAgentCwd(defaultCwd: string, cwd: string | undefined): string {
	return cwd === undefined ? defaultCwd : path.resolve(defaultCwd, cwd);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	idleTimeoutSeconds: number | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const idleTimeoutMs = resolveSecondsToMs(idleTimeoutSeconds, "idleTimeoutSeconds");
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			started: true,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.toolsSpecified) args.push("--tools", agent.tools?.join(",") ?? "");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let releaseAdmission: AdmissionRelease | undefined;
	const taskController = new AbortController();
	let parentAbortHandler: (() => void) | undefined;
	let wasAborted = false;
	let wasIdleTimedOut = false;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
		started: true,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	const liveActivities: ActivityItem[] = [];
	const streamingActivities = new Map<string, { kind: "text"; text: string }>();
	let messageSequence = 0;

	const updateLiveActivity = (key: string, kind: "tool" | "text", value: unknown, toolName?: string) => {
		const text =
			kind === "tool"
				? getToolActivity(toolName || key.slice(5), (value || {}) as Record<string, any>)
				: normalizeActivityText(value);
		if (!text) return;

		const existingIndex = liveActivities.findIndex((item) => item.key === key);
		if (existingIndex >= 0) {
			if (liveActivities[existingIndex].text === text) return;
			liveActivities[existingIndex] = { kind, text, key };
		} else {
			liveActivities.push({ kind, text, key });
			if (liveActivities.length > 4) liveActivities.shift();
		}
		currentResult.liveActivity = [...liveActivities];
		emitUpdate();
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		if (signal) {
			parentAbortHandler = () => taskController.abort();
			if (signal.aborted) parentAbortHandler();
			else signal.addEventListener("abort", parentAbortHandler, { once: true });
		}
		releaseAdmission = await subagentAdmission.acquire(taskController.signal);
		if (taskController.signal.aborted) {
			throw new Error("Subagent was aborted before process start");
		}

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: resolveAgentCwd(defaultCwd, cwd),
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) },
			});
			let buffer = "";
			let invalidJsonLines = 0;
			let closed = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			let idleTimeoutHandle: ReturnType<typeof setInterval> | undefined;
			let lastActivityAt = Date.now();
			const decoder = new StringDecoder("utf8");

			const cleanup = () => {
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (idleTimeoutHandle) clearInterval(idleTimeoutHandle);
				if (taskController.signal && abortHandler) taskController.signal.removeEventListener("abort", abortHandler);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					invalidJsonLines++;
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") {
					messageSequence++;
					streamingActivities.clear();
				}

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const update = event.assistantMessageEvent;
					const contentIndex = update.contentIndex ?? 0;
					const key = `message:${messageSequence}:${contentIndex}`;

					if (update.type === "thinking_start" || update.type === "text_start") {
						streamingActivities.set(key, { kind: "text", text: "" });
					} else if (update.type === "thinking_delta" || update.type === "text_delta") {
						const current = streamingActivities.get(key) ?? { kind: "text", text: "" };
						current.text += update.delta || "";
						streamingActivities.set(key, current);
						updateLiveActivity(key, "text", current.text);
					} else if (update.type === "thinking_end" || update.type === "text_end") {
						const current = streamingActivities.get(key);
						updateLiveActivity(key, "text", update.content ?? current?.text);
					} else if (update.type === "toolcall_end" && update.toolCall?.name) {
						updateLiveActivity(
							`tool:${update.toolCall.id || update.toolCall.name}`,
							"tool",
							update.toolCall.arguments || {},
							update.toolCall.name,
						);
					}
				}

				if (event.type === "tool_execution_start" && event.toolName) {
					updateLiveActivity(
						`tool:${event.toolCallId || event.toolName}`,
						"tool",
						event.args || {},
						event.toolName,
					);
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				lastActivityAt = Date.now();
				buffer += decoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				lastActivityAt = Date.now();
				currentResult.stderr = appendCappedText(currentResult.stderr, data.toString(), MAX_STDERR_BYTES);
			});

			proc.on("close", (code, childSignal) => {
				closed = true;
				buffer += decoder.end();
				if (buffer.trim()) processLine(buffer);
				currentResult.exitSignal = childSignal ?? undefined;
				if (code === null && childSignal && !currentResult.errorMessage) {
					currentResult.errorMessage = `Subagent process terminated by ${childSignal}.`;
				}
				if (invalidJsonLines > 0 && currentResult.messages.length === 0 && !currentResult.errorMessage) {
					currentResult.stopReason = "error";
					currentResult.errorMessage = `Subagent emitted ${invalidJsonLines} invalid JSON line${invalidJsonLines === 1 ? "" : "s"}.`;
				}
				const lastMessage = currentResult.messages[currentResult.messages.length - 1];
				if ((!lastMessage || lastMessage.role !== "assistant") && !currentResult.errorMessage) {
					currentResult.stopReason = "error";
					currentResult.errorMessage = "Subagent exited without a final assistant message.";
				}
				cleanup();
				resolve(code ?? 1);
			});

			proc.on("error", (error) => {
				currentResult.errorMessage = `Failed to start subagent: ${error.message}`;
				currentResult.stderr = appendCappedText(currentResult.stderr, `${error.message}\n`, MAX_STDERR_BYTES);
				cleanup();
				resolve(1);
			});

			abortHandler = () => {
				if (closed) return;
				wasAborted = true;
				terminateChildProcess(proc, "SIGTERM");
				forceKillTimer = setTimeout(() => {
					if (!closed) terminateChildProcess(proc, "SIGKILL");
				}, 5000);
			};
			if (taskController.signal) {
				if (taskController.signal.aborted) abortHandler();
				else taskController.signal.addEventListener("abort", abortHandler, { once: true });
			}
			if (idleTimeoutMs !== undefined && !closed) {
				// 轮询而非每次活动都重排定时器：流式输出期间活动极密集，重排的抖动和开销都更大。
				// 计时从进程启动开始，排队等待不计入空闲。
				const idleCheckIntervalMs = Math.max(250, Math.min(1000, Math.floor(idleTimeoutMs / 4)));
				idleTimeoutHandle = setInterval(() => {
					if (closed || Date.now() - lastActivityAt < idleTimeoutMs) return;
					wasIdleTimedOut = true;
					taskController.abort();
				}, idleCheckIntervalMs);
				idleTimeoutHandle.unref();
			}
		});

		currentResult.exitCode = exitCode;
		if (exitCode !== 0 && !currentResult.stopReason) currentResult.stopReason = "error";
		if (wasIdleTimedOut) throw new Error(`Subagent idle for ${idleTimeoutSeconds} seconds; terminated`);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} catch (error) {
		if (wasIdleTimedOut) throw new Error(`Subagent idle for ${idleTimeoutSeconds} seconds; terminated`);
		if (taskController.signal.aborted) throw new Error("Subagent was aborted");
		throw error;
	} finally {
		if (signal && parentAbortHandler) signal.removeEventListener("abort", parentAbortHandler);
		if (releaseAdmission) releaseAdmission();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	idleTimeoutSeconds: Type.Optional(
		Type.Number({ description: "Kill the task if it emits no output for this many seconds; resets on every output event" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	idleTimeoutSeconds: Type.Optional(
		Type.Number({ description: "Kill the task if it emits no output for this many seconds; resets on every output event" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" to combine project-local and user-level agents.',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	idleTimeoutSeconds: Type.Optional(
		Type.Number({ description: "Kill the task if it emits no output for this many seconds; resets on every output event" }),
	),
});

const BackgroundTaskParams = Type.Object({
	action: StringEnum(["start", "list", "status", "result", "logs", "kill"] as const),
	agent: Type.Optional(Type.String({ description: "Agent name for start" })),
	task: Type.Optional(Type.String({ description: "Task prompt for start" })),
	taskId: Type.Optional(Type.String({ description: "Background task id for status/result/logs/kill" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for start" })),
	idleTimeoutSeconds: Type.Optional(
		Type.Number({ description: "Kill the task if it writes no output for this many seconds; resets on every output event" }),
	),
	notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Send a completion notification. Default: true" })),
	triggerOnCompletion: Type.Optional(Type.Boolean({ description: "Wake a follow-up turn on completion. Default: false" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true" })),
});

function formatBackgroundTask(task: BackgroundTaskRecord): string {
	const finished = task.finishedAt ? ` finished=${new Date(task.finishedAt).toISOString()}` : "";
	const pid = task.runnerPid ? ` pid=${task.runnerPid}` : "";
	return `${task.id} [${task.status}] ${task.agent}${pid}${finished}`;
}

export default function (pi: ExtensionAPI) {
	void sweepStaleSubagentTempDirs();
	const registry = new BackgroundTaskRegistry({
		rootDir: BACKGROUND_TASK_ROOT,
		runnerPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "background-runner.mjs"),
		maxConcurrentTasks: MAX_CONCURRENCY,
		onTerminal: (task) => {
			if (!task.notifyOnCompletion) return;
			const detail = task.status === "completed" ? "Completed" : task.errorMessage || task.status;
			pi.sendMessage(
				{
					customType: "subagent-background",
					content: `Background subagent ${task.agent} ${detail}. Task id: ${task.id}`,
					display: true,
				},
				{
					deliverAs: task.triggerOnCompletion ? "followUp" : "nextTurn",
					triggerTurn: task.triggerOnCompletion,
				},
			);
		},
	});
	pi.on("session_start", async () => {
		await registry.reconcile();
	});

	// Output files stay readable for the whole session, so only reclaim them on real exit.
	// reload/resume/new/fork may continue using this session, where the path is still in context.
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		const dirs = [...liveOutputDirs];
		liveOutputDirs.clear();
		await Promise.all(
			dirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})),
		);
	});

	pi.registerCommand("subagent:list", {
		description: "列出可用 subagent，并把清单注入会话上下文",
		handler: async (_args, ctx) => {
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, "both");
			const lines = agents.length === 0
				? ["当前没有可用的 subagent。"]
				: [`可用 subagent（${agents.length} 个）：`, ...agents.map((a) => `- ${formatAgentLine(a)}`)];
			if (projectAgentsDir) lines.push(`项目 agent 目录：${projectAgentsDir}`);
			const report = lines.join("\n");
			// 命令返回值会被 pi 丢弃，必须显式输出；无 UI 模式退回 stderr，避免污染 JSON 事件流
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.error(report);
			// 工具描述只在扩展加载时生成，这里给模型补一份实时清单
			pi.sendMessage(
				{ customType: "subagent-list", content: report, display: false },
				{ deliverAs: "nextTurn" },
			);
		},
	});

	pi.registerCommand("subagent:jobs", {
		description: "查看后台 subagent 任务",
		handler: async (_args, ctx) => {
			const tasks = await registry.list();
			const report = tasks.length === 0
				? "当前没有后台 subagent 任务。"
				: ["后台 subagent 任务：", ...tasks.map(formatBackgroundTask)].join("\n");
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.error(report);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Use idleTimeoutSeconds to kill only tasks that stop emitting output (the clock resets on every output event).",
			"Parallel tasks are cancelled together after the first failure.",
			`Default agent scope is "both": combines ${CONFIG_DIR_NAME}/agents with ${path.join(getAgentDir(), "agents")}.`,
			"Project agents override user agents with the same name.",
			describeAgents(discoverAgents(process.cwd(), "both").agents),
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			if (getSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
				throw new Error(`Subagent nesting depth exceeded (max ${MAX_SUBAGENT_DEPTH}).`);
			}
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const projectAgentsAllowed = ctx.isProjectTrusted() || ctx.hasUI;
			let discoveryScope = agentScope;
			if (!projectAgentsAllowed && agentScope === "both") discoveryScope = "user";
			const discovery = discoverAgents(ctx.cwd, discoveryScope);
			const agents = !projectAgentsAllowed && agentScope === "project" ? [] : discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				throw new Error(`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`);
			}

			if (
				projectAgentsAllowed &&
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) throw new Error("Project-local agents were not approved.");
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						step.idleTimeoutSeconds,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = await getResultOutputPreview(result);
						throw new Error(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`);
					}
					previousOutput = await getFinalOutputPreview(result);
				}
				const finalOutput = await getFinalOutputPreview(results[results.length - 1]);
				return {
					content: [{ type: "text", text: finalOutput || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					throw new Error(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						started: false,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const parallelController = new AbortController();
				const parentAbortHandler = () => parallelController.abort();
				if (signal) {
					if (signal.aborted) parentAbortHandler();
					else signal.addEventListener("abort", parentAbortHandler, { once: true });
				}

				let results: SingleResult[];
				try {
					results = await mapWithConcurrencyLimit(
						params.tasks,
						MAX_CONCURRENCY,
						async (t, index) => {
							const result = await runSingleAgent(
								ctx.cwd,
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								t.cwd,
								t.idleTimeoutSeconds,
								undefined,
								parallelController.signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
							);
							allResults[index] = result;
							emitParallelUpdate();
							if (isFailedResult(result)) {
								const output = await getResultOutputPreview(result, Math.max(1024, Math.floor(PER_TASK_OUTPUT_CAP / allResults.length)));
								throw new Error(`Agent ${result.agent} failed: ${output}`);
							}
							return result;
						},
						() => parallelController.abort(),
					);
				} finally {
					if (signal) signal.removeEventListener("abort", parentAbortHandler);
				}

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const perTaskOutputCap = Math.max(1024, Math.floor(PER_TASK_OUTPUT_CAP / results.length));
				const summaries = await Promise.all(
					results.map(async (r) => {
						const output = await getResultOutputPreview(r, perTaskOutputCap);
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						return `### [${r.agent}] ${status}\n\n${output}`;
					}),
				);
				let summary = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
				if (truncateOutput(summary) !== summary) {
					const fullReport = results
						.map((r) => `### [${r.agent}]\n\n${getResultOutput(r)}`)
						.join("\n\n---\n\n");
					const outputPath = await writeOutputToTempFile("parallel-results", fullReport);
					summary = truncateOutput(summary, PER_TASK_OUTPUT_CAP, MAX_OUTPUT_LINES, outputPath);
				}
				if (successCount !== results.length) throw new Error(summary);
				return {
					content: [{ type: "text", text: summary }],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					params.idleTimeoutSeconds,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = await getResultOutputPreview(result);
					throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
				}
				const output = await getFinalOutputPreview(result);
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			throw new Error(`Invalid parameters. Available agents: ${available}`);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "both";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				const text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							`${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const taskStatus = getParallelTaskStatus(r);
						const isTaskRunning = r.exitCode === -1;
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${theme.fg(taskStatus.color, `[${taskStatus.label}]`)}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// 运行中的任务只展示最近活动，避免把尚未完成的中间状态
						// 当成最终输出，同时让展开视图能持续反映当前进度。
						if (isTaskRunning) {
							const activityLines = getParallelActivityLines(r);
							if (activityLines.length === 0) {
								container.addChild(new Text(theme.fg("muted", "(waiting for activity...)"), 0, 0));
							} else {
								for (const activity of activityLines) {
									container.addChild(new Text(theme.fg("muted", `  ${activity}`), 0, 0));
								}
							}
							continue;
						}

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// 默认视图只保留每个任务的一行状态，避免并行任务把终端铺满。
				let text = `${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const taskStatus = getParallelTaskStatus(r);
					const taskName = shortenActivityText(r.task, 72) || r.agent;
					text +=
						`\n${theme.fg("accent", r.agent)}` +
						` ${theme.fg(taskStatus.color, `[${taskStatus.label}]`)} ` +
						theme.fg("dim", taskName);
					}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_background",
		label: "Background Subagent",
		description: "Start and manage persistent background subagent tasks. Use start to return immediately, then query status/result/logs or kill by taskId.",
		parameters: BackgroundTaskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const tasks = await registry.list();
				return {
					content: [{ type: "text", text: tasks.map(formatBackgroundTask).join("\n") || "No background subagent tasks." }],
					details: undefined,
				};
			}

			if (params.action !== "start") {
				if (!params.taskId) throw new Error(`taskId is required for ${params.action}.`);
				if (params.action === "status") {
					const task = await registry.get(params.taskId);
					return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: task };
				}
				if (params.action === "result") {
					const result = await registry.getResult(params.taskId);
					return { content: [{ type: "text", text: result.content }], details: result.task };
				}
				if (params.action === "logs") {
					const result = await registry.getLogs(params.taskId);
					return { content: [{ type: "text", text: result.content }], details: result.task };
				}
				const task = await registry.kill(params.taskId);
				return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: task };
			}

			if (!params.agent || !params.task) throw new Error("agent and task are required for start.");
			if (getSubagentDepth() >= MAX_SUBAGENT_DEPTH) {
				throw new Error(`Subagent nesting depth exceeded (max ${MAX_SUBAGENT_DEPTH}).`);
			}
			const agentScope: AgentScope = params.agentScope ?? "both";
			const projectAgentsAllowed = ctx.isProjectTrusted() || ctx.hasUI;
			let discoveryScope = agentScope;
			if (!projectAgentsAllowed && agentScope === "both") discoveryScope = "user";
			const discovery = discoverAgents(ctx.cwd, discoveryScope);
			const agents = !projectAgentsAllowed && agentScope === "project" ? [] : discovery.agents;
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) throw new Error(`Unknown agent: "${params.agent}".`);

			if (
				agent.source === "project" &&
				params.confirmProjectAgents !== false &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const ok = await ctx.ui.confirm(
					"Run project-local agent?",
					`Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) throw new Error("Project-local agent was not approved.");
			}

			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const createInvocation = (systemPromptPath?: string) => {
				const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent,subagent_background"];
				const model = agent.model ?? dispatchDefaults.model;
				if (model) args.push("--model", model);
				if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
				if (agent.toolsSpecified) args.push("--tools", agent.tools?.join(",") ?? "");
				if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
				args.push(`Task: ${params.task}`);
				return getPiInvocation(args);
			};
			const task = await registry.start({
				agent: agent.name,
				agentSource: agent.source,
				task: params.task,
				cwd: resolveAgentCwd(ctx.cwd, params.cwd),
				model: agent.model ?? dispatchDefaults.model,
				sessionId: ctx.sessionManager.getSessionId(),
				idleTimeoutSeconds: params.idleTimeoutSeconds,
				notifyOnCompletion: params.notifyOnCompletion ?? true,
				triggerOnCompletion: params.triggerOnCompletion ?? false,
				systemPrompt: agent.systemPrompt,
				createInvocation,
			});
			return {
				content: [{ type: "text", text: `Background subagent started: ${formatBackgroundTask(task)}` }],
				details: task,
			};
		},
	});
}
