/**
 * `ask_user_question`：把拍板动作变成结构化答案。
 *
 * 本文件分两层：
 * - 纯逻辑层（下）：参数校验与答案组装。不碰 Pi、不碰终端，单测直接跑。
 * - 接线层（上）：TUI / RPC 两套渲染与取值，由 `index.ts` 接进 ExtensionAPI。
 */

import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
			answers[pick.id] = other;
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

/** 同一会话同时只允许一张活动卡片。并发调用直接拿到 busy。 */
let cardOpen = false;

/**
 * TUI 卡片。键盘约定：方向键移动、空格切换多选、Enter 确认、Esc 取消。
 * 选中 `Other` 后进入自由输入，逐字符收键，Enter 提交、Esc 退回。
 */
class QuestionCard implements Component {
	// Node 的 TS 支持只做类型擦除，不认参数属性，字段得显式声明
	readonly #questions: QuestionSpec[];
	readonly #done: (picks: Pick[] | undefined) => void;
	readonly #requestRender: () => void;
	#index = 0;
	#cursor = 0;
	#chosen: Array<Set<string>>;
	#other: Array<string | undefined>;
	#typing = false;
	#draft = "";

	constructor(
		questions: QuestionSpec[],
		done: (picks: Pick[] | undefined) => void,
		requestRender: () => void,
	) {
		this.#questions = questions;
		this.#done = done;
		this.#requestRender = requestRender;
		this.#chosen = questions.map(() => new Set<string>());
		this.#other = questions.map(() => undefined);
	}

