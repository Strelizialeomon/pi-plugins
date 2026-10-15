/**
 * `ask_user_question`：把拍板动作变成结构化答案。
 *
 * 本文件分两层：
 * - 纯逻辑层（下）：参数校验与答案组装。不碰 Pi、不碰终端，单测直接跑。
 * - 接线层（上）：TUI / RPC 两套渲染与取值，由 `index.ts` 接进 ExtensionAPI。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { QuestionCard } from "./question-card-ui.ts";

export type QuestionMode = "tui" | "rpc" | "json" | "print";

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface QuestionSpec {
	id: string;
	question: string;
	header: string;
	multiSelect: boolean;
	options: QuestionOption[];
}

export interface Annotation {
	preview?: string;
	notes?: string;
	degraded?: boolean;
}

export type ValidationResult = { ok: true; questions: QuestionSpec[] } | { ok: false; error: string };

export interface Pick {
	id: string;
	selected: string[];
	/** 走 `Other` 自由输入时的原文。 */
	other?: string;
	preview?: string;
	notes?: string;
	/** RPC 下降级过（多选被拆成连续单选、preview 丢弃）。 */
	degraded?: boolean;
}

export interface AnsweredResult {
	kind: "answered";
	answers: Record<string, string>;
	responses?: Record<string, string>;
	annotations?: Record<string, Annotation>;
}

export const CANCELLED = { kind: "cancelled" } as const;
export const BUSY = { kind: "busy" } as const;

export function uiUnavailable(mode: string) {
	return { kind: "ui_unavailable", mode } as const;
}

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_HEADER = 12;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * 校验并归一化工具参数。失败返回可读原因，永不抛错——
 * 模型传错参数要拿到一条能自我纠正的说明，而不是一个栈。
 */
export function validateQuestions(raw: unknown): ValidationResult {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: "参数必须是对象。" };

	const questions = (raw as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return { ok: false, error: "`questions` 必须是数组。" };
	if (questions.length === 0) return { ok: false, error: "至少要有 1 个问题。" };
	if (questions.length > MAX_QUESTIONS) {
		return { ok: false, error: `最多 ${MAX_QUESTIONS} 个问题，收到 ${questions.length} 个。` };
	}

	const seen = new Set<string>();
	const normalized: QuestionSpec[] = [];

	for (const [index, item] of questions.entries()) {
		const at = `第 ${index + 1} 个问题`;
		if (typeof item !== "object" || item === null) return { ok: false, error: `${at}必须是对象。` };
		const q = item as Record<string, unknown>;

		if (!isNonEmptyString(q.id)) {
			return { ok: false, error: `${at}缺少 \`id\`。\`id\` 是答案的 key，必填。` };
		}
		if (seen.has(q.id)) {
			return { ok: false, error: `${at}的 \`id\`（${q.id}）与前面重复——重复会让两条问题互相覆盖。` };
		}
		seen.add(q.id);

		if (!isNonEmptyString(q.question)) return { ok: false, error: `${at}缺少 \`question\`。` };
		if (typeof q.multiSelect !== "boolean") return { ok: false, error: `${at}的 \`multiSelect\` 必须是布尔值。` };
		if (typeof q.header !== "string") return { ok: false, error: `${at}缺少 \`header\`。` };
		if (q.header.length > MAX_HEADER) {
			return { ok: false, error: `${at}的 \`header\` 超过 ${MAX_HEADER} 个字符（收到 ${q.header.length} 个）。` };
		}

		if (!Array.isArray(q.options)) return { ok: false, error: `${at}缺少 \`options\`。` };
		for (const opt of q.options) {
			const label = typeof opt === "object" && opt !== null ? (opt as { label?: unknown }).label : undefined;
			// 卡片自己要用 Other 行，RPC 降级还要用「选完了 / 取消」做终止项。
			// 模型若拿这些当 label，会撞上保留字，行为不是它想要的。
			if (typeof label === "string" && RESERVED_LABELS.includes(label)) {
				return { ok: false, error: `${at}的选项 label「${label}」是保留字，请换一个。` };
			}
		}
		if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: `${at}的选项数要在 ${MIN_OPTIONS}～${MAX_OPTIONS} 之间，收到 ${q.options.length} 个。`,
			};
		}

		const options: QuestionOption[] = [];
		for (const [optIndex, opt] of q.options.entries()) {
			if (typeof opt !== "object" || opt === null) {
				return { ok: false, error: `${at}的第 ${optIndex + 1} 个选项必须是对象。` };
			}
			const o = opt as Record<string, unknown>;
			if (!isNonEmptyString(o.label)) return { ok: false, error: `${at}的第 ${optIndex + 1} 个选项缺少 \`label\`。` };
			if (typeof o.description !== "string") {
				return { ok: false, error: `${at}的第 ${optIndex + 1} 个选项缺少 \`description\`。` };
			}
			if (o.preview !== undefined && typeof o.preview !== "string") {
				return { ok: false, error: `${at}的第 ${optIndex + 1} 个选项的 \`preview\` 必须是字符串。` };
			}
			options.push({
				label: o.label,
				description: o.description,
				...(o.preview !== undefined ? { preview: o.preview } : {}),
			});
		}

		normalized.push({
			id: q.id,
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect,
			options,
		});
	}

	return { ok: true, questions: normalized };
}

