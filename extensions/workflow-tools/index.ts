/**
 * workflow-tools —— 选项卡、任务监控与 subagent。
 *
 * 这个文件只做接线：把纯逻辑模块接到 Pi 的 ExtensionAPI 上。
 * 判定规则、状态机、投递策略都在各自的模块里，单测不需要起 Pi。
 */

import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askQuestions, validateQuestions } from "./question-card.ts";
import { startShellCommand } from "./monitor.ts";
import { renderTaskCall, renderTaskResult } from "./renderers.ts";
import {
	applyChainStep,
	discoverAgents,
	isFailedChild,
	needsProjectTrust,
	selectAgents,
	startChildPi,
	type AgentDefinition,
} from "./subagent.ts";
import { createTaskRuntime, type RunningTask, type RuntimeSink, type TaskRuntime } from "./task-runtime.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;

function ok(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details, isError: true };
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
		pushProgress({ text }) {
			// 进度不抢回合：不带 triggerTurn，只在当前回合内插入。
			pi.sendMessage({ customType: "workflow-tools:progress", content: text, display: true });
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
		});
		return runtime;
	}

	pi.on("session_shutdown", async () => {
		// 收尾顺序由运行时负责：置位 → 拒绝新 spawn → 打进程组 → await 退出。
		await runtime?.shutdown();
		runtime = undefined;
	});

	// —— ask_user_question ——

	pi.registerTool(
		defineTool({
			name: "ask_user_question",
			label: "Ask user question",
			description:
				"向用户提 1～4 个结构化选择题并拿到答案。需要用户拍板时用它，别用普通文本提问。每题必须给一个 id，答案以 id 为 key。",
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
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const validated = validateQuestions(params);
				if (!validated.ok) return fail(validated.error, { kind: "invalid_arguments" });

				const result = await askQuestions(ctx, validated.questions);
				return ok(JSON.stringify(result), result);
			},
			renderCall(args) {
				return renderTaskCall("ask_user_question", `${args.questions.length} 个问题`);
			},
			renderResult(result) {
				const details = result.details as { kind?: string } | undefined;
				return renderTaskResult(`选项卡：${details?.kind ?? "已返回"}`);
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
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
					signal: task.controller.signal,
					onLine: (line) => tasks.progress(task.id, line),
				});
				tasks.attachProcess(task.id, started.process);

				const timer =
					timeoutMs > 0
						? setTimeout(() => {
								tasks.get(task.id)?.controller.abort();
								tasks.finish(task.id, "expired");
							}, timeoutMs)
						: undefined;

				void started.result.then(({ exitCode }) => {
					if (timer) clearTimeout(timer);
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
				const cwd = params.cwd ?? ctx.cwd;

				const pool = await resolveAgents(ctx, params.agentScope);

				if (Array.isArray(params.chain) && params.chain.length > 0) {
					return await runChain({ tasks, pool, steps: params.chain, cwd, params, signal, ctx });
				}
				if (Array.isArray(params.tasks) && params.tasks.length > 0) {
					if (params.tasks.length > 8) {
						return fail(`一次最多 8 个并行任务，收到 ${params.tasks.length} 个。`, {
							kind: "concurrency_exceeded",
						});
					}
					return await runParallel({ tasks, pool, items: params.tasks, cwd, params, signal, ctx });
				}

				if (!params.agent || !params.task) {
					return fail("单个模式需要同时给 `agent` 和 `task`。", { kind: "invalid_arguments" });
				}
				const guard = guardProjectAgent([params.agent], pool, params.confirmProjectAgents, ctx);
				if (guard) return guard;

				return await runOne({
					tasks,
					pool,
					agentName: params.agent,
					taskText: params.task,
					cwd,
					params,
					signal,
					ctx,
				});
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

				tasks.stop(params.task_id);
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

function normalizeTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value) || value < 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(value, MAX_TIMEOUT_MS);
}

function beginFailureText(reason: "concurrency_exceeded" | "shutting_down"): string {
	return reason === "concurrency_exceeded"
		? "并发已满：同一会话最多 8 个任务、4 个在运行。等前面的跑完再试。"
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
	usage: { totalTokens: number; costTotal: number };
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
		costTotal: input.usage.costTotal,
		stderr: input.stderr?.slice(-2000),
	};
}

async function runChild(input: {
	task: RunningTask;
	agent: AgentDefinition;
	taskText: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
}) {
	const started = await startChildPi({
		agent: input.agent,
		task: input.taskText,
		cwd: input.cwd,
		...(input.model ? { model: input.model } : {}),
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.signal ? { signal: input.signal } : {}),
		// 子会话要真的独立：不带用户级扩展 / 命令 / skills / MCP
		isolate: true,
		onEvent: (record) => {
			const event = record as { type?: string };
			if (typeof event.type === "string") input.task.ring.push(event.type);
		},
	});
	return started;
}

