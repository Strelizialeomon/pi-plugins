import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskRegistry, createConcurrencyGate, createDelivery, createTaskRuntime, truncateLine, LineRing } from "./task-runtime.ts";

// —— 接线层的测试替身 ——

function makeRuntime() {
	const pushed: Array<{ taskId: string; status: string; text: string }> = [];
	const progress: string[] = [];
	const statuses: Array<string | undefined> = [];
	let clock = 0;

	const runtime = createTaskRuntime({
		sink: {
			pushTerminal: (input) => void pushed.push(input),
			pushProgress: (input) => void progress.push(input.text),
			notify: () => {},
			status: (_key, text) => void statuses.push(text),
		},
		now: () => (clock += 1000),
		limits: { maxTasks: 8, maxRunning: 4 },
		// 单测里不能让「等 5 秒再 SIGKILL」真的睡 5 秒
		sleep: async () => {},
	});
	return { runtime, pushed, progress, statuses };
}

/** 假子进程：记下收到的信号，可配置是否在 SIGTERM 时退出。 */
function makeProcess(options: { exitOnSigterm?: boolean } = {}) {
	const signals: string[] = [];
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	return {
		signals,
		exited,
		handle: {
			signal(name: "SIGTERM" | "SIGKILL") {
				signals.push(name);
				if (name === "SIGKILL" || options.exitOnSigterm !== false) resolveExit();
			},
			exited,
		},
	};
}

test("begin 在收尾期之后被拒，理由是 shutting_down", async () => {
	const { runtime } = makeRuntime();
	await runtime.shutdown();
	const result = runtime.begin({ kind: "monitor", description: "x", deliver: "digest" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "shutting_down");
});

test("终态推且只推一条；重复 finish 不再推", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "干活", deliver: "digest" });
	assert.ok(begun.ok);
	if (!begun.ok) return;

	assert.equal(runtime.finish(begun.task.id, "completed"), true);
	assert.equal(runtime.finish(begun.task.id, "failed"), false);
	assert.equal(pushed.length, 1);
	assert.equal(pushed[0]?.status, "completed");
});

test("终态正文带上任务 ID，模型才认得出是哪个任务回来了", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "subagent", description: "审 spec", deliver: "terminal" });
	if (!begun.ok) return;
	runtime.finish(begun.task.id, "completed");
	assert.ok(pushed[0]?.text.includes(begun.task.id));
});

test("任务转入终态后并发槽归还，live 回落", () => {
	const { runtime } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "a", deliver: "digest" });
	if (!begun.ok) return;
	assert.equal(runtime.live(), 1);
	runtime.finish(begun.task.id, "completed");
	assert.equal(runtime.live(), 0);
});

test("第 9 个任务被拒，理由 concurrency_exceeded", () => {
	const { runtime } = makeRuntime();
	for (let i = 0; i < 8; i++) {
		const begun = runtime.begin({ kind: "monitor", description: `m${i}`, deliver: "digest" });
		assert.equal(begun.ok, true);
	}
	const ninth = runtime.begin({ kind: "monitor", description: "m9", deliver: "digest" });
	assert.equal(ninth.ok, false);
	if (!ninth.ok) assert.equal(ninth.reason, "concurrency_exceeded");
});

test("第 5 个排队，position 从 1 开始", () => {
	const { runtime } = makeRuntime();
	for (let i = 0; i < 4; i++) runtime.begin({ kind: "monitor", description: `m${i}`, deliver: "digest" });
	const queued = runtime.begin({ kind: "monitor", description: "m5", deliver: "digest" });
	assert.ok(queued.ok);
	if (queued.ok) assert.equal(queued.position, 1);
});

test("stop 会打进程组 SIGTERM 并转成 stopped 终态", async () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "subagent", description: "跑", deliver: "digest" });
	if (!begun.ok) return;

	const proc = makeProcess();
	runtime.attachProcess(begun.task.id, proc.handle);

	assert.equal(runtime.stop(begun.task.id), true);
	await proc.exited;
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(proc.signals, ["SIGTERM"]);
	assert.equal(pushed.at(-1)?.status, "stopped");
});

test("SIGTERM 不奏效时升级到整个进程组 SIGKILL", async () => {
	const { runtime } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "倔", deliver: "digest" });
	if (!begun.ok) return;

	const proc = makeProcess({ exitOnSigterm: false });
	runtime.attachProcess(begun.task.id, proc.handle);

	await runtime.shutdown();
	assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
});

test("shutdown 置位后到达的终态不再往外推（不写进已被替换的旧会话）", async () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "迟到", deliver: "digest" });
	if (!begun.ok) return;

	await runtime.shutdown();
	runtime.finish(begun.task.id, "completed");
	assert.deepEqual(pushed, []);
});