/**
 * 把用户的选择组装成工具结果。一切以 `id` 为 key——
 * 问题文本相同的两条不会互相覆盖。
 */
export function buildAnsweredResult(input: { picks: Pick[] }): AnsweredResult {
	const answers: Record<string, string> = {};
	const responses: Record<string, string> = {};
	const annotations: Record<string, Annotation> = {};
	let hasResponse = false;
	let hasAnnotation = false;

	for (const pick of input.picks) {
		const other = pick.other?.trim();
		if (other) {
			// 勾选项和自由输入要一起交给模型。只回 other 的话，
			// 用户看到的「A、B + 补充」到模型手里只剩补充那一句。
			const merged = [...pick.selected, other];
			answers[pick.id] = merged.join(", ");
			responses[pick.id] = other;
			hasResponse = true;
		} else {
			answers[pick.id] = pick.selected.join(", ");
		}

		const annotation: Annotation = {};
		if (pick.preview !== undefined) annotation.preview = pick.preview;
		if (pick.notes !== undefined) annotation.notes = pick.notes;
		if (pick.degraded !== undefined) annotation.degraded = pick.degraded;
		if (Object.keys(annotation).length > 0) {
			annotations[pick.id] = annotation;
			hasAnnotation = true;
		}
	}

	return {
		kind: "answered",
		answers,
		...(hasResponse ? { responses } : {}),
		...(hasAnnotation ? { annotations } : {}),
	};
}

// —— 接线层：TUI 卡片 / RPC 降级 / 无 UI 兜底 ——

const OTHER_LABEL = "Other";
const DONE_LABEL = "✓ 选完了";
const CANCEL_LABEL = "✗ 取消";

/** 卡片与 RPC 降级自己要用这些文案，模型不能再拿它们当选项 label。 */
const RESERVED_LABELS = [OTHER_LABEL, DONE_LABEL, CANCEL_LABEL];

/** 同一会话同时只允许一张活动卡片。并发调用直接拿到 busy。 */
let cardOpen = false;

/**
 * RPC 只有单值 select，多选按题拆成连续单选，preview 丢弃并标 degraded。
 * `opts.signal` 必须传：客户端崩了或不回包时，只有 abort 能把 promise 落定，
 * 否则 `cardOpen` 会永久卡住，之后每次调用都返回 busy。
 */