	#current(): QuestionSpec {
		return this.#questions[this.#index] as QuestionSpec;
	}

	/** 尾部固定多一个 Other 行。 */
	#rows(): number {
		return this.#current().options.length + 1;
	}

	#isOther(): boolean {
		return this.#cursor === this.#current().options.length;
	}

	#commitQuestion() {
		if (this.#index < this.#questions.length - 1) {
			this.#index += 1;
			this.#cursor = 0;
			this.#requestRender();
			return;
		}

		this.#done(
			this.#questions.map((q, i) => {
				const other = this.#other[i];
				const preview = [...this.#chosen[i]]
					.map((label) => q.options.find((option) => option.label === label)?.preview)
					.find((value) => value !== undefined);
				return {
					id: q.id,
					selected: [...(this.#chosen[i] ?? [])],
					...(other ? { other } : {}),
					...(preview !== undefined ? { preview } : {}),
				};
			}),
		);
	}

	handleInput(data: string): void {
		if (this.#typing) {
			if (matchesKey(data, Key.escape)) {
				this.#typing = false;
				this.#draft = "";
			} else if (matchesKey(data, Key.enter)) {
				this.#other[this.#index] = this.#draft.trim() || undefined;
				this.#typing = false;
				this.#draft = "";
				this.#commitQuestion();
			} else if (matchesKey(data, Key.backspace)) {
				this.#draft = this.#draft.slice(0, -1);
			} else if (data.length === 1 && data >= " ") {
				this.#draft += data;
			}
			this.#requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.#cursor = (this.#cursor - 1 + this.#rows()) % this.#rows();
		} else if (matchesKey(data, Key.down)) {
			this.#cursor = (this.#cursor + 1) % this.#rows();
		} else if (matchesKey(data, Key.space)) {
			if (this.#isOther()) {
				this.#typing = true;
			} else if (this.#current().multiSelect) {
				const label = this.#current().options[this.#cursor]?.label ?? "";
				const bucket = this.#chosen[this.#index] as Set<string>;
				if (bucket.has(label)) bucket.delete(label);
				else bucket.add(label);
				this.#other[this.#index] = undefined;
			} else {
				const label = this.#current().options[this.#cursor]?.label ?? "";
				this.#chosen[this.#index] = new Set([label]);
				this.#other[this.#index] = undefined;
			}
		} else if (matchesKey(data, Key.enter)) {
			if (this.#isOther()) {
				this.#typing = true;
			} else {
				const label = this.#current().options[this.#cursor]?.label ?? "";
				if (!this.#current().multiSelect) {
					this.#chosen[this.#index] = new Set([label]);
					this.#other[this.#index] = undefined;
				} else {
					(this.#chosen[this.#index] as Set<string>).add(label);
				}
				this.#commitQuestion();
			}
		} else {
			return;
		}
		this.#requestRender();
	}

	invalidate(): void {
		// 无缓存，无需失效
	}

	render(width: number): string[] {
		const question = this.#current();
		const bucket = this.#chosen[this.#index] as Set<string>;
		const lines: string[] = [
			`[${this.#index + 1}/${this.#questions.length}] ${question.header} · ${question.question}`,
		];

		for (const [i, option] of question.options.entries()) {
			const pointer = i === this.#cursor ? "❯" : " ";
			const mark = question.multiSelect ? (bucket.has(option.label) ? "[x]" : "[ ]") : " ";
			const description = option.description ? `  ${option.description}` : "";
			lines.push(`${pointer} ${mark} ${option.label}${description}`);
		}

		const otherPointer = this.#isOther() ? "❯" : " ";
		const otherValue = this.#other[this.#index];
		const otherText = this.#typing ? this.#draft : (otherValue ?? "");
		lines.push(`${otherPointer}    ${OTHER_LABEL}${otherText ? `：${otherText}` : ""}`);

		lines.push(this.#typing ? "输入中 —— Enter 提交 · Esc 退回" : "↑↓ 移动 · 空格 切换 · Enter 确认 · Esc 取消");
		return lines.map((line) => truncateToWidth(line, width));
	}
}

/** RPC 只有单值 select，多选按题拆成连续单选，preview 丢弃并标 degraded。 */
async function askViaRpc(ctx: ExtensionContext, questions: QuestionSpec[]): Promise<Pick[] | undefined> {
	const picks: Pick[] = [];
	const title = (q: QuestionSpec) => `${q.header} · ${q.question}`;

	for (const q of questions) {
		const labels = q.options.map((option) => option.label);

		if (!q.multiSelect) {
			const picked = await ctx.ui.select(title(q), [...labels, OTHER_LABEL, CANCEL_LABEL]);
			if (picked === undefined || picked === CANCEL_LABEL) return undefined;
			if (picked === OTHER_LABEL) {
				const typed = await ctx.ui.input(q.question, "自由输入");
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
			const picked = await ctx.ui.select(`${title(q)}（已选：${chosen.join("、") || "无"}）`, [
				...labels,
				DONE_LABEL,
				CANCEL_LABEL,
			]);
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
 * 三档降级：TUI 用自绘卡片，RPC 用 Pi 支持的基础选择交互，
 * JSON / print 直接返回 `ui_unavailable`——不挂着等一个不存在的终端。
 */
export async function askQuestions(
	ctx: ExtensionContext,
	questions: QuestionSpec[],
): Promise<AnsweredResult | typeof CANCELLED | typeof BUSY | ReturnType<typeof uiUnavailable>> {
	if (cardOpen) return BUSY;
	if (ctx.mode !== "tui" && !ctx.hasUI) return uiUnavailable(ctx.mode);

	cardOpen = true;
	try {
		let picks: Pick[] | undefined;

		if (ctx.mode === "tui") {
			// custom() 的 Promise 在卡片调 done() 时落定，不需要自己搭闸门。
			picks = await ctx.ui.custom<Pick[] | undefined>((tui: TUI, _theme, _keybindings, done) =>
				new QuestionCard(
					questions,
					(result) => done(result),
					() => tui.requestRender(),
				),
			);
		} else {
			picks = await askViaRpc(ctx, questions);
		}

		if (picks === undefined) return CANCELLED;
		return buildAnsweredResult({ picks });
	} finally {
		cardOpen = false;
	}
}
