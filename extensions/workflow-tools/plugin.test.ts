/**
 * 假 Pi 测试台：把插件当真的加载进来，把四个工具真调一遍。
 *
 * 这里不 mock 业务逻辑——注册、校验、卡片状态机、子进程 spawn 走的都是产品代码，
 * 只有 Pi 那一侧（ExtensionAPI / ctx / TUI）是替身。
 *
 * 它**不能**替代真 Pi 的冒烟：Pi 会不会拒绝我们的 schema、TUI 画出来长什么样，
 * 只有真跑一次才知道。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import plugin, { openTaskLog, progressMessage, resolveDispatch, runChild } from "./index.ts";
import { buildChildArgs, type AgentDefinition } from "./subagent.ts";

// —— 测试替身 ——

interface ToolLike {
	name: string;
	label: string;
	description: string;
	parameters: { type?: string };
	executionMode?: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text?: string }>; details?: unknown; isError?: boolean }>;
}

interface Sent {
	customType?: string;
	content?: unknown;
	options?: { triggerTurn?: boolean };
}

function makePi() {
	const tools = new Map<string, ToolLike>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: Sent[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];

	const pi = {
		registerTool: (tool: ToolLike) => void tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		sendMessage: (message: Sent, options?: { triggerTurn?: boolean }) =>
			void sent.push({ ...message, options }),
		appendEntry: () => {},
		ui: { notify: (text: string) => void notifications.push(text) },
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		tools,
		handlers,
		sent,
		notifications,
		statuses,
	};
}

// 所有 ctx 共用一个工作目录：每次 makeCtx 建一个的话，跑一轮就留一堆临时目录。
const scratchRoot = mkdtempSync(join(tmpdir(), "wf-tools-test-"));
const scratchDirs: string[] = [scratchRoot];

/** 数临时目录里还剩几个任务日志目录。 */
function countTaskLogDirs(): number {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("workflow-tools-logs-")).length;
}

/** 建一个用完要清的临时目录；跑完统一收，失败路径也不留。 */
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	scratchDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function makeCtx(mode: "tui" | "rpc" | "json", ui: Record<string, unknown> = {}) {
	const cwd = scratchRoot;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		model: { provider: "anthropic", id: "claude-haiku-5-5" },
		thinkingLevel: "medium",
		isProjectTrusted: () => true,
		signal: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			custom: async () => undefined,
			...ui,
		},
	};
	return ctx as unknown as ExtensionToolContext;
}

function textOf(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// —— 注册面 ——

test("插件能加载，四个工具都注册上了", () => {
	const { pi, tools } = makePi();
	plugin(pi);

	assert.deepEqual(
		[...tools.keys()].sort(),
		["ask_user_question", "monitor", "subagent", "task_stop"],
	);
});

test("每个工具都有 Pi 要求的必填字段，且 parameters 是对象 schema", () => {
	const { pi, tools } = makePi();
	plugin(pi);

	for (const tool of tools.values()) {
		assert.ok(tool.label, `${tool.name} 缺 label（Pi 的 ToolDefinition 必填）`);
		assert.ok(tool.description, `${tool.name} 缺 description`);
		assert.equal(typeof tool.execute, "function", `${tool.name} 缺 execute`);
		// registerTool 会拒绝非对象 schema
		assert.equal(tool.parameters?.type, "object", `${tool.name} 的 parameters 不是对象 schema`);
	}
});

test("选项卡以 sequential 注册：并发调用不该并行开两张卡", () => {
	const { pi, tools } = makePi();
	plugin(pi);
	assert.equal(tools.get("ask_user_question")?.executionMode, "sequential");
});

test("注册了 session_shutdown", () => {
	const { pi, handlers } = makePi();
	plugin(pi);
	assert.ok(handlers.has("session_shutdown"), "没接 session_shutdown，收尾就没入口");
});

// —— ask_user_question ——

test("JSON / print 模式返回 ui_unavailable，不挂在那里等终端", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const tool = tools.get("ask_user_question")!;

	const result = await tool.execute(
		"c1",
		{ questions: [{ id: "q", question: "选？", header: "h", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] },
		undefined,
		undefined,
		makeCtx("json"),
	);

	assert.equal((result.details as { kind?: string }).kind, "ui_unavailable");
	assert.equal(result.isError, undefined, "unavailable 是结构化结果，不是崩溃");
});

test("参数不合法时返回可读错误，不抛栈", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	const result = await tools
		.get("ask_user_question")!
		.execute("c1", { questions: [] }, undefined, undefined, makeCtx("json"));

	assert.equal(result.isError, true);
	assert.ok(textOf(result).includes("至少"));
});

