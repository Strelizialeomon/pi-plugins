/**
 * workflow-tools —— 选项卡、任务监控与 subagent。
 *
 * 这个文件只做接线：把纯逻辑模块接到 Pi 的 ExtensionAPI 上。
 * 判定规则、状态机、投递策略都在各自的模块里，单测不需要起 Pi。
 */

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askQuestions, validateQuestions } from "./question-card.ts";
import { startShellCommand } from "./monitor.ts";
import { renderQuestionResult, renderTaskCall, renderTaskResult } from "./renderers.ts";
import {
	applyChainStep,
	createIsolatedWorktree,
	describeChildEvent,
	discoverAgents,
	isFailedChild,
	needsProjectTrust,
	releaseWorktree,
	startChildPi,
	type AgentDefinition,
	type ChildUsage,
	type WorktreeHandle,
} from "./subagent.ts";
import {
	createTaskRuntime,
	oneLine,
	type LogSink,
	type RunningTask,
	type RuntimeSink,
	type TaskRuntime,
	type TerminalStatus,
} from "./task-runtime.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;

function ok(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details, isError: true };
}

/**
 * 进度摘要消息。消息头带任务身份，否则多个任务并行时「[N 行合并]」分不清是谁的。
 * `description` 是工具参数（无长度上限、可含换行），所以它也得压成一行并按上限截断。
 */
export function progressMessage(input: { taskId: string; kind: string; description: string; text: string }): string {
	const header = oneLine(input.description, `任务 ${input.taskId}（${input.kind}）`);
	return `${header}\n${input.text}`;
}

