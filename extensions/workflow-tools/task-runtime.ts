/**
 * 任务运行时：本插件所有后台任务的唯一生命周期管理点。
 *
 * 本文件分两层：
 * - 纯逻辑层（下）：登记表、并发闸、行缓冲。不碰 Pi、不碰进程，单测直接跑。
 * - 接线层（上）：见 `createTaskRuntime()`，把纯逻辑接到 Pi 的事件与子进程上。
 */

export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "expired";
export type TerminalStatus = Exclude<TaskStatus, "running">;
export type TaskKind = "monitor" | "subagent";

export interface TaskRecord {
	id: string;
	kind: TaskKind;
	status: TaskStatus;
	description: string;
	startedAt: number;
	finishedAt?: number;
}

export interface TerminalEvent {
	taskId: string;
	kind: TaskKind;
	status: TerminalStatus;
	description: string;
}

export interface Subscription {
	/** 订阅时该任务已经终态 → 立刻回放快照，不再等新事件。 */
	alreadyFinished: boolean;
	snapshot?: TaskRecord;
	onTerminal(cb: (event: TerminalEvent) => void): void;
	unsubscribe(): void;
}

export interface TaskRegistry {
	create(input: { kind: TaskKind; description: string }): TaskRecord;
	/** 转入终态。返回本次调用是否真的完成了转移；重复调用返回 false（幂等）。 */
	finish(id: string, status: TerminalStatus): boolean;
	snapshot(id: string): TaskRecord | undefined;
	/** 订阅不存在返回 undefined；订阅已终态任务回放快照并标记 alreadyFinished。 */
	subscribe(id: string): Subscription | undefined;
	/** 未终态的任务数。 */
	live(): number;
	list(filter?: { kind?: TaskKind }): TaskRecord[];
}

export function createTaskRegistry(options: { now: () => number }): TaskRegistry {
	const { now } = options;
	const tasks = new Map<string, TaskRecord>();
	const watchers = new Map<string, Set<(event: TerminalEvent) => void>>();
	const counters: Record<TaskKind, number> = { monitor: 0, subagent: 0 };

	function toEvent(task: TaskRecord): TerminalEvent {
		return {
			taskId: task.id,
			kind: task.kind,
			status: task.status as TerminalStatus,
			description: task.description,
		};
	}

	return {
		create({ kind, description }) {
			counters[kind] += 1;
			const task: TaskRecord = {
				id: `${kind}-${counters[kind]}`,
				kind,
				status: "running",
				description,
				startedAt: now(),
			};
			tasks.set(task.id, task);
			return task;
		},

		finish(id, status) {
			const task = tasks.get(id);
			if (!task || task.status !== "running") return false;

			task.status = status;
			task.finishedAt = now();

			// 终态只发一次：先取走监听器再回调，重复 finish 早已被上面的守卫挡掉。
			const listeners = watchers.get(id);
			watchers.delete(id);
			if (listeners) {
				const event = toEvent(task);
				for (const listener of listeners) listener(event);
			}
			return true;
		},

		snapshot(id) {
			const task = tasks.get(id);
			return task ? { ...task } : undefined;
		},

		subscribe(id) {
			const task = tasks.get(id);
			if (!task) return undefined;

			if (task.status !== "running") {
				return {
					alreadyFinished: true,
					snapshot: { ...task },
					onTerminal() {
						/* 已终态，不会再产生新事件 */
					},
					unsubscribe() {
						/* 没有登记，无需清理 */
					},
				};
			}

			const listeners = new Set<(event: TerminalEvent) => void>();
			watchers.set(id, listeners);

			return {
				alreadyFinished: false,
				onTerminal(cb) {
					listeners.add(cb);
				},
				unsubscribe() {
					listeners.clear();
					if (watchers.get(id) === listeners) watchers.delete(id);
				},
			};
		},

		live() {
			let count = 0;
			for (const task of tasks.values()) if (task.status === "running") count += 1;
			return count;
		},

		list(filter) {
			const all = [...tasks.values()].map((task) => ({ ...task }));
			return filter?.kind ? all.filter((task) => task.kind === filter.kind) : all;
		},
	};
}

// —— 并发闸：会话级上限 ——

export type GateTicket =
	| { ok: true; position: number; ready: Promise<void>; release(): void }
	| { ok: false; reason: "concurrency_exceeded" };

export interface ConcurrencyGate {
	/**
	 * 申请一个任务位。`position === 0` 表示立刻可运行；大于 0 表示排在队列里，
	 * 要 `await ticket.ready` 才能开工。超过 `maxTasks` 直接拒绝。
	 */
	enter(): GateTicket;
	live(): number;
	running(): number;
}