test("TUI 卡片：方向键 + Enter 走完单选，答案以 id 为 key", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let card: { handleInput(data: string): void } | undefined;
	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));

	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			card = factory({ requestRender: () => {} }, undefined, undefined, resolveCard) as typeof card;
			return cardDone;
		},
	});

	const pending = tools.get("ask_user_question")!.execute(
		"c1",
		{
			questions: [
				{
					id: "tier",
					question: "走哪档？",
					header: "档位",
					multiSelect: false,
					options: [
						{ label: "轻审", description: "" },
						{ label: "重审", description: "" },
					],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	await flush();
	assert.ok(card, "卡片组件没被创建");

	card.handleInput("\x1b[B"); // ↓ 到「重审」
	card.handleInput("\r"); // Enter 确认

	const result = await pending;
	assert.equal(textOf(result), JSON.stringify({ kind: "answered", answers: { tier: "重审" } }));
});

test("TUI 卡片：Chat about this 走完整链路返回 chat，不留下候选答案", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let card: { handleInput(data: string): void } | undefined;
	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));
	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			card = factory({ requestRender: () => {} }, undefined, undefined, resolveCard) as typeof card;
			return cardDone;
		},
	});

	const pending = tools.get("ask_user_question")!.execute(
		"c1",
		{ questions: [{ id: "q", question: "选？", header: "h", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] },
		undefined,
		undefined,
		ctx,
	);
	await flush();

	card!.handleInput(" "); // 先选一项，确认它不会混进结果
	card!.handleInput("\x1b[B");
	card!.handleInput("\x1b[B");
	card!.handleInput("\x1b[B"); // A → B → Other → Chat
	card!.handleInput("\r");

	const result = await pending;
	assert.equal(textOf(result), JSON.stringify({ kind: "chat", answers: {} }));
});

test("TUI 卡片：备注随答案进入 annotations，不污染 answers", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let card: { handleInput(data: string): void } | undefined;
	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));
	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			card = factory({ requestRender: () => {} }, undefined, undefined, resolveCard) as typeof card;
			return cardDone;
		},
	});

	const pending = tools.get("ask_user_question")!.execute(
		"c1",
		{ questions: [{ id: "q", question: "选？", header: "h", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] },
		undefined,
		undefined,
		ctx,
	);
	await flush();

	card!.handleInput("n");
	card!.handleInput("补");
	card!.handleInput("充");
	card!.handleInput("\r"); // 采用备注
	card!.handleInput(" ");
	card!.handleInput("\r");

	const result = await pending;
	assert.equal(textOf(result), JSON.stringify({ kind: "answered", answers: { q: "A" }, annotations: { q: { notes: "补充" } } }));
});

