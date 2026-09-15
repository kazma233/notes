import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "killed";

export interface BackgroundTaskRecord {
	version: 1;
	id: string;
	status: BackgroundTaskStatus;
	agent: string;
	agentSource: "user" | "project";
	task: string;
	cwd: string;
	model?: string;
	sessionId?: string;
	idleTimeoutSeconds?: number;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	finishedAt?: number;
	runnerPid?: number;
	exitCode?: number | null;
	exitSignal?: string;
	stopReason?: string;
	errorMessage?: string;
	outputPath: string;
	stderrPath: string;
	resultPath: string;
}

interface BackgroundTaskRunnerState {
	status: "queued" | "running";
	runnerPid: number;
	childPid?: number;
	startedAt?: number;
}

interface BackgroundTaskTerminalResult {
	exitCode: number | null;
	signal?: string;
	idleTimedOut?: boolean;
	killed: boolean;
	startedAt?: number;
	finishedAt: number;
	errorMessage?: string;
}

interface BackgroundTaskLaunch {
	agent: string;
	agentSource: "user" | "project";
	task: string;
	cwd: string;
	model?: string;
	sessionId?: string;
	idleTimeoutSeconds?: number;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	systemPrompt: string;
	createInvocation: (systemPromptPath?: string) => { command: string; args: string[] };
}

interface BackgroundTaskRegistryOptions {
	rootDir: string;
	runnerPath: string;
	maxConcurrentTasks: number;
	onTerminal?: (task: BackgroundTaskRecord) => void;
}

interface BackgroundTaskResult {
	task: BackgroundTaskRecord;
	content: string;
	truncated: boolean;
}

const TASK_FILE = "task.json";
const RUNNER_CONFIG_FILE = "runner-config.json";
const RUNNER_STATE_FILE = "runner-state.json";
const RUNNER_RESULT_FILE = "runner-result.json";
const SYSTEM_PROMPT_FILE = "system-prompt.md";
const OUTPUT_FILE = "output.jsonl";
const STDERR_FILE = "stderr.log";
const RESULT_FILE = "result.md";
const SLOT_DIR = "slots";
const MAX_RESULT_BYTES = 50 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

