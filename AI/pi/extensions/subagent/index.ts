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
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_STDERR_BYTES = 50 * 1024;
const MAX_SUBAGENT_DEPTH = 1;
const TRUNCATION_MARKER_RESERVE = 160;
const SENSITIVE_ARGUMENT_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie)/i;

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

function truncateOutput(
	output: string,
	maxBytes = PER_TASK_OUTPUT_CAP,
	maxLines = MAX_OUTPUT_LINES,
	fullOutputPath?: string,
): string {
	const originalBytes = Buffer.byteLength(output, "utf8");
	const originalLines = output.split("\n").length;
	let truncated = originalLines > maxLines ? output.split("\n").slice(0, maxLines).join("\n") : output;
	let truncatedBytes = Buffer.byteLength(truncated, "utf8");

	const contentMaxBytes = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE);
	if (truncatedBytes > contentMaxBytes) {
		truncated = Array.from(truncated).reduce((value, character) => {
			if (Buffer.byteLength(value + character, "utf8") > contentMaxBytes) return value;
			return value + character;
		}, "");
		truncatedBytes = Buffer.byteLength(truncated, "utf8");
	}

	if (truncatedBytes === originalBytes && originalLines <= maxLines) return output;

	const omittedBytes = Math.max(0, originalBytes - truncatedBytes);
	const omittedLines = Math.max(0, originalLines - truncated.split("\n").length);
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

function getToolActivity(toolName: string, args: Record<string, any>): string {
	return shortenActivityText(formatToolCallSummary(toolName, args));
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
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

async function writeOutputToTempFile(agentName: string, output: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-output-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, output, { encoding: "utf-8", mode: 0o600 });
	});
	return filePath;
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
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
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
		const text = kind === "tool" ? getToolActivity(toolName || key.slice(5), (value || {}) as Record<string, any>) : shortenActivityText(value);
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
		let wasAborted = false;

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
			const decoder = new StringDecoder("utf8");

			const cleanup = () => {
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
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
				buffer += decoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
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
			if (signal) {
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (exitCode !== 0 && !currentResult.stopReason) currentResult.stopReason = "error";
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
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
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
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
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "both": combines ${CONFIG_DIR_NAME}/agents with ${path.join(getAgentDir(), "agents")}.`,
			"Project agents override user agents with the same name.",
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

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
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
					return result;
				});

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

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)}`, 0, 0),
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

				// 默认视图只保留每个任务的状态和最近活动，避免并行任务把终端铺满。
				let text = `${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const taskStatus = getParallelTaskStatus(r);
					const taskName = shortenActivityText(r.task, 72) || r.agent;
					text +=
						`\n${theme.fg("accent", r.agent)}` +
						` ${theme.fg(taskStatus.color, `[${taskStatus.label}]`)} ` +
						theme.fg("dim", taskName);

					if (r.exitCode === -1) {
						for (const activity of getParallelActivityLines(r)) {
							text += `\n  ${theme.fg("muted", activity)}`;
						}
					}
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
}