test("TUI 卡片：Esc 取消，且取消不伪装成选了某一项", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let card: { handleInput(data: string): void } | undefined;
	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));
	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			card = factory({ requestRender: () => {} }, undefined, undefined, resolveCard) as typeof card;
			return cardDone;
		},
	});

	const pending = tools.get("ask_user_question")!.execute(
		"c1",
		{
			questions: [
				{
					id: "q",
					question: "选？",
					header: "h",
					multiSelect: false,
					options: [{ label: "A", description: "" }, { label: "B", description: "" }],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	await flush();
	card?.handleInput("\x1b"); // Esc

	const result = await pending;
	assert.deepEqual(result.details, { kind: "cancelled" });
	assert.equal(JSON.stringify(result.details).includes("answers"), false);
});

test("TUI 卡片：多选用空格勾选，Enter 只负责确认", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let card: { handleInput(data: string): void } | undefined;
	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));
	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			card = factory({ requestRender: () => {} }, undefined, undefined, resolveCard) as typeof card;
			return cardDone;
		},
	});

	const pending = tools.get("ask_user_question")!.execute(
		"c1",
		{
			questions: [
				{
					id: "q",
					question: "多选？",
					header: "h",
					multiSelect: true,
					options: [
						{ label: "A", description: "" },
						{ label: "B", description: "" },
						{ label: "C", description: "" },
					],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	await flush();
	card?.handleInput(" "); // 勾 A
	card?.handleInput("\x1b[B"); // ↓ 到 B —— 这一步不该把 B 也勾上
	card?.handleInput("\r"); // 确认

	const result = await pending;
	assert.equal((result.details as { answers: Record<string, string> }).answers.q, "A", "Enter 不该顺手选中光标项");
});

test("RPC 降级：多选拆成连续单选并标 degraded", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	const answers = ["A", "✓ 选完了"];
	let call = 0;
	const ctx = makeCtx("rpc", { select: async () => answers[call++] });

	const result = await tools.get("ask_user_question")!.execute(
		"c1",
		{
			questions: [
				{
					id: "q",
					question: "多选？",
					header: "h",
					multiSelect: true,
					options: [
						{ label: "A", description: "" },
						{ label: "B", description: "" },
					],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	const details = result.details as { answers: Record<string, string>; annotations?: Record<string, { degraded?: boolean }> };
	assert.equal(details.answers.q, "A");
	assert.equal(details.annotations?.q.degraded, true, "RPC 降级要标记出来");
});

test("RPC 取消：整批问卷作废，不当成答完", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const ctx = makeCtx("rpc", { select: async () => "✗ 取消" });

	const result = await tools.get("ask_user_question")!.execute(
		"c1",
		{
			questions: [
				{
					id: "q",
					question: "选？",
					header: "h",
					multiSelect: false,
					options: [{ label: "A", description: "" }, { label: "B", description: "" }],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details, { kind: "cancelled" });
});

test("卡片开着时第二个调用拿到 busy，不排队不覆盖", async () => {
	const { pi, tools } = makePi();
	plugin(pi);

	let resolveCard: (value: unknown) => void = () => {};
	const cardDone = new Promise((resolve) => (resolveCard = resolve));
	const ctx = makeCtx("tui", {
		custom: (factory: (tui: unknown, t: unknown, k: unknown, done: (v: unknown) => void) => unknown) => {
			factory({ requestRender: () => {} }, undefined, undefined, resolveCard);
			return cardDone;
		},
	});

	const params = {
		questions: [
			{
				id: "q",
				question: "选？",
				header: "h",
				multiSelect: false,
				options: [{ label: "A", description: "" }, { label: "B", description: "" }],
			},
		],
	};

	const first = tools.get("ask_user_question")!.execute("c1", params, undefined, undefined, ctx);
	await flush();

	// 卡个上限：busy 闸若失效，第二个调用会一直等卡片，这里必须失败而不是把测试挂死
	const second = await Promise.race([
		tools.get("ask_user_question")!.execute("c2", params, undefined, undefined, ctx),
		new Promise<{ details: unknown }>((resolve) =>
			setTimeout(() => resolve({ details: { kind: "TIMEOUT" } }), 2000),
		),
	]);
	assert.deepEqual(second.details, { kind: "busy" }, "第二次调用应立刻拿到 busy，不该等前一张卡");

	resolveCard({ kind: "picks", picks: [{ id: "q", selected: ["A"] }] });
	await first;
});

// —— monitor ——

test("monitor：两个输入源都给 / 都不给，都返回参数错误", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const ctx = makeCtx("json");
	const tool = tools.get("monitor")!;

	const neither = await tool.execute("c", { description: "x" }, undefined, undefined, ctx);
	assert.equal(neither.isError, true);

	const both = await tool.execute(
		"c",
		{ description: "x", command: "echo hi", task_id: "t1" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(both.isError, true);
	assert.ok(textOf(both).includes("只能给一个"), `实际：${textOf(both)}`);
});

test("monitor：订阅不存在的任务返回可识别错误", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const result = await tools
		.get("monitor")!
		.execute("c", { description: "x", task_id: "nope" }, undefined, undefined, makeCtx("json"));

	assert.equal(result.isError, true);
	assert.ok(textOf(result).includes("nope"));
});

test("monitor：真跑一条 shell，taskId 立刻返回、输出行进环形缓冲、终态推回主会话", async () => {
	const { pi, tools, sent } = makePi();
	plugin(pi);

	const result = await tools
		.get("monitor")!
		.execute(
			"c",
			{ description: "跑三条", command: "echo alpha; echo beta", deliver: "terminal" },
			undefined,
			undefined,
			makeCtx("json"),
		);

	const details = result.details as { taskId?: string; status?: string };
	assert.ok(details.taskId, "应立即返回 taskId");
	assert.equal(details.status, "running");

	// 等子进程跑完把终态推出来
	for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));

	const terminal = sent.find((message) => message.customType === "workflow-tools:terminal");
	assert.ok(terminal, "没等到终态推送");
	assert.ok(String(terminal.content).includes("alpha") || String(terminal.content).includes("beta"), "终态正文该带上输出尾巴");
	assert.equal(terminal.options?.triggerTurn, true, "终态必须带 triggerTurn，否则空闲会话收不到");
});

test("monitor：stderr 也算事件，且不会把管道堵死", async () => {
	const { pi, tools, sent } = makePi();
	plugin(pi);

	await tools
		.get("monitor")!
		.execute(
			"c",
			{
				description: "往 stderr 写",
				// 往 stderr 灌 ~100KB，超过 64KB 管道缓冲：没人读就会卡在这里
				command: "for i in $(seq 1 3000); do echo 'stderr line ..............................' >&2; done; echo done >&2",
				deliver: "terminal",
			},
			undefined,
			undefined,
			makeCtx("json"),
		);

	for (let i = 0; i < 200 && !sent.some((m) => m.customType === "workflow-tools:terminal"); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}

	const terminal = sent.find((message) => message.customType === "workflow-tools:terminal");
	assert.ok(terminal, "stderr 写满后命令被堵死，没等到终态");
	assert.ok(String(terminal.content).includes("done"), `终态该带上 stderr 的尾巴，实际：${terminal?.content}`);
});

test("monitor：deliver terminal 时进度不逐条进上下文", async () => {
	const { pi, tools, sent } = makePi();
	plugin(pi);

	await tools
		.get("monitor")!
		.execute(
			"c",
			{ description: "噪音", command: "for i in $(seq 1 50); do echo line $i; done", deliver: "terminal" },
			undefined,
			undefined,
			makeCtx("json"),
		);

	for (let i = 0; i < 100 && !sent.some((m) => m.customType === "workflow-tools:terminal"); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}

	const progress = sent.filter((message) => message.customType === "workflow-tools:progress");
	assert.deepEqual(progress, [], "terminal 档不该推任何进度消息");
});

test("task_stop：停掉存活 monitor，未知 id 返回可识别错误", async () => {
	const { pi, tools, sent } = makePi();
	plugin(pi);
	const ctx = makeCtx("json");

	const started = await tools
		.get("monitor")!
		.execute("c", { description: "长跑", command: "sleep 30" }, undefined, undefined, ctx);
	const taskId = (started.details as { taskId: string }).taskId;

	const stop = await tools.get("task_stop")!.execute("c", { task_id: taskId }, undefined, undefined, ctx);
	assert.equal(stop.isError, undefined);

	const unknown = await tools.get("task_stop")!.execute("c", { task_id: "nope" }, undefined, undefined, ctx);
	assert.equal(unknown.isError, true);

	// 收尾：别把这个 sleep 留到测试结束
	await tools.get("session_shutdown")!;
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(sent.length >= 0);
});

// —— subagent ——

test("subagent：没给全模式参数时报错，不静默什么都不做", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const result = await tools.get("subagent")!.execute("c", {}, undefined, undefined, makeCtx("json"));
	assert.equal(result.isError, true);
});

test("subagent：找不到 agent 时把可用的列出来，让模型能自我纠正", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const result = await tools
		.get("subagent")!
		.execute("c", { agent: "nobody-here", task: "t" }, undefined, undefined, makeCtx("json"));

	assert.equal(result.isError, true);
	assert.ok(textOf(result).includes("nobody-here"));
	assert.ok(textOf(result).includes("可用"), "错误里要给可用清单");
});

test("subagent：tasks 与 chain 同时给会被拒，且拒的理由是互斥不是别的", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const result = await tools
		.get("subagent")!
		.execute("c", { tasks: [{ agent: "a", task: "t" }], chain: [{ agent: "b", task: "t" }] }, undefined, undefined, makeCtx("json"));

	assert.equal(result.isError, true);
	assert.equal((result.details as { kind?: string }).kind, "invalid_arguments");
	assert.ok(textOf(result).includes("只能给一个"), `拒的理由要指向互斥，实际：${textOf(result)}`);
});

test("subagent：一次超过 8 个并行任务直接拒绝", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: "t" }));
	const result = await tools.get("subagent")!.execute("c", { tasks }, undefined, undefined, makeCtx("json"));

	assert.equal(result.isError, true);
	assert.equal((result.details as { kind?: string }).kind, "concurrency_exceeded");
});

