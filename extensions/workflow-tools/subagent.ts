/**
 * `subagent`：在独立 Pi 子会话里跑一个或多个专用 agent。
 *
 * 本文件分两层：
 * - 纯逻辑层（下）：agent 文件解析、作用域选择、链式占位符替换。单测直接跑。
 * - 接线层（上）：子进程 spawn、进程组取消、结果汇总，由 `index.ts` 接进 ExtensionAPI。
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskProcess } from "./task-runtime.ts";

export type AgentSource = "user" | "project";
export type AgentScope = "user" | "project" | "both";

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	path: string;
}

export interface AgentParseError {
	error: string;
}

const FRONTMATTER_FENCE = "---";

function baseName(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.md$/i, "");
}

/**
 * 解析一个 agent 定义文件。Pi 的 agent 格式只认四个字段
 * （name / description / tools / model），正文就是系统提示——没有 thinking 字段。
 */
export function parseAgentFile(raw: string, path: string, source: AgentSource): AgentDefinition | AgentParseError {
	const lines = raw.split("\n");
	let fields: Record<string, string> = {};
	let bodyStart = 0;

	if (lines[0]?.trim() === FRONTMATTER_FENCE) {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
		if (end > 0) {
			fields = parseFrontmatter(lines.slice(1, end));
			bodyStart = end + 1;
		}
	}

	const systemPrompt = lines.slice(bodyStart).join("\n").trim();
	if (!systemPrompt) return { error: `${path} 没有系统提示正文，拒绝加载一个空 agent。` };

	const name = fields.name?.trim() || baseName(path);
	const tools = fields.tools
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	return {
		name,
		description: fields.description?.trim() || name,
		...(tools && tools.length > 0 ? { tools } : {}),
		...(fields.model?.trim() ? { model: fields.model.trim() } : {}),
		systemPrompt,
		source,
		path,
	};
}

function parseFrontmatter(lines: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (key) fields[key] = value;
	}
	return fields;
}

/** 按 `agentScope` 过滤可用 agent。缺省按 `user` 算——项目级 agent 不参与。 */
export function selectAgents(agents: AgentDefinition[], scope: AgentScope | undefined): AgentDefinition[] {
	const effective = scope ?? "user";
	if (effective === "both") return [...agents];
	return agents.filter((agent) => agent.source === effective);
}

/**
 * 选中集合里有项目级 agent、且调用方没有显式承担这个信任决定时，
 * 必须先过 Pi 的项目可信判断。
 */
export function needsProjectTrust(agents: AgentDefinition[], confirmProjectAgents: boolean | undefined): boolean {
	if (confirmProjectAgents === false) return false;
	return agents.some((agent) => agent.source === "project");
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** 从 cwd 往上找最近的项目级 agents 目录。 */
export function findProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}

	const agents: AgentDefinition[] = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const path = join(dir, file);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const parsed = parseAgentFile(raw, path, source);
		// 解析不了的单个文件不该拖垮整轮发现
		if (!("error" in parsed)) agents.push(parsed);
	}
	return agents;
}

/** 按作用域发现可用 agent。项目级只在 scope 允许时才读。 */
export async function discoverAgents(cwd: string, scope: AgentScope | undefined): Promise<AgentDefinition[]> {
	const effective = scope ?? "user";
	const userAgents = effective === "project" ? [] : await loadAgentsFromDir(join(getAgentDir(), "agents"), "user");

	let projectAgents: AgentDefinition[] = [];
	if (effective !== "user") {
		const projectDir = findProjectAgentsDir(cwd);
		if (projectDir) projectAgents = await loadAgentsFromDir(projectDir, "project");
	}

	return [...userAgents, ...projectAgents];
}

/**
 * agent 名字来自磁盘上的 frontmatter，是不能信的内容：它会被拼进临时文件路径。
 * `name: ../../x` 这种能写到临时目录之外，所以这里只放行安全字符。
 */
export function safeFileName(name: string): string {
	const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
	const trimmed = cleaned.replace(/^[._-]+/, "");
	return trimmed || "agent";
}

/** 链式执行：把上一步的最终文本注入 `{previous}`。没有前序结果时原样留着。 */
export function applyChainStep(task: string, previous: string | undefined): string {
	if (previous === undefined) return task;
	return task.replaceAll("{previous}", previous);
}