export default function (pi: ExtensionAPI) {
	let runtime: TaskRuntime | undefined;
	// 界面动作（notify / setStatus）需要 ctx；工具执行期间会刷新它。
	let ui: ExtensionToolContext["ui"] | undefined;

	const sink: RuntimeSink = {
		pushTerminal({ status, text }) {
			// 终态必推：带 triggerTurn，会话空闲时也要把模型唤醒。
			// 不要传 deliverAs —— nextTurn 会绕过 triggerTurn，消息就只在下次开工时才被消费。
			pi.sendMessage(
				{ customType: "workflow-tools:terminal", content: text, display: true, details: { status } },
				{ triggerTurn: true },
			);
		},
		pushProgress({ taskId, kind, description, text }) {
			// 进度不抢回合：不带 triggerTurn，只在当前回合内插入。
			pi.sendMessage({
				customType: "workflow-tools:progress",
				content: progressMessage({ taskId, kind, description, text }),
				display: true,
			});
		},
		notify(message, type) {
			ui?.notify(message, type);
		},
		status(key, text) {
			ui?.setStatus(key, text);
		},
	};

	function rt(ctx: ExtensionToolContext): TaskRuntime {
		ui = ctx.ui;
		runtime ??= createTaskRuntime({
			sink,
			now: () => Date.now(),
			limits: { maxTasks: 8, maxRunning: 4 },
			openLog: (taskId) => openTaskLog(taskId),
			exitWaitMs: 10_000,
		});
		return runtime;
	}

	pi.on("session_shutdown", async () => {
		// 收尾顺序由运行时负责：置位 → 拒绝新 spawn → 打进程组 → await 退出。
		await runtime?.shutdown();
		runtime = undefined;
		releaseTaskLogs();
	});

	// —— ask_user_question ——

	pi.registerTool(
		defineTool({
			name: "ask_user_question",
			label: "Ask user question",
			description:
				"向用户提 1～4 个结构化选择题并拿到答案。需要用户拍板时用它，别用普通文本提问。每题必须给一个 id，答案以 id 为 key。" +
				"Other 与 Chat about this 由卡片自己提供，别自己加这两项。卡片会按终端尺寸排布：超屏的题目、描述、预览、备注会被剪掉并在卡上标注剪掉了几行，" +
				"preview 超过 2000 字符干脆不显示——要用户读到全文就把内容写短，或拆成多题。" +
				"摆 spec-flow 审核档位卡时，调用方要把「文档检查：绿 / 红+摘要 / 无入口」和「N 份 × 该档 = X 个 agent / Y 分钟」两行写进相关问题的 description——卡片不会替你补。",
			parameters: Type.Object({
				questions: Type.Array(
					Type.Object({
						id: Type.String({ description: "本题标识，答案以它为 key；题内唯一" }),
						question: Type.String({ description: "完整问题文本" }),
						header: Type.String({ description: "最多 12 个字符的短标签" }),
						multiSelect: Type.Boolean({ description: "是否多选" }),
						options: Type.Array(
							Type.Object({
								label: Type.String({ description: "简短选项文案" }),
								description: Type.String({ description: "选项说明" }),
								preview: Type.Optional(Type.String({ description: "聚焦时展示的辅助预览" })),
							}),
							{ description: "2～4 个选项" },
						),
					}),
				),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const validated = validateQuestions(params);
				if (!validated.ok) return fail(validated.error, { kind: "invalid_arguments" });

				// signal 必须传下去：RPC 侧的 select/input 要靠它落定，
				// 否则卡片一挂，cardOpen 就永远是 true，之后每次调用都返回 busy。
				const result = await askQuestions(ctx, validated.questions, signal);
				return ok(JSON.stringify(result), result);
			},
			renderCall(args) {
				return renderTaskCall("ask_user_question", `${args.questions.length} 个问题`);
			},
			renderResult(result, _options, theme, context) {
				return renderQuestionResult(result, theme, context.args.questions);
			},
		}),
	);

	// —— monitor ——

	pi.registerTool(
		defineTool({
			name: "monitor",
			label: "Monitor",
			description:
				"监听一条 shell 命令的输出行，或订阅一个已登记任务的内部事件。事件会主动回到主会话，不需要轮询。",
			parameters: Type.Object({
				description: Type.String({ description: "这个监听在干什么，用于通知和上下文" }),
				command: Type.Optional(Type.String({ description: "要跑的 shell 命令，stdout 每行一个事件" })),
				task_id: Type.Optional(Type.String({ description: "要订阅的内部任务 ID" })),
				timeout_ms: Type.Optional(
					Type.Number({ description: "仅对 command 模式有效；默认 300000，最大 1800000，0 表示持续到任务结束" }),
				),
				deliver: Type.Optional(
					Type.Union([Type.Literal("digest"), Type.Literal("terminal")], {
						description: "digest（默认）按 30 秒窗口合并进度；terminal 时进度完全不进上下文",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const tasks = rt(ctx);
				const hasCommand = typeof params.command === "string" && params.command.length > 0;
				const hasTaskId = typeof params.task_id === "string" && params.task_id.length > 0;

				if (hasCommand === hasTaskId) {
					return fail("必须且只能给一个输入源：`command` 或 `task_id`。", { kind: "invalid_arguments" });
				}

				const deliver = params.deliver ?? "digest";

				if (hasTaskId) {
					const taskId = params.task_id as string;
					const subscription = tasks.subscribe(taskId);
					if (!subscription) return fail(`没有这个任务：${taskId}`, { kind: "unknown_task" });

					// 已经终态：立刻回放快照，不挂到超时。
					if (subscription.alreadyFinished) {
						return ok(
							JSON.stringify({ taskId, status: subscription.snapshot?.status, alreadyFinished: true }),
							subscription.snapshot,
						);
					}

					// 订阅只是视图：终态由运行时统一推一条，这里不产生第二条。
					return ok(JSON.stringify({ taskId, status: "running", persistent: true }), {
						taskId,
						status: "running",
					});
				}

				const command = params.command as string;
				const timeoutMs = normalizeTimeout(params.timeout_ms);
				const begun = tasks.begin({
					kind: "monitor",
					description: params.description,
					deliver,
				});
				if (!begun.ok) return fail(beginFailureText(begun.reason), { kind: begun.reason });

				const task: RunningTask = begun.task;
				ctx.ui.notify(`开始监听：${params.description}`, "info");

				const started = startShellCommand({
					command,
					cwd: ctx.cwd,
					signal: combinedSignal(signal, task),
					onLine: (line) => tasks.progress(task.id, line),
				});
				tasks.attachProcess(task.id, started.process);

				// 超时走和 task_stop 同一条路：打进程组 → 等退出 → 升级 SIGKILL。
				// 直接 abort + finish 会把进程句柄从注册表摘掉，抗 SIGTERM 的命令
				// 就变成再也管不着的孤儿。
				const timer = timeoutMs > 0 ? setTimeout(() => tasks.stop(task.id, "expired"), timeoutMs) : undefined;

				void started.result.then(({ exitCode }) => {
					if (timer) clearTimeout(timer);
					// 被 stop 过的任务已带 intent，这里的 completed 会被 intent 压住
					tasks.finish(task.id, exitCode === 0 ? "completed" : "failed");
				});

				return ok(
					JSON.stringify({
						taskId: task.id,
						status: "running",
						timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
						persistent: timeoutMs === 0,
					}),
					{ taskId: task.id, status: "running" },
				);
			},
			renderCall(args) {
				return renderTaskCall("monitor", args.description);
			},
			renderResult(result) {
				const details = result.details as { taskId?: string; status?: string } | undefined;
				return renderTaskResult(`monitor · ${details?.status ?? "已返回"}${details?.taskId ? ` · ${details.taskId}` : ""}`);
			},
		}),
	);

	// —— subagent ——

	pi.registerTool(
		defineTool({
			name: "subagent",
			label: "Subagent",
			description:
				"在独立 Pi 子会话里跑一个专用 agent，支持单个、并行和链式。子会话是当前会话的执行分身，不是独立第三方。",
			parameters: Type.Object({
				agent: Type.Optional(Type.String({ description: "单个模式：agent 名字" })),
				task: Type.Optional(Type.String({ description: "单个模式：交给它做的事" })),
				tasks: Type.Optional(
					Type.Array(
						Type.Object({
							agent: Type.String(),
							task: Type.String(),
							cwd: Type.Optional(Type.String()),
						}),
						{ description: "并行模式：最多 8 个任务" },
					),
				),
				chain: Type.Optional(
					Type.Array(
						Type.Object({
							agent: Type.String(),
							task: Type.String(),
							cwd: Type.Optional(Type.String()),
						}),
						{ description: "链式模式：按顺序跑，{previous} 会替换成上一步结果" },
					),
				),
				cwd: Type.Optional(Type.String()),
				run_in_background: Type.Optional(Type.Boolean({ description: "true 时立即返回任务 ID" })),
				model: Type.Optional(Type.String()),
				thinking_level: Type.Optional(Type.String()),
				isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
				agentScope: Type.Optional(
					Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
						description: "默认 user：项目级 agent 不参与",
					}),
				),
				confirmProjectAgents: Type.Optional(
					Type.Boolean({ description: "默认 true；传 false 表示调用方已自行承担项目级 agent 的信任决定" }),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const tasks = rt(ctx);
				const baseCwd = params.cwd ?? ctx.cwd;
				const pool = await resolveAgents(ctx, params.agentScope);

				// 先定模式，才能算出这次真正会用到哪些 agent
				const isChain = Array.isArray(params.chain) && params.chain.length > 0;
				const isParallel = Array.isArray(params.tasks) && params.tasks.length > 0;
				if (isChain && isParallel) {
					return fail("`tasks` 与 `chain` 只能给一个。", { kind: "invalid_arguments" });
				}

				const steps = isChain ? (params.chain as Array<{ agent: string; task: string; cwd?: string }>) : [];
				const items = isParallel ? (params.tasks as Array<{ agent: string; task: string; cwd?: string }>) : [];
				const names = isChain
					? steps.map((step) => step.agent)
					: isParallel
						? items.map((item) => item.agent)
						: params.agent
							? [params.agent]
							: [];

				if (names.length === 0) {
					return fail("需要给 `agent` + `task`、`tasks`、或 `chain` 三者之一。", { kind: "invalid_arguments" });
				}
				if (isParallel && names.length > 8) {
					return fail(`一次最多 8 个并行任务，收到 ${names.length} 个。`, { kind: "concurrency_exceeded" });
				}

				// 信任门对三个模式一视同仁——只在单个模式挡，等于没挡
				const guard = guardProjectAgent(names, pool, params.confirmProjectAgents, ctx);
				if (guard) return guard;

				// worktree 隔离：显式要求才建，子会话的改动落在独立工作区里，不碰主工作区
				let cwd = baseCwd;
				let worktree: WorktreeHandle | undefined;
				if (params.isolation === "worktree") {
					const created = await createIsolatedWorktree(baseCwd);
					if (!created.ok) return fail(created.error, { kind: "worktree_failed" });
					worktree = created.handle;
					cwd = created.handle.path;
				}

				const shared = { tasks, pool, cwd, params, signal, ctx, worktree };
				if (isChain) return await runChain({ ...shared, steps });
				if (isParallel) return await runParallel({ ...shared, items });
				if (!params.agent || !params.task) {
					return fail("单个模式需要同时给 `agent` 和 `task`。", { kind: "invalid_arguments" });
				}
				return await runOne({ ...shared, agentName: params.agent, taskText: params.task });
			},
			renderCall(args) {
				const what = args.chain?.length ? `链式 ${args.chain.length} 步` : args.tasks?.length ? `并行 ${args.tasks.length} 个` : (args.agent ?? "未指定");
				return renderTaskCall("subagent", what);
			},
			renderResult(result) {
				return renderTaskResult(result.isError ? "subagent · 失败" : "subagent · 完成");
			},
		}),
	);

	// —— task_stop ——

	pi.registerTool(
		defineTool({
			name: "task_stop",
			label: "Stop task",
			description: "停止一个还在跑的 monitor 或 subagent。对整个进程组发信号，不留孤儿进程。",
			parameters: Type.Object({
				task_id: Type.String({ description: "要停止的任务 ID" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const tasks = rt(ctx);
				const subscription = tasks.subscribe(params.task_id);

				if (!subscription) return fail(`没有这个任务：${params.task_id}`, { kind: "unknown_task" });
				if (subscription.alreadyFinished) {
					return ok(
						JSON.stringify({ taskId: params.task_id, status: subscription.snapshot?.status, alreadyFinished: true }),
						subscription.snapshot,
					);
				}

				tasks.stop(params.task_id, "stopped");
				return ok(JSON.stringify({ taskId: params.task_id, status: "stopping" }), {
					taskId: params.task_id,
					status: "stopping",
				});
			},
			renderCall(args) {
				return renderTaskCall("task_stop", args.task_id);
			},
			renderResult(result) {
				return renderTaskResult(result.isError ? "停止失败" : "已请求停止");
			},
		}),
	);
}

// —— 工具实现里的公共部分 ——

let logDir: string | undefined;

/** 环形缓冲只留最近 200 行，全量落在会话级临时目录里的一个文件。 */
export function openTaskLog(taskId: string): LogSink {
	logDir ??= mkdtempSync(join(tmpdir(), "workflow-tools-logs-"));
	const path = join(logDir, `${taskId}.log`);
	let fd: number | undefined;
	try {
		fd = openSync(path, "w");
	} catch {
		// 写不了日志不该让任务起不来
	}
	return {
		path,
		write(line) {
			if (fd === undefined) return;
			try {
				// 一行一次 writeSync：比 appendFileSync 每行 open+write+close 少两次系统调用，
				// 又不攒缓冲——日志的价值就在「进程没了它还在」
				writeSync(fd, `${line}\n`);
			} catch {
				// 同上：日志是旁路
			}
		},
		close() {
			if (fd === undefined) return;
			try {
				closeSync(fd);
			} catch {
				// 关不掉就算了，不该因为关文件把收尾搞挂
			}
			fd = undefined;
		},
	};
}

/**
 * 会话结束就把日志目录收掉。留着的话每开一次会话就在临时目录里积一个，
 * 而且会话都结束了，那条「完整日志：<路径>」也不会再有人去点。
 */
function releaseTaskLogs() {
	if (!logDir) return;
	try {
		rmSync(logDir, { recursive: true, force: true });
	} catch {
		// 清不掉就留着，不该因为清理失败把收尾搞挂
	}
	logDir = undefined;
}

/**
 * 并发排队：subagent 超过 4 个在跑的要等空槽，不能直接 spawn。
 * monitor 不走这条路——它不等空槽，但有空槽时同样会占一个运行位。
 * 等的时候任务可能已经被取消，返回 false 表示别再往下走了。
 */
async function waitForSlot(task: RunningTask, ready: Promise<void>, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	await ready;
	return !task.controller.signal.aborted;
}

/** 子会话用哪个模型 / 思考档：显式参数 > agent 文件 > 父会话。 */
export function resolveDispatch(
	agent: AgentDefinition,
	params: { model?: string; thinking_level?: string },
	ctx: ExtensionToolContext,
): { model?: string; thinkingLevel?: string } {
	const model = params.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	// agent 文件指定了模型时，不再继承父会话的思考档——那是给父模型调的
	const thinkingLevel = params.thinking_level ?? (params.model || agent.model ? undefined : ctx.thinkingLevel);
	return {
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value) || value < 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(value, MAX_TIMEOUT_MS);
}

function beginFailureText(reason: "concurrency_exceeded" | "shutting_down"): string {
	return reason === "concurrency_exceeded"
		? "并发已满：同一会话最多 8 个任务（monitor 与 subagent 合计）。等前面的任务结束再试。"
		: "会话正在收尾，这时不再接受新任务。";
}

async function resolveAgents(ctx: ExtensionToolContext, scope: "user" | "project" | "both" | undefined) {
	return await discoverAgents(ctx.cwd, scope);
}

/** 项目级 agent 要先过信任门；过不了就返回一个失败结果。 */
function guardProjectAgent(
	names: string[],
	pool: AgentDefinition[],
	confirmProjectAgents: boolean | undefined,
	ctx: ExtensionToolContext,
) {
	const picked = pool.filter((agent) => names.includes(agent.name));
	if (!needsProjectTrust(picked, confirmProjectAgents)) return undefined;
	if (ctx.isProjectTrusted()) return undefined;

	return fail(
		"这些 agent 来自项目目录，而当前项目未被信任。可信项目里直接可用；否则请在用户级 agent 目录放置同名定义。",
		{ kind: "untrusted_project_agents", agents: picked.map((agent) => agent.name) },
	);
}

function findAgent(pool: AgentDefinition[], name: string): AgentDefinition | undefined {
	return pool.find((agent) => agent.name === name);
}

function missingAgent(name: string, pool: AgentDefinition[]) {
	const available = pool.map((agent) => agent.name).join("、") || "（无）";
	return fail(`没有这个 agent：${name}。可用：${available}`, { kind: "unknown_agent" });
}

function summarizeForModel(input: {
	agent: string;
	task: string;
	status: string;
	text: string;
	model?: string;
	durationMs: number;
	toolCalls: number;
	usage: ChildUsage;
	stderr?: string;
}) {
	return {
		agent: input.agent,
		task: input.task,
		status: input.status,
		text: input.text,
		model: input.model,
		durationMs: input.durationMs,
		toolCalls: input.toolCalls,
		totalTokens: input.usage.totalTokens,
		// 真实成本挂在 usage.cost.total 上，不是一个平铺字段
		costTotal: input.usage.cost.total,
		stderr: input.stderr?.slice(-2000),
	};
}

/**
 * 起子会话。模型 / 思考档的取舍在这里一次算清，调用方只管传 params 和 ctx——
 * 展开写在每个调用点上，改一处漏一处就会让子会话静默退回父会话默认值。
 */
export async function runChild(
	input: {
		task: RunningTask;
		/** 事件要经运行时落环形缓冲与日志，所以这里拿的是整个运行时而不是单条环形缓冲。 */
		tasks: TaskRuntime;
		agent: AgentDefinition;
		taskText: string;
		cwd: string;
		params: { model?: string; thinking_level?: string };
		ctx: ExtensionToolContext;
		signal?: AbortSignal;
	},
	// 只在测试里换掉：这一层的全部职责就是把算好的参数交给子会话启动，
	// 不注入就只能靠真起一个子进程来验。
	startChild: typeof startChildPi = startChildPi,
) {
	return await startChild({
		agent: input.agent,
		task: input.taskText,
		cwd: input.cwd,
		...resolveDispatch(input.agent, input.params, input.ctx),
		...(input.signal ? { signal: input.signal } : {}),
		// 子会话要真的独立：不带用户级扩展 / 命令 / skills / MCP
		isolate: true,
		// 事件流先摊成「人扫得动」的行：直接记事件名的话，终态消息的「最后几行」
		// 和完整日志里全是 message_update / tool_execution_start 这类内部名词。
		onEvent: (record) => {
			const line = describeChildEvent(record);
			if (line !== undefined) input.tasks.record(input.task.id, line);
		},
	});
}

interface RunContext {
	tasks: TaskRuntime;
	pool: AgentDefinition[];
	cwd: string;
	params: { run_in_background?: boolean; model?: string; thinking_level?: string };
	signal?: AbortSignal;
	ctx: ExtensionToolContext;
	worktree?: WorktreeHandle;
}

/** 工具信号和任务取消信号要同时生效：只接工具信号的话，`task_stop` 对子 Pi 是条死线。 */
function combinedSignal(toolSignal: AbortSignal | undefined, task: RunningTask): AbortSignal | undefined {
	const signals = [toolSignal, task.controller.signal].filter((value): value is AbortSignal => value !== undefined);
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

async function settleWorktree(handle?: WorktreeHandle) {
	if (!handle) return undefined;
	const result = await releaseWorktree(handle);
	return { path: handle.path, removed: result.removed, ...(result.reason ? { reason: result.reason } : {}) };
}

async function runOne(input: RunContext & { agentName: string; taskText: string }) {
	const agent = findAgent(input.pool, input.agentName);
	if (!agent) return missingAgent(input.agentName, input.pool);

	const background = input.params.run_in_background === true;
	const begun = input.tasks.begin({
		kind: "subagent",
		description: `${agent.name}：${input.taskText.slice(0, 60)}`,
		deliver: "digest",
		// 前台的结果由工具返回值带走，不必再推一条终态
		announce: background,
	});
	if (!begun.ok) return fail(beginFailureText(begun.reason), { kind: begun.reason });

	const task = begun.task;
	const startedAt = Date.now();

	// 排队：第 5 个起的 subagent 要等空槽，不能直接 spawn
	if (!(await waitForSlot(task, begun.ready, input.signal))) {
		input.tasks.finish(task.id, "stopped");
		return fail("任务在排队期间被取消。", { kind: "cancelled" });
	}

	let child: ChildRun;
	try {
		child = await runChild({
			task,
			tasks: input.tasks,
			agent,
			taskText: input.taskText,
			cwd: input.cwd,
			params: input.params,
			ctx: input.ctx,
			signal: combinedSignal(input.signal, task),
		});
	} catch (error) {
		// 起不来也必须收敛，否则并发槽永久泄漏
		input.tasks.finish(task.id, "failed");
		await settleWorktree(input.worktree);
		return fail(`启动子会话失败：${error instanceof Error ? error.message : String(error)}`, { kind: "spawn_failed" });
	}
	input.tasks.attachProcess(task.id, child.process);

	if (background) {
		void child.result
			.then((outcome) =>
				input.tasks.finish(task.id, isFailedChild(outcome.summary, outcome.exitCode) ? "failed" : "completed"),
			)
			.catch(() => input.tasks.finish(task.id, "failed"))
			.finally(() => void settleWorktree(input.worktree));

		return ok(
			JSON.stringify({ taskId: task.id, status: "running", agent: agent.name, worktree: input.worktree?.path }),
			{ taskId: task.id, status: "running" },
		);
	}

	const outcome = await child.result;
	const failed = isFailedChild(outcome.summary, outcome.exitCode);
	input.tasks.finish(task.id, failed ? "failed" : "completed");
	const worktree = await settleWorktree(input.worktree);

	const summary = summarizeForModel({
		agent: agent.name,
		task: input.taskText,
		status: failed ? "failed" : "completed",
		text: outcome.summary.text,
		...(outcome.summary.model ? { model: outcome.summary.model } : {}),
		durationMs: Date.now() - startedAt,
		toolCalls: outcome.summary.toolCalls,
		usage: outcome.summary.usage,
		stderr: outcome.stderr,
	});

	const text = outcome.summary.text || outcome.summary.errorMessage || "（子会话没有返回文本）";
	return failed ? fail(text, summary) : ok(text, { ...summary, worktree });
}

type ChildRun = Awaited<ReturnType<typeof runChild>>;

interface ParallelEntry {
	agent: string;
	task: string;
	taskId?: string;
	child?: ChildRun;
	errorText?: string;
}

async function runParallel(input: RunContext & { items: Array<{ agent: string; task: string; cwd?: string }> }) {
	const entries: ParallelEntry[] = [];

	// 先把所有子会话都拉起来，再统一收结果。
	// 先 Promise.all 再挂回调，会在 spawn 抛错时让已经起来的任务永远停在 running，
	// 把并发槽全锁死——之后整会话的 subagent / monitor 都会 concurrency_exceeded。
	for (const item of input.items) {
		const agent = findAgent(input.pool, item.agent);
		if (!agent) {
			entries.push({
				agent: item.agent,
				task: item.task,
				errorText: firstLine(textOf(missingAgent(item.agent, input.pool))),
			});
			continue;
		}

		const begun = input.tasks.begin({
			kind: "subagent",
			description: `${agent.name}：${item.task.slice(0, 60)}`,
			deliver: "digest",
		});
		if (!begun.ok) {
			entries.push({ agent: agent.name, task: item.task, errorText: beginFailureText(begun.reason) });
			continue;
		}

		const task = begun.task;
		const entry: ParallelEntry = { agent: agent.name, task: item.task, taskId: task.id };
		entries.push(entry);

		try {
			if (!(await waitForSlot(task, begun.ready, input.signal))) {
				input.tasks.finish(task.id, "stopped");
				entry.errorText = "排队期间被取消";
				continue;
			}
			entry.child = await runChild({
				task,
				tasks: input.tasks,
				agent,
				taskText: item.task,
				cwd: item.cwd ?? input.cwd,
				params: input.params,
				ctx: input.ctx,
				signal: combinedSignal(input.signal, task),
			});
			input.tasks.attachProcess(task.id, entry.child.process);
		} catch (error) {
			input.tasks.finish(task.id, "failed");
			entry.errorText = error instanceof Error ? error.message : String(error);
		}
	}

	const results = [];
	for (const entry of entries) {
		if (!entry.child || !entry.taskId) {
			results.push({
				agent: entry.agent,
				task: entry.task,
				status: "failed",
				text: entry.errorText ?? "无法启动",
				error: true,
			});
			continue;
		}
		const outcome = await entry.child.result;
		const failed = isFailedChild(outcome.summary, outcome.exitCode);
		// 任一任务失败不取消其他任务；结果逐任务报告
		input.tasks.finish(entry.taskId, failed ? "failed" : "completed");
		results.push({
			agent: entry.agent,
			task: entry.task,
			taskId: entry.taskId,
			status: failed ? "failed" : "completed",
			text: outcome.summary.text || outcome.summary.errorMessage || "",
			toolCalls: outcome.summary.toolCalls,
			error: failed,
		});
	}

	const worktree = await settleWorktree(input.worktree);
	const anyFailed = results.some((result) => result.error);
	// 完整输出留在任务详情里，这里只回摘要，避免一次性撑大主上下文
	const headline = results
		.map((result) => `- ${result.agent}：${result.status}${result.text ? ` —— ${firstLine(result.text)}` : ""}`)
		.join("\n");

	return anyFailed ? fail(headline, { results, worktree }) : ok(headline, { results, worktree });
}

async function runChain(input: RunContext & { steps: Array<{ agent: string; task: string; cwd?: string }> }) {
	const results: Array<{ agent: string; status: string; text: string }> = [];
	let previous: string | undefined;

	for (const step of input.steps) {
		const agent = findAgent(input.pool, step.agent);
		if (!agent) {
			await settleWorktree(input.worktree);
			return missingAgent(step.agent, input.pool);
		}

		const begun = input.tasks.begin({
			kind: "subagent",
			description: `${agent.name}（链式）：${step.task.slice(0, 50)}`,
			deliver: "digest",
		});
		if (!begun.ok) {
			await settleWorktree(input.worktree);
			return fail(beginFailureText(begun.reason), { kind: begun.reason });
		}

		const task = begun.task;
		let child: ChildRun;
		try {
			if (!(await waitForSlot(task, begun.ready, input.signal))) {
				input.tasks.finish(task.id, "stopped");
				await settleWorktree(input.worktree);
				return fail("链式任务在排队期间被取消。", { kind: "cancelled" });
			}
			child = await runChild({
				task,
				tasks: input.tasks,
				agent,
				taskText: applyChainStep(step.task, previous),
				cwd: step.cwd ?? input.cwd,
				params: input.params,
				ctx: input.ctx,
				signal: combinedSignal(input.signal, task),
			});
		} catch (error) {
			input.tasks.finish(task.id, "failed");
			await settleWorktree(input.worktree);
			return fail(`启动子会话失败：${error instanceof Error ? error.message : String(error)}`, { kind: "spawn_failed" });
		}
		input.tasks.attachProcess(task.id, child.process);

		const outcome = await child.result;
		const failed = isFailedChild(outcome.summary, outcome.exitCode);
		input.tasks.finish(task.id, failed ? "failed" : "completed");
		results.push({ agent: agent.name, status: failed ? "failed" : "completed", text: outcome.summary.text });

		// 中间步骤失败时停止后续步骤
		if (failed) {
			const worktree = await settleWorktree(input.worktree);
			return fail(
				`链式在第 ${results.length} 步（${agent.name}）失败，后续步骤已停止。\n${firstLine(outcome.summary.text || outcome.summary.errorMessage || "")}`,
				{ results, worktree },
			);
		}
		previous = outcome.summary.text;
	}

	const worktree = await settleWorktree(input.worktree);
	const headline = results.map((result) => `- ${result.agent}：${result.status} —— ${firstLine(result.text)}`).join("\n");
	return ok(headline, { results, final: previous, worktree });
}

/** 从工具结果里取出给模型看的那段文本。 */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0)?.slice(0, 160) ?? "";
}