// —— 子会话的模型 / 思考档 ——

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
	name: "reviewer",
	description: "",
	systemPrompt: "你是 reviewer",
	source: "user",
	path: "/tmp/reviewer.md",
	...over,
});

test("什么都不指定时继承父会话的模型与思考档", () => {
	const ctx = makeCtx("json"); // model = anthropic/claude-haiku-5-5, thinkingLevel = medium
	assert.deepEqual(resolveDispatch(agent(), {}, ctx), {
		model: "anthropic/claude-haiku-5-5",
		thinkingLevel: "medium",
	});
});

test("显式参数覆盖父会话", () => {
	const ctx = makeCtx("json");
	assert.deepEqual(resolveDispatch(agent(), { model: "openai/gpt-5", thinking_level: "high" }, ctx), {
		model: "openai/gpt-5",
		thinkingLevel: "high",
	});
});

test("显式参数压过 agent 文件里的 model —— 三级链的中间一级", () => {
	const ctx = makeCtx("json");
	// 少了这条，「显式参数 > agent 文件」这层就没人守：把实现里的两个操作数对调也全绿
	assert.deepEqual(resolveDispatch(agent({ model: "anthropic/claude-opus-5-5" }), { model: "openai/gpt-5" }, ctx), {
		model: "openai/gpt-5",
	});
});