async function runOne(input: {
	tasks: TaskRuntime;
	pool: AgentDefinition[];
	agentName: string;
	taskText: string;
	cwd: string;
	params: { run_in_background?: boolean; model?: string; thinking_level?: string };
	signal?: AbortSignal;
	ctx: ExtensionToolContext;
}) {
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
	const child = await runChild({
		task,
		agent,
		taskText: input.taskText,
		cwd: input.cwd,
		...(input.params.model ? { model: input.params.model } : {}),
		...(input.params.thinking_level ? { thinkingLevel: input.params.thinking_level } : {}),
		...(input.signal ? { signal: input.signal } : {}),
	});
	input.tasks.attachProcess(task.id, child.process);

	if (background) {
		void child.result.then((outcome) => {
			input.tasks.finish(task.id, isFailedChild(outcome.summary, outcome.exitCode) ? "failed" : "completed");
		});
		return ok(JSON.stringify({ taskId: task.id, status: "running", agent: agent.name }), {
			taskId: task.id,
			status: "running",
		});
	}

	const outcome = await child.result;
	const failed = isFailedChild(outcome.summary, outcome.exitCode);
	input.tasks.finish(task.id, failed ? "failed" : "completed");

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
	return failed ? fail(text, summary) : ok(text, summary);
}

async function runParallel(input: {
	tasks: TaskRuntime;
	pool: AgentDefinition[];
	items: Array<{ agent: string; task: string; cwd?: string }>;
	cwd: string;
	params: { model?: string; thinking_level?: string };
	signal?: AbortSignal;
	ctx: ExtensionToolContext;
}) {
	const started = await Promise.all(
		input.items.map(async (item) => {
			const agent = findAgent(input.pool, item.agent);
			if (!agent) return { item, error: missingAgent(item.agent, input.pool) };

			const begun = input.tasks.begin({
				kind: "subagent",
				description: `${agent.name}：${item.task.slice(0, 60)}`,
				deliver: "digest",
			});
			if (!begun.ok) return { item, error: fail(beginFailureText(begun.reason), { kind: begun.reason }) };

			const child = await runChild({
				task: begun.task,
				agent,
				taskText: item.task,
				cwd: item.cwd ?? input.cwd,
				...(input.params.model ? { model: input.params.model } : {}),
				...(input.params.thinking_level ? { thinkingLevel: input.params.thinking_level } : {}),
				...(input.signal ? { signal: input.signal } : {}),
			});
			input.tasks.attachProcess(begun.task.id, child.process);
			return { item, agent, taskId: begun.task.id, child };
		}),
	);

	const results = await Promise.all(
		started.map(async (entry) => {
			if ("error" in entry) return { agent: entry.item.agent, status: "failed", text: "无法启动", error: true };
			if (!entry.child || !entry.taskId) return { agent: entry.item.agent, status: "failed", text: "无法启动", error: true };

			const outcome = await entry.child.result;
			const failed = isFailedChild(outcome.summary, outcome.exitCode);
			// 任一任务失败不取消其他任务；结果逐任务报告
			input.tasks.finish(entry.taskId, failed ? "failed" : "completed");
			return {
				agent: entry.item.agent,
				task: entry.item.task,
				taskId: entry.taskId,
				status: failed ? "failed" : "completed",
				text: outcome.summary.text || outcome.summary.errorMessage || "",
				toolCalls: outcome.summary.toolCalls,
				error: failed,
			};
		}),
	);

	const anyFailed = results.some((result) => result.error);
	// 完整输出留在任务详情里，这里只回摘要，避免一次性撑大主上下文
	const headline = results
		.map((result) => `- ${result.agent}：${result.status}${result.text ? ` —— ${firstLine(result.text)}` : ""}`)
		.join("\n");

	return anyFailed ? fail(headline, { results }) : ok(headline, { results });
}

async function runChain(input: {
	tasks: TaskRuntime;
	pool: AgentDefinition[];
	steps: Array<{ agent: string; task: string; cwd?: string }>;
	cwd: string;
	params: { model?: string; thinking_level?: string };
	signal?: AbortSignal;
	ctx: ExtensionToolContext;
}) {
	const results: Array<{ agent: string; status: string; text: string }> = [];
	let previous: string | undefined;

	for (const step of input.steps) {
		const agent = findAgent(input.pool, step.agent);
		if (!agent) return missingAgent(step.agent, input.pool);

		const begun = input.tasks.begin({
			kind: "subagent",
			description: `${agent.name}（链式）：${step.task.slice(0, 50)}`,
			deliver: "digest",
		});
		if (!begun.ok) return fail(beginFailureText(begun.reason), { kind: begun.reason });

		const child = await runChild({
			task: begun.task,
			agent,
			taskText: applyChainStep(step.task, previous),
			cwd: step.cwd ?? input.cwd,
			...(input.params.model ? { model: input.params.model } : {}),
			...(input.params.thinking_level ? { thinkingLevel: input.params.thinking_level } : {}),
			...(input.signal ? { signal: input.signal } : {}),
		});
		input.tasks.attachProcess(begun.task.id, child.process);

		const outcome = await child.result;
		const failed = isFailedChild(outcome.summary, outcome.exitCode);
		input.tasks.finish(begun.task.id, failed ? "failed" : "completed");
		results.push({ agent: agent.name, status: failed ? "failed" : "completed", text: outcome.summary.text });

		// 中间步骤失败时停止后续步骤
		if (failed) {
			return fail(
				`链式在第 ${results.length} 步（${agent.name}）失败，后续步骤已停止。\n${firstLine(outcome.summary.text || outcome.summary.errorMessage || "")}`,
				{ results },
			);
		}
		previous = outcome.summary.text;
	}

	const headline = results.map((result) => `- ${result.agent}：${result.status} —— ${firstLine(result.text)}`).join("\n");
	return ok(headline, { results, final: previous });
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0)?.slice(0, 160) ?? "";
}
