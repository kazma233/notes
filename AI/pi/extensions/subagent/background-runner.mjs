import { spawn } from "node:child_process";
import { readFile, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const configPath = process.argv[2];
if (!configPath) throw new Error("Background runner config path is required.");

const config = JSON.parse(await readFile(configPath, "utf8"));
let child;
let slotPath;
let idleTimedOut = false;
let killed = false;
let finished = false;
let idleTimer;

async function writeAtomic(filePath, value) {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, filePath);
}

function isAlive(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function terminate(pid, signal) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).unref();
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (error?.code === "ESRCH") return;
		try {
			process.kill(pid, signal);
		} catch {
			// 进程已退出时无需重复处理。
		}
	}
}

async function releaseSlot() {
	if (!slotPath) return;
	try {
		const claim = JSON.parse(await readFile(slotPath, "utf8"));
		if (claim.taskId === config.taskId && claim.runnerPid === process.pid) await unlink(slotPath);
	} catch {
		// 槽位已被回收或移除时，不再认为它属于当前 runner。
	}
}

async function finish(result) {
	if (finished) return;
	finished = true;
	if (idleTimer) clearInterval(idleTimer);
	await releaseSlot();
	await writeAtomic(config.terminalPath, {
		...result,
		idleTimedOut,
		killed,
		finishedAt: Date.now(),
	});
}

async function tryClaimSlot() {
	await mkdir(config.slotsDir, { recursive: true, mode: 0o700 });
	for (let index = 0; index < config.slotLimit; index++) {
		const candidate = join(config.slotsDir, `slot-${index}.json`);
		try {
			await writeFile(candidate, JSON.stringify({ taskId: config.taskId, runnerPid: process.pid, claimedAt: Date.now() }), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			slotPath = candidate;
			return true;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const existing = JSON.parse(await readFile(candidate, "utf8"));
				if (!isAlive(existing.runnerPid)) await unlink(candidate);
			} catch {
				// 清理陈旧占用后，其他 runner 可能已经抢先占用该槽位。
			}
		}
	}
	return false;
}

async function waitForSlot() {
	while (!killed) {
		if (await tryClaimSlot()) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

// 空闲超时以输出文件是否增长为准，从进程启动开始计时；排队等待不计入空闲。
function startIdleWatch() {
	if (config.idleTimeoutMs === undefined) return;
	const idleTimeoutMs = config.idleTimeoutMs;
	const checkIntervalMs = Math.max(250, Math.min(1000, Math.floor(idleTimeoutMs / 4)));
	let lastActivityAt = Date.now();
	let lastBytes = -1;
	const check = async () => {
		if (finished || killed) return;
		let bytes = 0;
		try {
			bytes = (await stat(config.outputPath)).size + (await stat(config.stderrPath)).size;
		} catch {
			// 读取失败时沿用上一次读数，避免把瞬时错误当成活动或停滞。
		}
		if (bytes !== lastBytes) {
			lastBytes = bytes;
			lastActivityAt = Date.now();
			return;
		}
		if (Date.now() - lastActivityAt < idleTimeoutMs) return;
		idleTimedOut = true;
		terminate(child?.pid, "SIGTERM");
	};
	idleTimer = setInterval(() => void check(), checkIntervalMs);
	idleTimer.unref();
}

async function start() {
	await writeAtomic(config.statePath, { status: "queued", runnerPid: process.pid });
	if (!(await waitForSlot())) {
		await finish({ exitCode: null, errorMessage: "Task was killed while waiting for a slot." });
		return;
	}

	const stdout = openSync(config.outputPath, "a", 0o600);
	const stderr = openSync(config.stderrPath, "a", 0o600);
	const startedAt = Date.now();
	try {
		child = spawn(config.command, config.args, {
			cwd: config.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", stdout, stderr],
			windowsHide: true,
			env: { ...process.env, PI_SUBAGENT_DEPTH: String(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1) },
		});
		await writeAtomic(config.statePath, { status: "running", runnerPid: process.pid, childPid: child.pid, startedAt });
		startIdleWatch();
		child.once("error", async (error) => {
			await finish({ exitCode: null, errorMessage: `Failed to start background subagent: ${error.message}` });
		});
		child.once("close", async (exitCode, signal) => {
			await finish({ exitCode, signal, startedAt });
		});
	} finally {
		closeSync(stdout);
		closeSync(stderr);
	}
}

process.on("SIGTERM", () => {
	killed = true;
	terminate(child?.pid, "SIGTERM");
});
process.on("SIGINT", () => {
	killed = true;
	terminate(child?.pid, "SIGTERM");
});

try {
	await start();
} catch (error) {
	await finish({ exitCode: null, errorMessage: error instanceof Error ? error.message : String(error) });
}