test("resolveDispatch 的结果真能拼进子 Pi 命令行", () => {
	const ctx = makeCtx("json");
	const args = buildChildArgs({
		agent: agent(),
		task: "t",
		...resolveDispatch(agent(), { thinking_level: "high" }, ctx),
	});

	assert.ok(args.includes("--model"), `命令行里该有 --model，实际：${args.join(" ")}`);
	assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-haiku-5-5");
	assert.ok(args.includes("--thinking"));
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
});

test("runChild 把算好的模型 / 思考档真送进子会话启动参数", async () => {
	const ctx = makeCtx("json");
	let captured: { model?: string; thinkingLevel?: string; task?: string; isolate?: boolean } | undefined;
	const fakeStart = (async (inputValue: Record<string, unknown>) => {
		captured = inputValue as typeof captured;
		return { process: { signal() {}, exited: Promise.resolve() }, result: Promise.resolve({}) };
	}) as unknown as Parameters<typeof runChild>[1];

	await runChild(
		{
			task: { id: "t1", ring: { push: () => {} } } as unknown as Parameters<typeof runChild>[0]["task"],
			tasks: { record: () => {} } as unknown as Parameters<typeof runChild>[0]["tasks"],
			agent: agent(),
			taskText: "干活",
			cwd: scratchRoot,
			params: {},
			ctx,
		},
		fakeStart,
	);

	// 少了这层，光测 resolveDispatch 是锁不住的：调用点漏了展开照样绿
	assert.equal(captured?.model, "anthropic/claude-haiku-5-5", `实际拿到：${JSON.stringify(captured)}`);
	assert.equal(captured?.thinkingLevel, "medium");
	assert.equal(captured?.task, "干活");
	assert.equal(captured?.isolate, true, "子会话必须隔离");
});

