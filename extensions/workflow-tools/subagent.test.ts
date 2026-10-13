import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createIsolatedWorktree,
	releaseWorktree,
	applyChainStep,
	buildChildArgs,
	describeChildEvent,
	flushChildTail,
	isFailedChild,
	oneLine,
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

// —— worktree 隔离：改动留在里面，有未提交就不删 ——

// 隔离全局 git 配置：这台机器没开 gpgsign 不代表别的机器没有，
// 不然这三条测试会在别人机器上红，报的错还和产品无关。
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: GIT_ENV });

const scratchDirs: string[] = [];

after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wf-repo-"));
	scratchDirs.push(dir);
	git(dir, ["init", "-q"]);
	git(dir, [
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	]);
	return dir;
}

/** 取真实路径：macOS 上 /tmp 是 /private/tmp 的软链，git 报的是展开后的。 */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** 主仓里登记的 worktree 列表（用来验「不只是删目录，登记也注销了」）。 */
function registeredWorktrees(repo: string): string[] {
	return git(repo, ["worktree", "list", "--porcelain"])
		.toString()
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => canonical(line.slice("worktree ".length).trim()));
}

test("建出来的 worktree 能用，且不在原仓库目录里", async () => {
	const repo = makeTempRepo();
	const created = await createIsolatedWorktree(repo);
	assert.ok(created.ok, `建 worktree 失败：${created.ok ? "" : created.error}`);
	if (!created.ok) return;

	assert.ok(existsSync(created.handle.path), "worktree 目录没建出来");
	assert.ok(!created.handle.path.startsWith(repo + "/"), "worktree 不该落在原仓库里面");
	assert.equal(git(created.handle.path, ["rev-parse", "--is-inside-work-tree"]).toString().trim(), "true");
	assert.ok(registeredWorktrees(repo).includes(canonical(created.handle.path)), "主仓里该有它的登记");

	await releaseWorktree(created.handle);
});

test("干净的 worktree 会被收掉，登记也一并注销", async () => {
	const repo = makeTempRepo();
	const created = await createIsolatedWorktree(repo);
	if (!created.ok) return assert.fail(created.error);
	const { path } = created.handle;
	// 趁目录还在先取真实路径——删掉之后 realpath 就取不到了
	const worktreePath = canonical(path);

	const released = await releaseWorktree(created.handle);
	assert.equal(released.removed, true, `应当移除，理由：${released.reason}`);
	assert.equal(existsSync(path), false, "目录该没了");
	// 只 rm -rf 目录不注销登记的话，主仓 .git/worktrees 里会留下永久残留
	assert.equal(registeredWorktrees(repo).includes(worktreePath), false, "主仓里不该还留着它的登记");
});

test("有未提交改动的 worktree 不删，把路径留下来", async () => {
	const repo = makeTempRepo();
	const created = await createIsolatedWorktree(repo);
	if (!created.ok) return assert.fail(created.error);
	const { path } = created.handle;

	// 模拟子会话在里面改了东西没提交（未跟踪文件走的是同一个 status 分支）
	writeFileSync(join(path, "half-done.txt"), "还没提交的成果\n");

	const released = await releaseWorktree(created.handle);
	assert.equal(released.removed, false, "有未提交改动时不该删");
	assert.ok(released.reason?.includes("未提交"), `理由该点明原因，实际：${released.reason}`);
	assert.ok(existsSync(join(path, "half-done.txt")), "成果必须还在");
	assert.ok(registeredWorktrees(repo).includes(canonical(path)), "登记也该还在，人还得能找回来");

	// 收尾：手动清掉，别把工作区、登记和它的临时父目录留在机器上
	git(repo, ["worktree", "remove", "--force", path]);
	rmSync(dirname(path), { recursive: true, force: true });
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

// —— 事件翻译：终态尾部和完整日志里只该出现人能读的行 ——

test("工具调用翻译成一行，带工具名和参数预览", () => {
	assert.equal(
		describeChildEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } }),
		'→ bash：{"command":"ls -la"}',
	);
});

test("参数超长时截断，没给参数时只留工具名", () => {
	const long = describeChildEvent({ type: "tool_execution_start", toolName: "write", args: { content: "x".repeat(1000) } });
	assert.ok(long?.startsWith("→ write："));
	assert.ok((long?.length ?? 0) <= 200, `行太长：${long?.length}`);
	assert.ok(long?.endsWith("…"));
	assert.equal(describeChildEvent({ type: "tool_execution_start", toolName: "read" }), "→ read");
});

