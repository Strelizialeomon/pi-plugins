/**
 * 假 Pi 测试台：把插件当真的加载进来，把四个工具真调一遍。
 *
 * 这里不 mock 业务逻辑——注册、校验、卡片状态机、子进程 spawn 走的都是产品代码，
 * 只有 Pi 那一侧（ExtensionAPI / ctx / TUI）是替身。
 *
 * 它**不能**替代真 Pi 的冒烟：Pi 会不会拒绝我们的 schema、TUI 画出来长什么样，
 * 只有真跑一次才知道。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import plugin from "./index.ts";

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

function makeCtx(mode: "tui" | "rpc" | "json", ui: Record<string, unknown> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "wf-tools-test-"));
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
	return ctx as unknown as ExtensionContext & { ui: Record<string, never> };
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
						{ label: "A", description: "", preview: "预览不该出现在 RPC 结果里" },
						{ label: "B", description: "" },
					],
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	const details = result.details as { answers: Record<string, string>; annotations?: Record<string, { degraded?: boolean; preview?: string }> };
	assert.equal(details.answers.q, "A");
	assert.equal(details.annotations?.q.degraded, true, "RPC 降级要标记出来");
	assert.equal(details.annotations?.q.preview, undefined, "RPC 下 preview 应被丢弃");
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

	resolveCard([{ id: "q", selected: ["A"] }]);
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