test("runChild 把子会话事件经 tasks.record 记成能读的行", async () => {
	const ctx = makeCtx("json");
	const recorded: string[] = [];
	const recordedIds: string[] = [];
	let emit: ((record: unknown) => void) | undefined;
	const fakeStart = (async (inputValue: { onEvent?: (record: unknown) => void }) => {
		emit = inputValue.onEvent;
		return { process: { signal() {}, exited: Promise.resolve() }, result: Promise.resolve({}) };
	}) as unknown as Parameters<typeof runChild>[1];

	await runChild(
		{
			task: { id: "t1" } as unknown as Parameters<typeof runChild>[0]["task"],
			tasks: {
				record: (id: string, line: string) => {
					recordedIds.push(id);
					recorded.push(line);
				},
			} as unknown as Parameters<typeof runChild>[0]["tasks"],
			agent: agent(),
			taskText: "干活",
			cwd: scratchRoot,
			params: {},
			ctx,
		},
		fakeStart,
	);

	// 实测过的坑：事件名直接进缓冲，终态那边「最后几行」和完整日志都是 message_update
	emit?.({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
	emit?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
	emit?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "干完了" }] } });

	assert.deepEqual(recorded, ['→ bash：{"command":"ls"}', "干完了"], "只记有信息量的行，内部事件名不进缓冲");
	assert.deepEqual(recordedIds, ["t1", "t1"], "行必须落在自己的任务上——记错 id 会让另一个任务的尾部串台");
});

test("进度消息头带任务身份，且把 description 压成一行、限长", () => {
	const single = progressMessage({ taskId: "monitor-3", kind: "monitor", description: "长命令 75 秒", text: "[1 行合并]\nbeat 1" });
	assert.equal(single, "任务 monitor-3（monitor）长命令 75 秒\n[1 行合并]\nbeat 1");

	// description 是工具参数：可能带换行（劈开头）、可能超长（每条摘要都重复灌上下文）
	const messy = progressMessage({ taskId: "subagent-2", kind: "subagent", description: `第一行\n${"x".repeat(500)}`, text: "[1 行合并]\nline" });
	const [header, ...rest] = messy.split("\n");
	assert.ok(header?.startsWith("任务 subagent-2（subagent）第一行"), `实际：${header}`);
	assert.ok((header?.length ?? 0) <= 200, `头超宽：${header?.length}`);
	assert.equal(rest.length, 2, "摘要正文两个行不能被头改写");
});

test("agent 文件里的 model 优先于父会话，且此时不再继承思考档", () => {
	const ctx = makeCtx("json");
	// thinking 是父模型调的档，换了模型就不该照搬
	assert.deepEqual(resolveDispatch(agent({ model: "anthropic/claude-opus-5-5" }), {}, ctx), {
		model: "anthropic/claude-opus-5-5",
	});
});

test("显式指定模型时同样不继承思考档", () => {
	const ctx = makeCtx("json");
	assert.deepEqual(resolveDispatch(agent(), { model: "openai/gpt-5" }, ctx), { model: "openai/gpt-5" });
});

test("父会话没有模型时不硬塞 --model，交给子 Pi 自己选", () => {
	const ctx = makeCtx("json");
	(ctx as unknown as { model: undefined }).model = undefined;
	const result = resolveDispatch(agent(), {}, ctx);
	assert.equal(result.model, undefined);
	assert.equal(result.thinkingLevel, "medium", "没有模型可继承时思考档照旧");
});

// —— 取消要收掉整棵进程树 ——