// —— 接线层：拼子 Pi 命令行、跑子进程、读回结果 ——

/**
 * 子 Pi 的完整命令行。任务文本永远放最后一位，前面的都是开关。
 * 注意 `--no-session`：子会话不写会话文件，跑完即弃。
 */
export function buildChildArgs(input: {
	agent: AgentDefinition;
	task: string;
	model?: string;
	thinkingLevel?: string;
	promptPath?: string;
	/** 分身子会话要禁掉的资源，见 §3.1「子 Pi 的独立上下文」。 */
	isolate?: boolean;
}): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];

	if (input.isolate) {
		// 不加载用户级扩展 / 命令 / skills / MCP：否则 reviewer 会连上 MCP、
		// 会被全局 AGENTS.md 影响，还可能递归派发 subagent。
		args.push("-ne", "-nc", "-ns", "--no-mcp");
	}
	if (input.model) args.push("--model", input.model);
	if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
	if (input.agent.tools && input.agent.tools.length > 0) args.push("--tools", input.agent.tools.join(","));
	if (input.promptPath) args.push("--append-system-prompt", input.promptPath);

	args.push(`Task: ${input.task}`);
	return args;
}

/** 对齐 Pi 的真实 `Usage`：成本在 `cost.total`，不是一个叫 `costTotal` 的平铺字段。 */
export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ChildSummary {
	text: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	toolCalls: number;
	usage: ChildUsage;
}

/**
 * 从 `--mode json` 的 JSONL 记录里提炼结果。
 * 认不出来的记录一律忽略——首条可能是会话头，也可能没有。
 */
export function summarizeChildOutput(records: unknown[]): ChildSummary {
	const usage: ChildUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let text = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let toolCalls = 0;

	for (const record of records) {
		if (typeof record !== "object" || record === null) continue;
		const event = record as { type?: unknown; message?: unknown };

		// 每次工具调用 Pi 会先后发 start 与 end 两条，只能数其中一条，否则翻倍
		if (event.type === "tool_execution_start") {
			toolCalls += 1;
			continue;
		}
		if (event.type === "tool_execution_end") continue;
		if (event.type !== "message_end") continue;

		const message = event.message as
			| { role?: string; model?: string; stopReason?: string; errorMessage?: string; content?: unknown; usage?: unknown }
			| undefined;
		if (!message || message.role !== "assistant") continue;

		if (typeof message.model === "string") model = message.model;
		if (typeof message.stopReason === "string") stopReason = message.stopReason;
		if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;

		const textPart = firstTextPart(message.content);
		if (textPart !== undefined) text = textPart;

		const reported = message.usage as Partial<ChildUsage> | undefined;
		if (reported) {
			usage.input += reported.input ?? 0;
			usage.output += reported.output ?? 0;
			usage.cacheRead += reported.cacheRead ?? 0;
			usage.cacheWrite += reported.cacheWrite ?? 0;
			usage.totalTokens += reported.totalTokens ?? 0;
			const cost = reported.cost;
			if (cost) {
				usage.cost.input += cost.input ?? 0;
				usage.cost.output += cost.output ?? 0;
				usage.cost.cacheRead += cost.cacheRead ?? 0;
				usage.cost.cacheWrite += cost.cacheWrite ?? 0;
				usage.cost.total += cost.total ?? 0;
			}
		}
	}

	return {
		text,
		...(model ? { model } : {}),
		...(stopReason ? { stopReason } : {}),
		...(errorMessage ? { errorMessage } : {}),
		toolCalls,
		usage,
	};
}

function firstTextPart(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
	}
	return undefined;
}

/** 一行摘要的宽度上限：终态消息只展示最后几行，一行几十字就够。 */
const CHILD_LINE_MAX = 200;
/** 折叠空白前先粗切一刀，把正则的工作量封在这里头。 */
const CHILD_SOURCE_MAX = CHILD_LINE_MAX * 8;

/**
 * 按 code point 切，别落在代理对中间：切开一个 emoji 会留下孤立高代理，
 * 写进日志就是 U+FFFD。只在超长行上出现，肉眼很难联想到是截断切歪了。
 */