test("序列化不了的参数不把事件处理搞挂", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.equal(describeChildEvent({ type: "tool_execution_start", toolName: "bash", args: cyclic }), "→ bash");
});

test("助手回复翻译成单行，换行压成空格", () => {
	assert.equal(
		describeChildEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "第一行\n  第二行" }] },
		}),
		"第一行 第二行",
	);
});

test("工具失败与模型报错都记成 × 行", () => {
	assert.equal(describeChildEvent({ type: "tool_execution_end", toolName: "bash", isError: true }), "× bash 执行失败");
	assert.equal(describeChildEvent({ type: "message_end", message: { role: "assistant", errorMessage: "429 限流" } }), "× 429 限流");
});

test("内部事件名不进缓冲：这些事件一律不翻译", () => {
	for (const type of ["message_update", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end"]) {
		assert.equal(describeChildEvent({ type }), undefined, `${type} 不该产出日志行`);
	}
	assert.equal(describeChildEvent(null), undefined, "非对象记录要容忍");
	assert.equal(describeChildEvent("message_update"), undefined, "字符串记录要容忍");
	assert.equal(describeChildEvent({ type: "message_end", message: { role: "user", content: "提示词" } }), undefined, "用户消息不算子会话产出");
});

// —— 对抗式审核逮到的边界：截断、工具名、末尾残行 ——

/** 孤立代理 = 一个 emoji 被切成半个；写进日志就是 U+FFFD 乱码。 */
function hasLoneSurrogate(text: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test("上限截断不切歪代理对：第 199 个 code unit 正好落在 emoji 中间", () => {
	const line = oneLine("🙂".repeat(150));
	assert.ok(line.length <= 200, `行超宽：${line.length}`);
	assert.ok(!hasLoneSurrogate(line), "切出了孤立代理");
	assert.equal(line.indexOf("\uFFFD"), -1, "UTF-8 里会出现替换符");
});

test("预切那一刀也不切歪代理对（1600 code unit 处正好是 emoji 前半）", () => {
	const line = oneLine(`${"a".repeat(1599)}🙂${"b".repeat(50)}`);
	assert.ok(line.length <= 200, `行超宽：${line.length}`);
	assert.ok(!hasLoneSurrogate(line), "预切切出了孤立代理");
});

test("emoji 参数走完整链路也不变乱码，且行宽守住", () => {
	const line = describeChildEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "🙂".repeat(400) }] },
	});
	assert.ok(line);
	assert.ok(line.length <= 200, `行超宽：${line.length}`);
	assert.ok(!hasLoneSurrogate(line));
	assert.equal(line.indexOf("\uFFFD"), -1);
});

test("工具名同样过 oneLine：换行不劈行、超长不撑破", () => {
	const line = describeChildEvent({ type: "tool_execution_end", toolName: "bad\nname".repeat(80), isError: true });
	assert.ok(line);
	assert.ok(!line.includes("\n"), "日志行必须是一行");
	assert.ok(line.length <= 200, `行超宽：${line.length}`);
	assert.ok(line.startsWith("× "));
});

test("无参数的启动行也不放过工具名", () => {
	const line = describeChildEvent({ type: "tool_execution_start", toolName: `x\n${"y".repeat(500)}` });
	assert.ok(line);
	assert.ok(!line.includes("\n"));
	assert.ok(line.length <= 200, `行超宽：${line.length}`);
});

test("进程末尾不带换行的残行也会回调 onEvent —— 否则日志静默缺掉最终答复", () => {
	const seen: unknown[] = [];
	const records = flushChildTail('{"type":"message_end","message":{"role":"assistant"}}', (record) => void seen.push(record));
	assert.equal(records.length, 1, "残行要进 summary");
	assert.equal(seen.length, 1, "残行也必须回调 onEvent");
	assert.deepEqual(seen[0], records[0]);

	const empty: unknown[] = [];
	assert.deepEqual(flushChildTail("", (record) => void empty.push(record)), []);
	assert.deepEqual(empty, [], "空缓冲不该凭空造事件");
});