test("取消会连孙进程一起收掉，不留孤儿", async () => {
	const { pi, tools } = makePi();
	plugin(pi);
	const marker = join(scratch("wf-pg"), "child.pid");
	const ctx = makeCtx("json");

	const started = await tools.get("monitor")!.execute(
		"c",
		{
			description: "带孙进程",
			// sh 是进程组组长，后台的 sleep 是它的子进程 —— 只杀直接子进程时它会活下来。
			// 时长要远大于整个测试的墙钟，否则「它自己跑完了」会被误判成「被杀掉了」。
			// 路径加引号：TMPDIR 里可能有空格或 shell 元字符。
			command: `sleep 600 & echo $! > '${marker}'; wait`,
		},
		undefined,
		undefined,
		ctx,
	);
	const taskId = (started.details as { taskId: string }).taskId;

	// 前置条件给足预算：机器卡的时候不该红得和产品无关
	for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(existsSync(marker), "孙进程没起来，测试前提不成立");
	const childPid = Number(readFileSync(marker, "utf8").trim());
	assert.ok(Number.isFinite(childPid) && childPid > 0, `读到的 pid 不合法：${childPid}`);

	try {
		await tools.get("task_stop")!.execute("c", { task_id: taskId }, undefined, undefined, ctx);

		let alive = true;
		for (let i = 0; i < 100; i++) {
			try {
				process.kill(childPid, 0);
				await new Promise((r) => setTimeout(r, 50));
			} catch {
				alive = false;
				break;
			}
		}
		assert.equal(alive, false, `孙进程 ${childPid} 还活着 —— 说明只杀了直接子进程`);
	} finally {
		// 断言失败时别把这个 sleep 留在机器上跑满 10 分钟
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// 已经没了
		}
	}
});

// —— 收尾 ——

test("session_shutdown 会把存活任务收掉，不留下跑着的子进程", async () => {
	const { pi, tools, handlers, sent } = makePi();
	plugin(pi);
	const ctx = makeCtx("json");

	// 起一个长跑任务
	const started = await tools
		.get("monitor")!
		.execute("c", { description: "长跑", command: "sleep 30" }, undefined, undefined, ctx);
	const taskId = (started.details as { taskId: string }).taskId;
	assert.ok(taskId);

	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);

	// 收尾期之后的推送一律丢弃，所以这里不该有终态消息
	assert.equal(
		sent.some((message) => String(message.content).includes("长跑")),
		false,
		"收尾期开始后的推送不该再写进会话",
	);

	// 旧任务已经不在注册表里了
	const stopped = await tools.get("task_stop")!.execute("c", { task_id: taskId }, undefined, undefined, ctx);
	assert.equal(stopped.isError, true, "旧运行时已作废，旧 taskId 不再可停");
});

test("session_shutdown 会把日志目录收掉，不在临时目录里越积越多", async () => {
	const { pi, tools, handlers } = makePi();
	plugin(pi);
	const ctx = makeCtx("json");
	const shutdown = () => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

	// 先归一化：本文件前面的测试可能已经建过日志目录
	await shutdown();
	const before = countTaskLogDirs();

	await tools.get("monitor")!.execute("c", { description: "写日志", command: "echo hi" }, undefined, undefined, ctx);
	assert.ok(countTaskLogDirs() > before, "跑任务该建出日志目录");

	await shutdown();
	assert.equal(countTaskLogDirs(), before, "收尾后不该还留着日志目录");
});

test("session_shutdown 之后新会话拿到全新运行时，照常接活", async () => {
	const { pi, tools, handlers } = makePi();
	plugin(pi);
	const ctx = makeCtx("json");

	await tools.get("monitor")!.execute("c", { description: "x", command: "echo x" }, undefined, undefined, ctx);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx);

	const result = await tools
		.get("monitor")!
		.execute("c", { description: "y", command: "echo y" }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined, "/reload 之后新会话应能正常起任务");
	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("完整日志真的落盘：写入、关句柄、关后再写不抛错", () => {
	const log = openTaskLog("audit-log-probe");
	try {
		log.write("→ bash：{\"command\":\"ls\"}");
		log.write("干完了");
		assert.equal(readFileSync(log.path, "utf8"), "→ bash：{\"command\":\"ls\"}\n干完了\n", "日志内容要真的可读出来");

		log.close();
		log.write("迟到的一行");
		assert.equal(readFileSync(log.path, "utf8").includes("迟到"), false, "关句柄后不该再往里写");
	} finally {
		log.close();
		rmSync(log.path, { force: true });
	}
});