function sliceSafe(text: string, max: number): string {
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 压成一行并按上限截断。`prefix` 也算在宽度里——否则前缀一长，整行照样撑破。 */
export function oneLine(text: string, prefix = ""): string {
	const source = text.length > CHILD_SOURCE_MAX ? sliceSafe(text, CHILD_SOURCE_MAX) : text;
	const collapsed = `${prefix}${source}`.replace(/\s+/g, " ").trim();
	return collapsed.length > CHILD_LINE_MAX ? `${sliceSafe(collapsed, CHILD_LINE_MAX - 1)}…` : collapsed;
}

function previewArgs(args: unknown): string | undefined {
	if (args === undefined || args === null) return undefined;
	try {
		// 参数是一整块 JSON，这一步的 stringify 免不了；超大参数就是这一段内存开销，
		// 后面那刀预切只封正则，封不住它
		return JSON.stringify(args) || undefined;
	} catch {
		// 循环引用之类序列化不了的结构：宁可不带参数，也不把事件处理搞挂
		return undefined;
	}
}

/**
 * 子会话的事件流里只有少数几种对人有用：它调了什么工具、回了什么话、哪里失败了。
 * 原样记下来就是一串 `message_update` 这类内部名词——终态消息的「最后几行」
 * 和完整日志都变成读不了的东西，所以这里先翻译成人能扫的行。
 */
export function describeChildEvent(record: unknown): string | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const event = record as { type?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; message?: unknown };
	if (typeof event.type !== "string") return undefined;
	const tool = typeof event.toolName === "string" ? event.toolName : "工具";

	if (event.type === "tool_execution_start") {
		const preview = previewArgs(event.args);
		// 工具名也要过 oneLine：它同样可能带换行 / 超长，劈开日志行就毁了「一行一个事件」
		return preview === undefined ? oneLine(tool, "→ ") : oneLine(preview, `→ ${tool}：`);
	}

	// 工具跑失败是「最后几行」里最该看见的东西
	if (event.type === "tool_execution_end" && event.isError === true) return oneLine(`${tool} 执行失败`, "× ");
	if (event.type !== "message_end") return undefined;

	const message = event.message as { role?: unknown; errorMessage?: unknown; content?: unknown } | undefined;
	if (!message || message.role !== "assistant") return undefined;
	if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
		return oneLine(message.errorMessage, "× ");
	}

	const text = firstTextPart(message.content);
	return text?.trim() ? oneLine(text) : undefined;
}

/**
 * stdout 是 JSONL 流。按 LF 切，残行扣住等下一块——
 * 和 monitor 切行器同一套逻辑，只是这里多一步 JSON.parse。
 */
export function parseJsonLines(buffer: string): { records: unknown[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const records: unknown[] = [];
	for (const line of parts) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			// 认不出来的行直接忽略：会话头、警告、半截输出都可能落在这里
		}
	}
	return { records, rest };
}

/**
 * 进程结束时把没带换行的残行也交出去。
 * 残行往往就是最终 `message_end`——也就是子会话的答复本身，
 * 只收进 summary 不回调 `onEvent` 的话，环形缓冲与完整日志会静默缺掉最关键那行。
 */
export function flushChildTail(buffer: string, emit?: (record: unknown) => void): unknown[] {
	const tail = parseJsonLines(`${buffer}\n`);
	for (const record of tail.records) emit?.(record);
	return tail.records;
}

/** 子会话是否算失败。 */
export function isFailedChild(summary: ChildSummary, exitCode: number): boolean {
	return exitCode !== 0 || summary.stopReason === "error" || summary.stopReason === "aborted";
}

/**
 * 怎么把 Pi 再叫起来一次。当前进程是打包过的 Pi 时直接复用它的入口，
 * 否则退回 PATH 上的 `pi`。
 */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

export interface WorktreeHandle {
	path: string;
	/** 建它时的那个仓库，清理要回到这里执行。 */
	base: string;
}

async function runGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => (stdout += chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => (stderr += chunk));
		child.on("error", (error) => resolve({ ok: false, stdout, stderr: String(error) }));
		child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
	});
}