test("shutdown 会把还活着的任务全部收成 stopped", async () => {
	const { runtime } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "a", deliver: "digest" });
	if (!begun.ok) return;
	const proc = makeProcess();
	runtime.attachProcess(begun.task.id, proc.handle);

	await runtime.shutdown();
	assert.equal(runtime.live(), 0);
	assert.ok(runtime.isShuttingDown());
	assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("announce: false 的任务不推终态 —— 前台结果由工具返回值带走", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "subagent", description: "前台跑", deliver: "digest", announce: false });
	if (!begun.ok) return;

	assert.equal(runtime.finish(begun.task.id, "completed"), true);
	assert.deepEqual(pushed, [], "前台任务不该再推一条终态，否则模型收到两遍");
});

test("announce 缺省为 true：后台任务必须推终态", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "subagent", description: "后台跑", deliver: "digest" });
	if (!begun.ok) return;

	runtime.finish(begun.task.id, "completed");
	assert.equal(pushed.length, 1);
});

test("被取消的任务：结果回调先到也记成 stopped，不记成 completed", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "倔", deliver: "digest" });
	if (!begun.ok) return;

	const proc = makeProcess({ exitOnSigterm: false });
	runtime.attachProcess(begun.task.id, proc.handle);

	runtime.stop(begun.task.id, "stopped");
	// 模拟「进程 close 给 code=null，结果回调抢先记成正常退出」
	runtime.finish(begun.task.id, "completed");

	assert.equal(pushed.at(-1)?.status, "stopped");
});

test("超时同样按 expired 记，不被正常退出覆盖", () => {
	const { runtime, pushed } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "慢", deliver: "digest" });
	if (!begun.ok) return;

	runtime.stop(begun.task.id, "expired");
	runtime.finish(begun.task.id, "completed");
	assert.equal(pushed.at(-1)?.status, "expired");
});

test("提供 openLog 时，进度行会落到完整日志里（环形缓冲只有 200 行）", () => {
	const lines: string[] = [];
	const runtime = createTaskRuntime({
		sink: { pushTerminal: () => {}, pushProgress: () => {}, notify: () => {}, status: () => {} },
		now: () => 0,
		limits: { maxTasks: 8, maxRunning: 4 },
		sleep: async () => {},
		openLog: () => ({ path: "/tmp/fake.log", write: (line) => void lines.push(line), close: () => {} }),
	});

	const begun = runtime.begin({ kind: "monitor", description: "日志", deliver: "terminal" });
	if (!begun.ok) return;
	for (let i = 0; i < 300; i++) runtime.progress(begun.task.id, `line ${i}`);

	assert.equal(lines.length, 300, "日志要留全量");
	assert.equal(lines[299], "line 299");
});

test("收尾期之后再 attachProcess 的进程会被就地打死，不留孤儿", () => {
	const { runtime } = makeRuntime();
	const begun = runtime.begin({ kind: "subagent", description: "在途", deliver: "digest" });
	if (!begun.ok) return;

	// 模拟 begin 之后、attach 之前会话开始收尾
	void runtime.shutdown();

	const proc = makeProcess();
	runtime.attachProcess(begun.task.id, proc.handle);
	assert.deepEqual(proc.signals, ["SIGTERM"], "逃过收尾窗口的进程必须被就地打死");
});

test("收到进度行时不越权推上下文（digest 窗口内静默）", () => {
	const { runtime, progress } = makeRuntime();
	const begun = runtime.begin({ kind: "monitor", description: "日志", deliver: "digest" });
	if (!begun.ok) return;

	runtime.progress(begun.task.id, "第一行");
	runtime.progress(begun.task.id, "第二行");
	assert.deepEqual(progress, [], "同一个 30 秒窗口内不该推 —— 每行 now() 只差 1 秒");
});

// —— 任务登记表：ID / 状态 / 终态幂等 / 订阅回放 ——

test("每个任务拿到唯一 ID，初始为 running", () => {
	const reg = createTaskRegistry({ now: () => 1000 });
	const a = reg.create({ kind: "monitor", description: "a" });
	const b = reg.create({ kind: "subagent", description: "b" });

	assert.notEqual(a.id, b.id);
	assert.equal(a.status, "running");
	assert.equal(a.kind, "monitor");
	assert.equal(a.startedAt, 1000);
});

test("终态只生效一次，后续 finish 幂等且不覆盖首个终态", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const t = reg.create({ kind: "monitor", description: "x" });

	assert.equal(reg.finish(t.id, "completed"), true, "首次转移应生效");
	assert.equal(reg.finish(t.id, "failed"), false, "重复 finish 应被拒绝");
	assert.equal(reg.finish(t.id, "stopped"), false);
	assert.equal(reg.snapshot(t.id)?.status, "completed", "终态应保持首次的值");
});