async function askViaRpc(
	ctx: ExtensionContext,
	questions: QuestionSpec[],
	signal?: AbortSignal,
): Promise<Pick[] | undefined> {
	const picks: Pick[] = [];
	const title = (q: QuestionSpec) => `${q.header} · ${q.question}`;
	const opts = signal ? { signal } : undefined;

	for (const q of questions) {
		const labels = q.options.map((option) => option.label);

		if (!q.multiSelect) {
			const picked = await ctx.ui.select(title(q), [...labels, OTHER_LABEL, CANCEL_LABEL], opts);
			if (picked === undefined || picked === CANCEL_LABEL) return undefined;
			if (picked === OTHER_LABEL) {
				const typed = await ctx.ui.input(q.question, "自由输入", opts);
				if (typed === undefined) return undefined;
				picks.push({ id: q.id, selected: [], other: typed, degraded: true });
			} else {
				picks.push({ id: q.id, selected: [picked], degraded: true });
			}
			continue;
		}

		// 多选：反复单选，选到「选完了」为止；再点同一个即取消勾选。
		// 轮数封顶，避免用户一直不点完成时把循环挂死。
		const chosen: string[] = [];
		for (let round = 0; round <= q.options.length; round++) {
			const picked = await ctx.ui.select(
				`${title(q)}（已选：${chosen.join("、") || "无"}）`,
				[...labels, DONE_LABEL, CANCEL_LABEL],
				opts,
			);
			if (picked === undefined || picked === CANCEL_LABEL) return undefined;
			if (picked === DONE_LABEL) break;
			const at = chosen.indexOf(picked);
			if (at >= 0) chosen.splice(at, 1);
			else chosen.push(picked);
		}
		picks.push({ id: q.id, selected: chosen, degraded: true });
	}

	return picks;
}

/**
 * 卡片要挂成铺满终端的浮层，不是因为好看：全屏模式下 Pi 会先把 PageUp/PageDown 交给自己的
 * 对话区滚动，只有聚焦中的浮层能拿到这套键（`TuiAltScreen.handleViewportInput` 里
 * `shouldDeferViewportInputToOverlay` 一条）。挂在编辑槽里的普通组件拿不到，翻页会静默失效。
 * 常规模式两种挂法都能收到，统一走浮层以免两套路径。
 *
 * 代价（已写进 README 与规格）：浮层期间宿主自己的视口滚动键也一并让给卡片，答题时滚不动转录。
 */
export const QUESTION_CARD_MOUNT = {
	overlay: true,
	overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-left", margin: 0 },
} as const;

/**
 * 三档降级：TUI 用自绘卡片，RPC 用 Pi 支持的基础选择交互，
 * JSON / print 直接返回 `ui_unavailable`——不挂着等一个不存在的终端。
 */
export async function askQuestions(
	ctx: ExtensionContext,
	questions: QuestionSpec[],
	signal?: AbortSignal,
): Promise<AnsweredResult | typeof CANCELLED | typeof BUSY | ReturnType<typeof uiUnavailable>> {
	if (cardOpen) return BUSY;
	if (ctx.mode !== "tui" && !ctx.hasUI) return uiUnavailable(ctx.mode);
	if (signal?.aborted) return CANCELLED;

	cardOpen = true;
	let card: QuestionCard | undefined;
	let overlay: OverlayHandle | undefined;
	try {
		let picks: Pick[] | undefined;

		if (ctx.mode === "tui") {
			picks = await ctx.ui.custom<Pick[] | undefined>(
				(tui, theme, keybindings, done) => {
					card = new QuestionCard(questions, tui, theme, keybindings, done, signal);
					return card;
				},
				{ ...QUESTION_CARD_MOUNT, onHandle: (handle) => { overlay = handle; } },
			);
		} else {
			picks = await askViaRpc(ctx, questions, signal);
		}

		if (picks === undefined) return CANCELLED;
		return buildAnsweredResult({ picks });
	} finally {
		// Pi 关闭浮层时弹的是「栈顶那条」。若关闭瞬间上面还压着宿主自己的浮层（全屏转录搜索），
		// 被弹掉的是它，卡片这条会永远留在栈里——全屏视口键从此一直让路给一张关掉的卡片。
		// 这里按句柄补一次精确出栈；正常路径上它早被弹掉了，是空操作。
		overlay?.hide();
		card?.dispose();
		cardOpen = false;
	}
}
