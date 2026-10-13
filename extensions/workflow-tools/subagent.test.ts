import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyChainStep,
	buildChildArgs,
	isFailedChild,
	needsProjectTrust,
	parseAgentFile,
	parseJsonLines,
	safeFileName,
	selectAgents,
	summarizeChildOutput,
} from "./subagent.ts";

const USER = "user" as const;
const PROJECT = "project" as const;

// —— agent 文件解析：Pi 的 agent 格式只有四字段 + 正文 ——

test("解析 frontmatter 的四个字段，正文作为系统提示", () => {
	const parsed = parseAgentFile(
		["---", "name: reviewer", "description: 挑刺用", "tools: read, grep", "model: claude-opus-5-5", "---", "你是 reviewer。", "只挑刺，不改文件。"].join("\n"),
		"/tmp/reviewer.md",
		USER,
	);
	assert.ok("name" in parsed, `应解析成功，实际：${JSON.stringify(parsed)}`);
	if (!("name" in parsed)) return;
	assert.equal(parsed.name, "reviewer");
	assert.equal(parsed.description, "挑刺用");
	assert.deepEqual(parsed.tools, ["read", "grep"]);
	assert.equal(parsed.model, "claude-opus-5-5");
	assert.equal(parsed.systemPrompt, "你是 reviewer。\n只挑刺，不改文件。");
	assert.equal(parsed.source, "user");
});

test("agent 格式没有 thinking 字段 —— 出现该键也只是普通文本，不进结构化字段", () => {
	const parsed = parseAgentFile(["---", "name: r", "description: d", "thinking: high", "---", "body"].join("\n"), "/tmp/r.md", USER);
	assert.ok("name" in parsed);
	if (!("name" in parsed)) return;
	assert.equal(Object.hasOwn(parsed, "thinking"), false, "thinking 不该成为结构化字段");
});

test("没有 frontmatter 时整份文件当系统提示，名字退回文件名", () => {
	const parsed = parseAgentFile("你是 scout。", "/tmp/agents/scout.md", USER);
	assert.ok("name" in parsed);
	if (!("name" in parsed)) return;
	assert.equal(parsed.name, "scout");
	assert.equal(parsed.systemPrompt, "你是 scout。");
});

test("frontmatter 里缺 name 也退回文件名", () => {
	const parsed = parseAgentFile(["---", "description: d", "---", "body"].join("\n"), "/tmp/agents/worker.md", USER);
	assert.ok("name" in parsed);
	if (!("name" in parsed)) return;
	assert.equal(parsed.name, "worker");
});

test("缺 description 不致命，退回用名字", () => {
	const parsed = parseAgentFile(["---", "name: r", "---", "body"].join("\n"), "/tmp/r.md", USER);
	assert.ok("name" in parsed);
	if (!("name" in parsed)) return;
	assert.equal(parsed.description, "r");
});

test("空文件报错而不是产出一个没提示词的 agent", () => {
	const parsed = parseAgentFile("   \n\n", "/tmp/empty.md", USER);
	assert.ok("error" in parsed, "空 agent 文件应被拒");
});

test("source 跟着传入的作用域走", () => {
	const parsed = parseAgentFile(["---", "name: p", "---", "body"].join("\n"), "/repo/.pi/agents/p.md", PROJECT);
	assert.ok("name" in parsed);
	if (!("name" in parsed)) return;
	assert.equal(parsed.source, "project");
});

// —— 作用域：项目级默认不参与 ——

const userAgent = { name: "reviewer", description: "", systemPrompt: "", source: USER, path: "/u/reviewer.md" };
const projectAgent = { name: "scout", description: "", systemPrompt: "", source: PROJECT, path: "/p/scout.md" };
const both = [userAgent, projectAgent];

test("缺省 agentScope 按 user 算 —— 项目级 agent 不参与", () => {
	assert.deepEqual(selectAgents(both, undefined).map((a) => a.name), ["reviewer"]);
});

test("agentScope: project 只给项目级", () => {
	assert.deepEqual(selectAgents(both, "project").map((a) => a.name), ["scout"]);
});