function validateSeconds(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${label}: must be a positive finite number`);
	}
	if (value * 1000 > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid ${label}: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
}

function isTerminalStatus(status: BackgroundTaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "killed";
}

function taskDirectory(rootDir: string, taskId: string): string {
	if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error(`Invalid background task id: ${taskId}`);
	return path.join(rootDir, taskId);
}

function taskFilePath(rootDir: string, taskId: string): string {
	return path.join(taskDirectory(rootDir, taskId), TASK_FILE);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await fs.promises.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
	await fs.promises.rename(tempPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function getTextPrefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const characters: string[] = [];
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		characters.push(character);
		bytes += characterBytes;
	}
	return characters.join("");
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function extractFinalAssistantMessage(output: string): { text: string; stopReason?: string; errorMessage?: string } | undefined {
	let finalMessage: { text: string; stopReason?: string; errorMessage?: string } | undefined;
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: {
					role?: string;
					content?: Array<{ type?: string; text?: string }>;
					stopReason?: string;
					errorMessage?: string;
				};
			};
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			const text = (event.message.content ?? [])
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text ?? "")
				.filter((part) => part.trim())
				.join("\n\n");
			finalMessage = {
				text,
				stopReason: event.message.stopReason,
				errorMessage: event.message.errorMessage,
			};
		} catch {
			// runner 可能正在写入最后一行，暂不把未完成 JSON 当成终态。
		}
	}
	return finalMessage;
}

/** 管理可跨会话查询的后台 subagent 任务；runner 是唯一负责超时与后台槽位的进程。 */
export class BackgroundTaskRegistry {
	private readonly notifiedTerminalIds = new Set<string>();

	constructor(private readonly options: BackgroundTaskRegistryOptions) {}

	private notifyTerminal(task: BackgroundTaskRecord): void {
		if (!isTerminalStatus(task.status) || this.notifiedTerminalIds.has(task.id)) return;
		this.notifiedTerminalIds.add(task.id);
		this.options.onTerminal?.(task);
	}

	async start(input: BackgroundTaskLaunch): Promise<BackgroundTaskRecord> {
		validateSeconds(input.idleTimeoutSeconds, "idleTimeoutSeconds");
		const id = randomUUID();
		const dir = taskDirectory(this.options.rootDir, id);
		const outputPath = path.join(dir, OUTPUT_FILE);
		const stderrPath = path.join(dir, STDERR_FILE);
		const resultPath = path.join(dir, RESULT_FILE);
		const systemPromptPath = input.systemPrompt.trim() ? path.join(dir, SYSTEM_PROMPT_FILE) : undefined;
		const now = Date.now();

		await fs.promises.mkdir(path.join(this.options.rootDir, SLOT_DIR), { recursive: true, mode: 0o700 });
		await fs.promises.mkdir(dir, { recursive: false, mode: 0o700 });
		if (systemPromptPath) {
			await fs.promises.writeFile(systemPromptPath, input.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		}
		await fs.promises.writeFile(outputPath, "", { encoding: "utf-8", mode: 0o600 });
		await fs.promises.writeFile(stderrPath, "", { encoding: "utf-8", mode: 0o600 });

		const record: BackgroundTaskRecord = {
			version: 1,
			id,
			status: "queued",
			agent: input.agent,
			agentSource: input.agentSource,
			task: input.task,
			cwd: input.cwd,
			model: input.model,
			sessionId: input.sessionId,
			idleTimeoutSeconds: input.idleTimeoutSeconds,
			notifyOnCompletion: input.notifyOnCompletion,
			triggerOnCompletion: input.triggerOnCompletion,
			createdAt: now,
			updatedAt: now,
			outputPath,
			stderrPath,
			resultPath,
		};
		await this.writeRecord(record);

		let configPath: string;
		try {
			const invocation = input.createInvocation(systemPromptPath);
			configPath = path.join(dir, RUNNER_CONFIG_FILE);
			await writeFileAtomic(
				configPath,
				JSON.stringify(
					{
						version: 1,
						taskId: id,
						command: invocation.command,
						args: invocation.args,
						cwd: input.cwd,
						outputPath,
						stderrPath,
						statePath: path.join(dir, RUNNER_STATE_FILE),
						terminalPath: path.join(dir, RUNNER_RESULT_FILE),
						slotsDir: path.join(this.options.rootDir, SLOT_DIR),
						slotLimit: this.options.maxConcurrentTasks,
						idleTimeoutMs: input.idleTimeoutSeconds === undefined ? undefined : input.idleTimeoutSeconds * 1000,
					},
					null,
					2,
				),
			);
		} catch (error) {
			const failed = await this.updateRecord(record, {
				status: "failed",
				finishedAt: Date.now(),
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			this.notifyTerminal(failed);
			return failed;
		}

		const runner = spawn(process.execPath, [this.options.runnerPath, configPath], {
			cwd: input.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: "ignore",
			windowsHide: true,
		});
		if (runner.pid === undefined) {
			const failed = await this.updateRecord(record, {
				status: "failed",
				finishedAt: Date.now(),
				errorMessage: "Failed to start background task runner.",
			});
			this.notifyTerminal(failed);
			return failed;
		}

		const running = await this.updateRecord(record, { runnerPid: runner.pid });
		runner.once("close", () => {
			void this.reconcileTask(id);
		});
		runner.once("error", () => {
			void this.reconcileTask(id);
		});
		runner.unref();
		return running;
	}

	async list(): Promise<BackgroundTaskRecord[]> {
		await this.ensureRoot();
		const entries = await fs.promises.readdir(this.options.rootDir, { withFileTypes: true });
		const tasks = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
				.map((entry) => this.reconcileTask(entry.name).catch(() => undefined)),
		);
		return tasks
			.filter((task): task is BackgroundTaskRecord => task !== undefined)
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async get(taskId: string): Promise<BackgroundTaskRecord> {
		return this.reconcileTask(taskId);
	}

	async getResult(taskId: string): Promise<BackgroundTaskResult> {
		const task = await this.reconcileTask(taskId);
		if (!isTerminalStatus(task.status)) {
			return { task, content: `Task ${task.id} is ${task.status}.`, truncated: false };
		}
		if (task.status !== "completed") {
			return { task, content: task.errorMessage || `Task ${task.id} ${task.status}.`, truncated: false };
		}

		const output = await fs.promises.readFile(task.resultPath, "utf-8");
		const preview = getTextPrefix(output, MAX_RESULT_BYTES);
		if (preview === output) return { task, content: output, truncated: false };
		return {
			task,
			content: `${preview}\n\n[Result truncated. Full result: ${task.resultPath}]`,
			truncated: true,
		};
	}

	async getLogs(taskId: string): Promise<BackgroundTaskResult> {
		const task = await this.reconcileTask(taskId);
		const stderr = await fs.promises.readFile(task.stderrPath, "utf-8");
		const preview = getTextPrefix(stderr, MAX_RESULT_BYTES);
		if (preview === stderr) return { task, content: preview || "(no stderr output)", truncated: false };
		return {
			task,
			content: `${preview}\n\n[Logs truncated. Full stderr: ${task.stderrPath}]`,
			truncated: true,
		};
	}

	async kill(taskId: string): Promise<BackgroundTaskRecord> {
		const task = await this.reconcileTask(taskId);
		if (isTerminalStatus(task.status)) return task;

		const state = await readJson<BackgroundTaskRunnerState>(path.join(taskDirectory(this.options.rootDir, taskId), RUNNER_STATE_FILE));
		if (state?.childPid) this.terminateProcess(state.childPid, "SIGTERM");
		if (task.runnerPid) this.terminateProcess(task.runnerPid, "SIGTERM");
		const timer = setTimeout(() => {
			if (state?.childPid) this.terminateProcess(state.childPid, "SIGKILL");
			if (task.runnerPid) this.terminateProcess(task.runnerPid, "SIGKILL");
		}, 5000);
		timer.unref();

		const killed = await this.updateRecord(task, {
			status: "killed",
			finishedAt: Date.now(),
			errorMessage: "Killed by user.",
		});
			this.notifyTerminal(killed);
		return killed;
	}

	async reconcile(): Promise<void> {
		await this.list();
	}

	private async reconcileTask(taskId: string): Promise<BackgroundTaskRecord> {
		const task = await this.readRecord(taskId);
		if (!task) throw new Error(`Background task not found: ${taskId}`);
		if (isTerminalStatus(task.status)) return task;

		const dir = taskDirectory(this.options.rootDir, taskId);
		const terminal = await readJson<BackgroundTaskTerminalResult>(path.join(dir, RUNNER_RESULT_FILE));
		if (terminal) {
			const completed = await this.completeFromTerminal(task, terminal);
			this.notifyTerminal(completed);
			return completed;
		}

		const state = await readJson<BackgroundTaskRunnerState>(path.join(dir, RUNNER_STATE_FILE));
		if (state?.status === "running" && task.status !== "running") {
			return this.updateRecord(task, { status: "running", startedAt: state.startedAt ?? Date.now() });
		}
		if (!isProcessAlive(task.runnerPid)) {
			const failed = await this.updateRecord(task, {
				status: "failed",
				finishedAt: Date.now(),
				errorMessage: "Background task runner exited without a terminal result.",
			});
			this.notifyTerminal(failed);
			return failed;
		}
		return task;
	}

	private async completeFromTerminal(
		task: BackgroundTaskRecord,
		terminal: BackgroundTaskTerminalResult,
	): Promise<BackgroundTaskRecord> {
		if (task.status === "killed") {
			return this.updateRecord(task, {
				exitCode: terminal.exitCode,
				exitSignal: terminal.signal,
				finishedAt: task.finishedAt ?? terminal.finishedAt,
			});
		}
		if (terminal.killed) {
			return this.updateRecord(task, {
				status: "killed",
				exitCode: terminal.exitCode,
				exitSignal: terminal.signal,
				finishedAt: terminal.finishedAt,
				errorMessage: "Killed by user.",
			});
		}
		if (terminal.idleTimedOut) {
			return this.updateRecord(task, {
				status: "failed",
				exitCode: terminal.exitCode,
				exitSignal: terminal.signal,
				finishedAt: terminal.finishedAt,
				errorMessage: `Idle for ${task.idleTimeoutSeconds} seconds (no output).`,
			});
		}
		if (terminal.exitCode !== 0) {
			return this.updateRecord(task, {
				status: "failed",
				exitCode: terminal.exitCode,
				exitSignal: terminal.signal,
				finishedAt: terminal.finishedAt,
				errorMessage: terminal.errorMessage || `Background subagent exited with code ${terminal.exitCode}.`,
			});
		}

		const output = await fs.promises.readFile(task.outputPath, "utf-8");
		const result = extractFinalAssistantMessage(output);
		if (!result || result.stopReason === "error" || result.stopReason === "aborted") {
			return this.updateRecord(task, {
				status: "failed",
				exitCode: terminal.exitCode,
				exitSignal: terminal.signal,
				finishedAt: terminal.finishedAt,
				stopReason: result?.stopReason,
				errorMessage: result?.errorMessage || "Background subagent exited without a successful final assistant message.",
			});
		}
		await fs.promises.writeFile(task.resultPath, result.text, { encoding: "utf-8", mode: 0o600 });
		return this.updateRecord(task, {
			status: "completed",
			exitCode: terminal.exitCode,
			exitSignal: terminal.signal,
			finishedAt: terminal.finishedAt,
			stopReason: result.stopReason,
		});
	}

	private async ensureRoot(): Promise<void> {
		await fs.promises.mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
	}

	private async readRecord(taskId: string): Promise<BackgroundTaskRecord | undefined> {
		return readJson<BackgroundTaskRecord>(taskFilePath(this.options.rootDir, taskId));
	}

	private async writeRecord(record: BackgroundTaskRecord): Promise<void> {
		await writeFileAtomic(taskFilePath(this.options.rootDir, record.id), JSON.stringify(record, null, 2));
	}

	private async updateRecord(
		task: BackgroundTaskRecord,
		updates: Partial<BackgroundTaskRecord>,
	): Promise<BackgroundTaskRecord> {
		const next = { ...task, ...updates, updatedAt: Date.now() } as BackgroundTaskRecord;
		await this.writeRecord(next);
		return next;
	}

	private terminateProcess(pid: number, signal: NodeJS.Signals): void {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).unref();
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			try {
				process.kill(pid, signal);
			} catch {
				// 进程已经结束时无需再处理。
			}
		}
	}
}
