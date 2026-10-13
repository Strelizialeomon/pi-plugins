/**
 * `monitor`：把 shell 的输出行或内部任务事件，变成能回到主会话的事件流。
 *
 * 本文件分两层：
 * - 纯逻辑层（下）：stdout 分块切行。单测直接跑。
 * - 接线层（上）：子进程进程组、事件订阅与投递，由 `index.ts` 接进 ExtensionAPI。
 */

import { spawn } from "node:child_process";
import type { TaskProcess } from "./task-runtime.ts";

/**
 * stdout 是流式分块到达的，一块不等于一行。切行器把残行扣住，
 * 等下一块补齐再交出去——不然模型会收到被腰斩的半行。
 */
export class LineSplitter {
	#carry = "";

	/** 返回这一块里已经凑齐的完整行（不含换行符）。 */
	push(chunk: string): string[] {
		if (chunk.length === 0) return [];

		const parts = (this.#carry + chunk).split("\n");
		this.#carry = parts.pop() ?? "";

		return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	}

	/** 进程结束时交出最后那段没有换行的残行。 */
	flush(): string | undefined {
		if (this.#carry.length === 0) return undefined;
		const tail = this.#carry.endsWith("\r") ? this.#carry.slice(0, -1) : this.#carry;
		this.#carry = "";
		return tail;
	}
}

// —— 接线层：跑 shell、收事件、按投递策略往外推 ——

export interface RunningCommand {
	process: TaskProcess;
	result: Promise<{ exitCode: number }>;
}

/**
 * 跑一条 shell 命令并把 stdout 逐行交出去。
 *
 * 独立进程组是这里的关键：`npm test | tee log` 这种写法会拉起孙进程，
 * 只对直接子进程发 SIGTERM 的话，孙进程会留在原地变成孤儿。
 */
export function startShellCommand(input: {
	command: string;
	cwd: string;
	signal?: AbortSignal;
	onLine: (line: string) => void;
}): RunningCommand {
	const child = spawn(input.command, {
		cwd: input.cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	const splitter = new LineSplitter();

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		for (const line of splitter.push(chunk)) input.onLine(line);
	});

	// stderr 声明成 pipe 就必须有人读：管道缓冲写满 64KB 后，
	// 命令会卡在写 stderr 上，而日志恰恰是往 stderr 写的居多。
	const stderrSplitter = new LineSplitter();
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		for (const line of stderrSplitter.push(chunk)) input.onLine(line);
	});

	const emitTail = () => {
		const tail = splitter.flush();
		if (tail !== undefined) input.onLine(tail);
	};

	const exited = new Promise<void>((resolve) => {
		child.on("close", () => resolve());
		child.on("error", () => resolve());
	});

	const result = new Promise<{ exitCode: number }>((resolve) => {
		child.on("close", (code) => {
			emitTail();
			resolve({ exitCode: code ?? 0 });
		});
		child.on("error", () => {
			emitTail();
			resolve({ exitCode: 1 });
		});
	});

	const killGroup = (name: "SIGTERM" | "SIGKILL") => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, name);
		} catch {
			try {
				child.kill(name);
			} catch {
				// 已经退干净了
			}
		}
	};

	if (input.signal) {
		const onAbort = () => killGroup("SIGTERM");
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	return { process: { signal: killGroup, exited }, result };
}