test("agentScope: user 只给用户级", () => {
	assert.deepEqual(selectAgents(both, "user").map((a) => a.name), ["reviewer"]);
});

test("agentScope: both 两边都给", () => {
	assert.deepEqual(selectAgents(both, "both").map((a) => a.name), ["reviewer", "scout"]);
});

// —— 信任门 ——

test("选中里有项目级 agent 且没显式承担 → 需要确认", () => {
	assert.equal(needsProjectTrust([userAgent, projectAgent], undefined), true);
	assert.equal(needsProjectTrust([userAgent, projectAgent], true), true);
});

test("confirmProjectAgents 传 false 表示调用方已承担该决定 → 不再确认", () => {
	assert.equal(needsProjectTrust([userAgent, projectAgent], false), false);
});

test("没选中任何项目级 agent 就不需要确认", () => {
	assert.equal(needsProjectTrust([userAgent], undefined), false);
	assert.equal(needsProjectTrust([], undefined), false);
});

// —— 链式：{previous} 注入前一步结果 ——

test("{previous} 被替换成前一步的最终文本", () => {
	const out = applyChainStep("上一步说：{previous}", "第一步的结论");
	assert.equal(out, "上一步说：第一步的结论");
});

test("同一处出现多次全部替换", () => {
	const out = applyChainStep("{previous} 和 {previous}", "X");
	assert.equal(out, "X 和 X");
});

test("没有占位符时原样返回，不偷偷拼接", () => {
	assert.equal(applyChainStep("独立任务", "无关结果"), "独立任务");
});

test("第一步没有前序结果，占位符原样留着（不替换成 undefined）", () => {
	assert.equal(applyChainStep("看 {previous}", undefined), "看 {previous}");
});

// —— 子 Pi 命令行 ——

const agent = { name: "reviewer", description: "", systemPrompt: "你是 reviewer", source: USER, path: "/u/r.md" };

test("基础命令行用 json 模式、跑完即弃，任务文本放最后", () => {
	const args = buildChildArgs({ agent, task: "审一遍" });
	assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
	assert.equal(args.at(-1), "Task: 审一遍");
});

test("model / thinking / tools / 系统提示都按需追加", () => {
	const args = buildChildArgs({
		agent: { ...agent, tools: ["read", "grep"] },
		task: "t",
		model: "claude-opus-5-5",
		thinkingLevel: "high",
		promptPath: "/tmp/p.md",
	});
	assert.deepEqual(args.slice(4, 6), ["--model", "claude-opus-5-5"]);
	assert.deepEqual(args.slice(6, 8), ["--thinking", "high"]);
	assert.deepEqual(args.slice(8, 10), ["--tools", "read,grep"]);
	assert.deepEqual(args.slice(10, 12), ["--append-system-prompt", "/tmp/p.md"]);
});

test("不给 tools 就不传 --tools，免得把子会话的工具清空", () => {
	assert.equal(buildChildArgs({ agent, task: "t" }).includes("--tools"), false);
});

test("isolate 打开时禁掉用户级扩展、命令、skills 和 MCP —— 否则分会话不独立", () => {
	const args = buildChildArgs({ agent, task: "t", isolate: true });
	for (const flag of ["-ne", "-nc", "-ns", "--no-mcp"]) {
		assert.ok(args.includes(flag), `隔离模式应带上 ${flag}`);
	}
});

test("默认不开隔离，保持和仓库现状一致", () => {
	const args = buildChildArgs({ agent, task: "t" });
	assert.equal(args.includes("-ne"), false);
});

// —— JSONL 解析 ——

test("按 LF 切，残行扣住等下一块", () => {
	const first = parseJsonLines('{"a":1}\n{"b":');
	assert.equal(first.records.length, 1);
	assert.equal(first.rest, '{"b":');
});

test("认不出来的行直接忽略（会话头、警告、半截输出）", () => {
	const parsed = parseJsonLines('不是 JSON\n{"ok":true}\n\n');
	assert.deepEqual(parsed.records, [{ ok: true }]);
});