/** 为一次子会话开一个独立的 worktree，子会话在里面改东西，不碰主工作区。 */
export async function createIsolatedWorktree(
	base: string,
): Promise<{ ok: true; handle: WorktreeHandle } | { ok: false; error: string }> {
	const dir = await mkdtemp(join(tmpdir(), "workflow-tools-wt-"));
	const path = join(dir, "repo");

	const added = await runGit(["worktree", "add", "--detach", path], base);
	if (!added.ok) {
		await rm(dir, { recursive: true, force: true });
		return { ok: false, error: `建 worktree 失败：${added.stderr.trim() || added.stdout.trim()}` };
	}
	return { ok: true, handle: { path, base } };
}

/**
 * 收工。有未提交改动时**不删**——把路径交回给调用方，
 * 让人自己决定是留着还是清掉。
 */
export async function releaseWorktree(handle: WorktreeHandle): Promise<{ removed: boolean; reason?: string }> {
	const status = await runGit(["status", "--porcelain"], handle.path);
	if (!status.ok) return { removed: false, reason: "读不到 worktree 状态，保守起见不删。" };
	if (status.stdout.trim().length > 0) {
		return { removed: false, reason: "worktree 里有未提交改动，已保留。" };
	}

	const removed = await runGit(["worktree", "remove", handle.path], handle.base);
	if (!removed.ok) return { removed: false, reason: removed.stderr.trim() || "移除 worktree 失败。" };
	await rm(dirname(handle.path), { recursive: true, force: true });
	return { removed: true };
}

export interface ChildOutcome {
	summary: ChildSummary;
	exitCode: number;
	stderr: string;
	aborted: boolean;
}

export interface RunningChild {
	process: TaskProcess;
	result: Promise<ChildOutcome>;
}

/**
 * 起一个子 Pi。子进程跑在自己的**进程组**里，取消时打整组——
 * 只杀直接子进程的话，子 Pi 拉起的 bash / 编辑器会变成孤儿。
 */
export async function startChildPi(input: {
	agent: AgentDefinition;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	isolate?: boolean;
	signal?: AbortSignal;
	onEvent?: (record: unknown) => void;
}): Promise<RunningChild> {
	let promptDir: string | undefined;
	let promptPath: string | undefined;

	if (input.agent.systemPrompt.trim()) {
		promptDir = await mkdtemp(join(tmpdir(), "workflow-tools-"));
		promptPath = join(promptDir, `${safeFileName(input.agent.name)}.md`);
		// 0600：系统提示可能含敏感内容，不给同机其他用户读
		await writeFile(promptPath, input.agent.systemPrompt, { mode: 0o600 });
	}

	const args = buildChildArgs({
		agent: input.agent,
		task: input.task,
		...(input.model ? { model: input.model } : {}),
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		...(promptPath ? { promptPath } : {}),
		...(input.isolate ? { isolate: true } : {}),
	});
	const invocation = piInvocation(args);

	const child = spawn(invocation.command, invocation.args, {
		cwd: input.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		// detached 让子进程成为新进程组的组长，pgid === pid
		detached: true,
	});

	let aborted = false;
	let buffer = "";
	let stderr = "";
	const records: unknown[] = [];

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		const parsed = parseJsonLines(buffer);
		buffer = parsed.rest;
		for (const record of parsed.records) {
			records.push(record);
			input.onEvent?.(record);
		}
	});

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exited = new Promise<void>((resolve) => {
		child.on("close", () => resolve());
		child.on("error", () => resolve());
	});

	const result = new Promise<ChildOutcome>((resolve) => {
		const settle = (exitCode: number) => {
			for (const record of flushChildTail(buffer, input.onEvent)) records.push(record);
			resolve({ summary: summarizeChildOutput(records), exitCode, stderr, aborted });
		};
		child.on("close", (code) => settle(code ?? 0));
		child.on("error", () => settle(1));
	});

	/** 打整个进程组；组已经没了就退回打直接子进程。 */
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
		const onAbort = () => {
			aborted = true;
			killGroup("SIGTERM");
		};
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	const cleanup = async () => {
		if (promptDir) await rm(promptDir, { recursive: true, force: true });
	};
	void result.finally(cleanup);

	return { process: { signal: killGroup, exited }, result };
}