export function createConcurrencyGate(limits: { maxTasks: number; maxRunning: number }): ConcurrencyGate {
	const { maxTasks, maxRunning } = limits;
	let live = 0;
	let running = 0;
	const queue: Array<{ grant: () => void }> = [];

	function pump() {
		while (running < maxRunning && queue.length > 0) {
			const next = queue.shift();
			if (!next) break;
			running += 1;
			next.grant();
		}
	}

	return {
		enter() {
			if (live >= maxTasks) return { ok: false, reason: "concurrency_exceeded" };
			live += 1;
			let released = false;

			// 有空槽：立刻可运行
			if (running < maxRunning) {
				running += 1;
				return {
					ok: true,
					position: 0,
					ready: Promise.resolve(),
					release() {
						if (released) return;
						released = true;
						live -= 1;
						running -= 1;
						pump();
					},
				};
			}

			// 没空槽：排队，等别人释放时被 pump 提升
			let promoted = false;
			let settle!: () => void;
			const ready = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const entry = {
				grant: () => {
					promoted = true;
					settle();
				},
			};
			queue.push(entry);

			return {
				ok: true,
				position: queue.length,
				ready,
				release() {
					if (released) return;
					released = true;
					live -= 1;

					if (promoted) {
						running -= 1;
						pump();
						return;
					}

					// 还在排队就被取消：从队列摘掉，并让 ready 落定，免得上游永远挂着。
					// 调用方在 release 之后必须自行放弃 spawn。
					const at = queue.indexOf(entry);
					if (at >= 0) queue.splice(at, 1);
					settle();
				},
			};
		},

		live: () => live,
		running: () => running,
	};
}

// —— 行处理：单行截断与环形缓冲 ——

const TRUNCATION_MARKER = "…[truncated]";