test("空缓冲不产出记录", () => {
	assert.deepEqual(parseJsonLines("").records, []);
});

// —— 结果提炼 ——

const assistant = (over: Record<string, unknown> = {}) => ({
	type: "message_end",
	message: {
		role: "assistant",
		model: "claude-opus-5-5",
		stopReason: "endTurn",
		content: [{ type: "text", text: "结论正文" }],
		// 真实形状：成本在 cost.total 下，不是一个叫 costTotal 的平铺字段
		usage: {
			input: 10,
			output: 20,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 33,
			cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		},
		...over,
	},
});

test("取到最后一条 assistant 的文本", () => {
	const summary = summarizeChildOutput([
		assistant({ content: [{ type: "text", text: "第一版" }] }),
		assistant({ content: [{ type: "text", text: "最终版" }] }),
	]);
	assert.equal(summary.text, "最终版");
	assert.equal(summary.model, "claude-opus-5-5");
});

test("usage 跨消息累加", () => {
	const summary = summarizeChildOutput([assistant(), assistant()]);
	assert.equal(summary.usage.input, 20);
	assert.equal(summary.usage.totalTokens, 66);
	assert.ok(Math.abs(summary.usage.cost.total - 0.5) < 1e-9, `成本应从 cost.total 累加，实际 ${summary.usage.cost.total}`);
});

test("一次工具调用只数一次 —— start 与 end 是同一件事的两条事件", () => {
	const summary = summarizeChildOutput([
		{ type: "tool_execution_start" },
		{ type: "tool_execution_end" },
		assistant(),
	]);
	assert.equal(summary.toolCalls, 1, "start/end 各数一次会把调用数翻倍");
});

test("多次调用按 start 计数", () => {
	const summary = summarizeChildOutput([
		{ type: "tool_execution_start" },
		{ type: "tool_execution_end" },
		{ type: "tool_execution_start" },
		{ type: "tool_execution_end" },
		{ type: "tool_execution_end" },
	]);
	assert.equal(summary.toolCalls, 2);
});

test("成本从 usage.cost.total 累加，而不是一个不存在的平铺字段", () => {
	const summary = summarizeChildOutput([assistant()]);
	assert.ok(Math.abs(summary.usage.cost.total - 0.25) < 1e-9, `实际 ${summary.usage.cost.total}`);
	assert.equal(Object.hasOwn(summary.usage, "costTotal"), false, "不该凭空造 costTotal 字段");
});

// —— agent 名字是不可信输入 ——

test("safeFileName 挡住路径穿越", () => {
	assert.equal(safeFileName("../../../../tmp/x").includes(".."), false);
	assert.equal(safeFileName("../../../../tmp/x").includes("/"), false);
	assert.equal(safeFileName("a/b").includes("/"), false);
});

test("safeFileName 保留正常名字，空名字有兜底", () => {
	assert.equal(safeFileName("reviewer"), "reviewer");
	assert.equal(safeFileName("code-reviewer.v2"), "code-reviewer.v2");
	assert.equal(safeFileName("..."), "agent");
	assert.equal(safeFileName(""), "agent");
});

test("非 assistant 的消息不污染结果", () => {
	const summary = summarizeChildOutput([
		{ type: "message_end", message: { role: "user", content: "提示词" } },
		assistant(),
	]);
	assert.equal(summary.text, "结论正文");
});

test("认不出的记录一律跳过，不抛错", () => {
	assert.deepEqual(summarizeChildOutput([null, 42, "x", {}]).text, "");
});

test("失败判定：非零退出、error、aborted 都算失败", () => {
	assert.equal(isFailedChild({ text: "", toolCalls: 0, usage: {} as never }, 1), true);
	assert.equal(isFailedChild({ text: "", stopReason: "error", toolCalls: 0, usage: {} as never }, 0), true);
	assert.equal(isFailedChild({ text: "", stopReason: "aborted", toolCalls: 0, usage: {} as never }, 0), true);
	assert.equal(isFailedChild({ text: "", stopReason: "endTurn", toolCalls: 0, usage: {} as never }, 0), false);
});