test("finish 未知 ID 返回 false，不抛错", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	assert.equal(reg.finish("nope", "completed"), false);
});

test("订阅运行中的任务：拿到取消订阅句柄，尚未终态", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const t = reg.create({ kind: "subagent", description: "r" });

	const sub = reg.subscribe(t.id);
	assert.ok(sub, "订阅运行中的任务应拿到句柄");
	assert.equal(sub.alreadyFinished, false);
	assert.equal(sub.snapshot, undefined);
	assert.equal(typeof sub.unsubscribe, "function");
});

test("订阅已终态的任务：立即回放终态快照并标记 alreadyFinished", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const t = reg.create({ kind: "subagent", description: "r" });
	reg.finish(t.id, "failed");

	const sub = reg.subscribe(t.id);
	assert.ok(sub, "订阅已终态任务也应拿到快照句柄");
	assert.equal(sub.alreadyFinished, true);
	assert.equal(sub.snapshot?.status, "failed");
	assert.equal(sub.snapshot?.id, t.id);
});

test("订阅不存在的任务返回 undefined", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	assert.equal(reg.subscribe("nope"), undefined);
});

test("终态变化通知订阅者恰一次（订阅者不产生第二条终态）", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const t = reg.create({ kind: "monitor", description: "m" });
	const seen: string[] = [];
	reg.subscribe(t.id)?.onTerminal((e) => seen.push(e.status));

	reg.finish(t.id, "completed");
	reg.finish(t.id, "failed");
	reg.finish(t.id, "stopped");

	assert.deepEqual(seen, ["completed"]);
});

test("取消订阅后不再收到终态", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const t = reg.create({ kind: "monitor", description: "m" });
	const seen: string[] = [];
	const sub = reg.subscribe(t.id);
	sub?.onTerminal((e) => seen.push(e.status));
	sub?.unsubscribe();

	reg.finish(t.id, "completed");
	assert.deepEqual(seen, []);
});

test("live 只数未终态的任务；list 可按 kind 过滤", () => {
	const reg = createTaskRegistry({ now: () => 0 });
	const a = reg.create({ kind: "monitor", description: "a" });
	reg.create({ kind: "subagent", description: "b" });

	assert.equal(reg.live(), 2);
	reg.finish(a.id, "completed");
	assert.equal(reg.live(), 1);
	assert.equal(reg.list({ kind: "monitor" }).length, 1);
	assert.equal(reg.list({ kind: "subagent" }).length, 1);
});

// —— 并发闸：会话级 8 任务 / 4 运行 ——

test("前 4 个直接拿到运行槽，位置为 0", () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	for (let i = 0; i < 4; i++) {
		const ticket = gate.enter();
		assert.equal(ticket.ok, true);
		if (ticket.ok) assert.equal(ticket.position, 0);
	}
});

test("第 5～8 个排队并报告排位，位置从 1 递增", () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	for (let i = 0; i < 4; i++) gate.enter();

	const positions: number[] = [];
	for (let i = 0; i < 4; i++) {
		const ticket = gate.enter();
		assert.equal(ticket.ok, true);
		if (ticket.ok) positions.push(ticket.position);
	}
	assert.deepEqual(positions, [1, 2, 3, 4]);
});

test("第 9 个被拒，理由 concurrency_exceeded", () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	for (let i = 0; i < 8; i++) gate.enter();

	const ticket = gate.enter();
	assert.equal(ticket.ok, false);
	if (!ticket.ok) assert.equal(ticket.reason, "concurrency_exceeded");
});

test("释放运行槽后，队首被提升为运行", async () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	const first = gate.enter();
	for (let i = 0; i < 3; i++) gate.enter();
	const queued = gate.enter();
	assert.equal(queued.ok, true);
	if (!queued.ok) return;
	assert.equal(queued.position, 1);

	let promoted = false;
	void queued.ready.then(() => {
		promoted = true;
	});
	if (first.ok) first.release();
	await queued.ready;
	assert.equal(promoted, true);
});

test("释放会让 live 数回落，被拒的调用可以再次进来", () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	const tickets = [];
	for (let i = 0; i < 8; i++) tickets.push(gate.enter());
	assert.equal(gate.enter().ok, false);

	const one = tickets[0];
	if (one.ok) one.release();
	assert.equal(gate.enter().ok, true);
});

test("重复 release 不会把计数放成负数", () => {
	const gate = createConcurrencyGate({ maxTasks: 8, maxRunning: 4 });
	const t = gate.enter();
	if (t.ok) {
		t.release();
		t.release();
	}
	assert.equal(gate.live(), 0);
	assert.equal(gate.running(), 0);
});

// —— 行处理：环形缓冲与单行截断 ——