export function truncateLine(line: string, max: number): string {
	if (line.length <= max) return line;
	if (max <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, max);
	return line.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// —— 投递策略：进度合并进上下文，终态单独必推 ——

export type DeliverMode = "digest" | "terminal";

export const DEFAULT_DIGEST_WINDOW_MS = 30_000;
const DIGEST_KEEP_LINES = 20;
const DIGEST_MAX_LINE = 4096;

export interface Delivery {
	/** 进度事件。返回要进模型上下文的消息；返回 undefined 表示这条只落缓冲与日志。 */
	progress(line: string, at: number): string | undefined;
	/** 任务收尾时把窗口里攒下的行冲成最后一条摘要。 */
	flush(): string | undefined;
	messages(): string[];
}

/**
 * 决定哪些进度事件能进模型上下文。恒定约束：一个 30 秒窗口最多推一条，
 * `terminal` 档一条都不推——逐行推送会把上下文和回合数一起打爆。
 */
export function createDelivery(options: {
	mode: DeliverMode;
	windowMs?: number;
	keepLines?: number;
}): Delivery {
	const mode = options.mode;
	const windowMs = options.windowMs ?? DEFAULT_DIGEST_WINDOW_MS;
	const keep = Math.max(1, options.keepLines ?? DIGEST_KEEP_LINES);

	let windowStart: number | undefined;
	let merged = 0;
	let recent: string[] = [];
	const messages: string[] = [];

	function remember(line: string) {
		merged += 1;
		recent.push(line);
		if (recent.length > keep) recent.shift();
	}

	function emit(): string {
		const text = [`[${merged} 行合并]`, ...recent.map((line) => truncateLine(line, DIGEST_MAX_LINE))].join("\n");
		messages.push(text);
		merged = 0;
		recent = [];
		return text;
	}

	return {
		progress(line, at) {
			if (mode === "terminal") return undefined;

			if (windowStart === undefined) {
				windowStart = at;
				remember(line);
				return undefined;
			}

			remember(line);
			if (at - windowStart < windowMs) return undefined;

			windowStart = at;
			return emit();
		},

		flush() {
			if (mode === "terminal" || merged === 0) return undefined;
			return emit();
		},

		messages: () => [...messages],
	};
}

export class LineRing {
	readonly capacity: number;
	#lines: string[] = [];

	constructor(capacity: number) {
		this.capacity = Math.max(0, Math.trunc(capacity));
	}

	/** 返回被挤出的行（供写日志文件）；没有挤出则返回 undefined。 */
	push(line: string): string | undefined {
		if (this.capacity === 0) return line;
		this.#lines.push(line);
		if (this.#lines.length > this.capacity) return this.#lines.shift();
		return undefined;
	}

	toArray(): string[] {
		return [...this.#lines];
	}
}

// —— 接线层：把上面三块接到 Pi 与子进程上 ——

/** 子进程句柄。`signal` 打的是整个进程组，不只是直接子进程。 */
export interface TaskProcess {
	signal(name: "SIGTERM" | "SIGKILL"): void;
	/** 进程真正退出后 resolve。 */
	exited: Promise<void>;
}

/** 运行时往外说话的通道。抽出来是为了让收尾顺序能在单测里断言。 */
export interface RuntimeSink {
	/** 终态必推：实现里必须走 `triggerTurn: true`，会话空闲时也要唤醒模型。 */
	pushTerminal(input: { taskId: string; status: TerminalStatus; text: string }): void;
	/** 进度摘要。只有 digest 档会调到。带 kind / description 是为了让多个任务并行时能认出是谁。 */
	pushProgress(input: { taskId: string; kind: TaskKind; description: string; text: string }): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	status(key: string, text: string | undefined): void;
}

export interface RunningTask {
	id: string;
	kind: TaskKind;
	record: TaskRecord;
	delivery: Delivery;
	ring: LineRing;
	controller: AbortController;
	/** 归还并发槽。任务转入终态时必须调，否则名额会永久泄漏。 */
	release(): void;
	/** 终态是否往外推。前台任务由工具返回值带走结果，置 false。 */
	announce: boolean;
	/**
	 * 取消方事先声明的终态。被信号杀死的进程 `close` 给的是 `code=null`，
	 * 结果回调会当成正常退出抢先写 `completed`；有了它，谁先到都按声明记。
	 */
	intent?: TerminalStatus;
	log?: LogSink;
}

/** 完整日志的落点。spec 要求环形缓冲之外还得有全量日志。 */
export interface LogSink {
	path: string;
	write(line: string): void;
	close(): void;
}

export type BeginResult =
	| { ok: true; task: RunningTask; position: number; ready: Promise<void> }
	| { ok: false; reason: "concurrency_exceeded" | "shutting_down" };

export interface TaskRuntime {
	begin(input: {
		kind: TaskKind;
		description: string;
		deliver: DeliverMode;
		ringCapacity?: number;
		/** 前台任务的结果由工具返回值带走，不必再推一条终态。默认推。 */
		announce?: boolean;
	}): BeginResult;
	progress(id: string, line: string): void;
	/**
	 * 只落环形缓冲与完整日志，不参与 digest 投递。
	 * 子会话要把事件流摊成有用的行记进来看，就走这条——
	 * 走 progress 会让每个事件都进 digest 窗口。
	 */
	record(id: string, line: string): void;
	/** 转入终态；返回是否真的完成了转移。收尾期内的转移只记状态、不再往外推。 */
	finish(id: string, status: TerminalStatus): boolean;
	subscribe(id: string): Subscription | undefined;
	get(id: string): RunningTask | undefined;
	attachProcess(id: string, process: TaskProcess): void;
	/** 取消单个任务：打进程组，并按统一策略升级到 SIGKILL。`intent` 决定记成什么终态。 */
	stop(id: string, intent?: TerminalStatus): boolean;
	/** 会话收尾：置位 → 打进程组 → await 真正退出。 */
	shutdown(): Promise<void>;
	isShuttingDown(): boolean;
	live(): number;
	running(): number;
}

const KILL_ESCALATION_MS = 5000;
const STATUS_KEY = "workflow-tools";

export function createTaskRuntime(options: {
	sink: RuntimeSink;
	now: () => number;
	limits: { maxTasks: number; maxRunning: number };
	/** 测试用：把「等 5 秒」换掉，避免单测真的睡 5 秒。 */
	sleep?: (ms: number) => Promise<void>;
	/** 完整日志的落点。不提供就不写日志（单测走这条）。 */
	openLog?: (taskId: string) => LogSink;
	/** 收尾时等待进程退出的上限，超过就不再干等。 */
	exitWaitMs?: number;
}): TaskRuntime {
	const { sink, now, limits } = options;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const exitWaitMs = options.exitWaitMs ?? 10_000;
	const registry = createTaskRegistry({ now });
	const gate = createConcurrencyGate(limits);
	const tasks = new Map<string, RunningTask>();
	const processes = new Map<string, TaskProcess>();

	let shuttingDown = false;

	async function terminate(id: string): Promise<void> {
		const proc = processes.get(id);
		if (!proc) return;
		proc.signal("SIGTERM");

		const exited = await Promise.race([
			proc.exited.then(() => true),
			sleep(KILL_ESCALATION_MS).then(() => false),
		]);
		if (!exited) {
			// 注意：不能拿 `child.killed` 判断——信号送达它就为 true，进程可能还活着。
			proc.signal("SIGKILL");
			// 这一等必须有上限：`exited` 挂的是子进程的 close，而 close 要等所有 stdio 关闭。
			// 孙进程若逃到别的进程组又攥着管道，没有上限就会把 /reload 永久卡住。
			await Promise.race([proc.exited, sleep(exitWaitMs)]);
		}
		processes.delete(id);
	}

	function terminalText(task: RunningTask, status: TerminalStatus, logPath?: string): string {
		const tail = task.ring.toArray().slice(-5);
		const head = `任务 ${task.id}（${task.kind}）${status}：${task.record.description}`;
		const body = tail.length > 0 ? `${head}\n最后几行：\n${tail.join("\n")}` : head;
		return logPath ? `${body}\n完整日志：${logPath}` : body;
	}

	const TERMINAL_LABELS: Record<TerminalStatus, string> = {
		completed: "完成",
		failed: "失败",
		stopped: "已停止",
		expired: "超时",
	};

	function refreshStatus() {
		try {
			const live = registry.live();
			if (live === 0) {
				sink.status(STATUS_KEY, undefined);
				return;
			}
			const latest = [...tasks.values()].at(-1);
			const tail = latest?.ring.toArray().at(-1);
			sink.status(STATUS_KEY, `运行中：${live}${tail ? ` · ${truncateLine(tail, 60)}` : ""}`);
		} catch {
			// 界面通道抛错不该影响任务状态
		}
	}

	function finish(id: string, status: TerminalStatus): boolean {
		const task = tasks.get(id);
		if (!task) return false;

		// 取消方声明的终态优先：被信号杀死的进程 close 给的是 code=null，
		// 结果回调会把它当成正常退出、抢先写 completed。
		const effective = task.intent ?? status;
		if (!registry.finish(id, effective)) return false;

		task.release();

		try {
			task.log?.close();
			// 收尾期开始后的推送直接丢弃，不写进已被替换的旧会话。
			if (!shuttingDown && task.announce) {
				task.delivery.flush();
				sink.pushTerminal({
					taskId: id,
					status: effective,
					text: terminalText(task, effective, task.log?.path),
				});
				sink.notify(
					`任务${TERMINAL_LABELS[effective]}：${task.record.description}`,
					effective === "completed" ? "info" : "warning",
				);
			}
		} catch {
			// 界面通道坏了不该拖住清理
		} finally {
			tasks.delete(id);
			processes.delete(id);
			refreshStatus();
		}
		return true;
	}

	return {
		begin({ kind, description, deliver, ringCapacity, announce }) {
			if (shuttingDown) return { ok: false, reason: "shutting_down" };

			const ticket = gate.enter();
			if (!ticket.ok) return { ok: false, reason: ticket.reason };

			const record = registry.create({ kind, description });
			const task: RunningTask = {
				id: record.id,
				kind,
				record,
				delivery: createDelivery({ mode: deliver }),
				ring: new LineRing(ringCapacity ?? 200),
				controller: new AbortController(),
				release: ticket.release,
				announce: announce ?? true,
				...(options.openLog ? { log: options.openLog(record.id) } : {}),
			};
			tasks.set(task.id, task);
			refreshStatus();

			return { ok: true, task, position: ticket.position, ready: ticket.ready };
		},

		record(id, line) {
			const task = tasks.get(id);
			if (!task || shuttingDown) return;
			task.ring.push(line);
			// 环形缓冲只留最近 200 行，被挤掉的靠日志文件兜住
			task.log?.write(line);
		},

		progress(id, line) {
			const task = tasks.get(id);
			if (!task || shuttingDown) return;
			task.ring.push(line);
			task.log?.write(line);
			const digest = task.delivery.progress(line, now());
			if (digest !== undefined) {
				sink.pushProgress({ taskId: id, kind: task.kind, description: task.record.description, text: digest });
			}
		},

		finish,
		subscribe: (id) => registry.subscribe(id),
		get: (id) => tasks.get(id),
		attachProcess(id, process) {
			const task = tasks.get(id);
			// 任务已终态、或会话已在收尾时不能只登记：这段窗口里进程早就起来了，
			// 登记完就再没人管它——它会带着独立进程组活过 Pi 退出。
			if (!task || shuttingDown) {
				process.signal("SIGTERM");
				return;
			}
			processes.set(id, process);
		},

		stop(id, intent: TerminalStatus = "stopped") {
			const task = tasks.get(id);
			if (!task) return false;
			// 先声明意图再 abort：结果回调不管多早到，都会被这个 intent 压住。
			task.intent = intent;
			task.controller.abort();
			void terminate(id).then(() => finish(id, intent));
			return true;
		},

		async shutdown() {
			shuttingDown = true;
			await Promise.all([...tasks.keys()].map((id) => terminate(id)));
			for (const id of [...tasks.keys()]) finish(id, "stopped");
			tasks.clear();
			processes.clear();
			refreshStatus();
		},

		isShuttingDown: () => shuttingDown,
		live: () => registry.live(),
		running: () => gate.running(),
	};
}