test("单行按 4096 字符截断，短行原样返回", () => {
	assert.equal(truncateLine("short", 4096), "short");
	const long = "x".repeat(5000);
	const cut = truncateLine(long, 4096);
	assert.equal(cut.length, 4096);
	assert.ok(cut.startsWith("x".repeat(10)));
});

test("截断保留标记，让模型看得出被截了", () => {
	const cut = truncateLine("x".repeat(5000), 4096);
	assert.ok(cut.includes("[truncated"), `实际尾部：${cut.slice(-40)}`);
});

test("环形缓冲只保留最近 N 行，超出的从头部丢弃", () => {
	const ring = new LineRing(3);
	ring.push("a");
	ring.push("b");
	ring.push("c");
	ring.push("d");
	assert.deepEqual(ring.toArray(), ["b", "c", "d"]);
});

test("环形缓冲 push 返回被挤出的行（供写日志文件）", () => {
	const ring = new LineRing(2);
	assert.equal(ring.push("a"), undefined);
	ring.push("b");
	assert.equal(ring.push("c"), "a");
});

test("环形缓冲容量为 0 时不保留任何行但不抛错", () => {
	const ring = new LineRing(0);
	ring.push("a");
	assert.deepEqual(ring.toArray(), []);
});

// —— 投递策略：进度合并，终态必推 ——

test("deliver: terminal —— 进度一条都不进上下文", () => {
	const d = createDelivery({ mode: "terminal" });
	for (let t = 0; t < 300_000; t += 1000) {
		assert.equal(d.progress(`line ${t}`, t), undefined);
	}
	assert.deepEqual(d.messages(), []);
});

test("deliver: terminal —— 没有可冲的尾巴", () => {
	const d = createDelivery({ mode: "terminal" });
	d.progress("a", 0);
	assert.equal(d.flush(), undefined);
});

test("默认 digest —— 窗口内的行不单独推，跨窗口才合成一条", () => {
	const d = createDelivery({ mode: "digest" });
	assert.equal(d.progress("a", 0), undefined);
	assert.equal(d.progress("b", 1000), undefined);
	assert.equal(d.progress("c", 29_999), undefined);
	const digest = d.progress("d", 30_000);
	assert.ok(digest, "跨过 30 秒窗口应推出摘要");
	assert.deepEqual(d.messages().length, 1);
});

test("窗口边界按 >= 判定：正好 30 秒即开新窗口", () => {
	const d = createDelivery({ mode: "digest" });
	d.progress("a", 0);
	assert.ok(d.progress("b", 30_000));
});

test("摘要里带合并行数，模型看得出中间被省了", () => {
	const d = createDelivery({ mode: "digest" });
	for (let i = 0; i < 5; i++) d.progress(`line ${i}`, i * 100);
	const digest = d.progress("line 5", 30_000);
	assert.ok(/^\[\d+ 行合并\]/.test(digest ?? ""), `摘要应带合并行数，实际开头：${digest?.slice(0, 20)}`);
	assert.ok(digest?.includes("line 5"), "摘要要保留最新行");
});

test("摘要里的单行也过 4096 字符截断", () => {
	const d = createDelivery({ mode: "digest" });
	d.progress("x".repeat(9000), 0);
	const digest = d.progress("tail", 30_000);
	assert.ok(digest);
	for (const line of digest.split("\n")) assert.ok(line.length <= 4096, `有超长行：${line.length}`);
});

test("任务结束时把窗口里剩下的行冲出来", () => {
	const d = createDelivery({ mode: "digest" });
	d.progress("a", 0);
	d.progress("b", 1000);
	const tail = d.flush();
	assert.ok(tail?.includes("b"));
	assert.equal(d.messages().length, 1);
});

test("缓冲为空时 flush 不推空消息", () => {
	const d = createDelivery({ mode: "digest" });
	assert.equal(d.flush(), undefined);
	assert.deepEqual(d.messages(), []);
});

test("可量化验收：5 分钟 × 每秒 1 行，进上下文的消息 ≤ ⌈300s/30s⌉ + 1", () => {
	const d = createDelivery({ mode: "digest" });
	for (let t = 0; t < 300_000; t += 1000) d.progress(`line ${t}`, t);
	d.flush();
	assert.ok(
		d.messages().length <= Math.ceil(300_000 / 30_000) + 1,
		`实际推出 ${d.messages().length} 条，超出窗口上限`,
	);
});

test("可量化验收：10 万行输出在 terminal 档只产生 1 条上下文消息（终态那条）", () => {
	const d = createDelivery({ mode: "terminal" });
	for (let i = 0; i < 100_000; i++) d.progress(`line ${i}`, i);
	d.flush();
	// 进度 0 条；终态由运行时必推 1 条，不经过 delivery
	assert.equal(d.messages().length, 0);
});
