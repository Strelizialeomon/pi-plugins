import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Editor, getKeybindings, Key, matchesKey, stripTerminalSequences, visibleWidth, wrapTextWithAnsi,
	type Component, type EditorTheme, type Focusable, type Keybinding, type KeybindingsManager, type TUI,
} from "@earendil-works/pi-tui";
import type { CardOutcome, Pick, QuestionSpec } from "./question-card.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** 预览原始长度上限：超过就整块不渲染（对齐上游的 2000 字符门槛）。 */
export const MAX_PREVIEW_CHARS = 2000;
/** 列表可见项上限（对齐上游默认值 5）。 */
export const VISIBLE_ITEMS = 5;
/** 并排布局的宽度门槛：30 列选项栏 + 4 列间距 + 20 列最小预览宽。 */
export const SPLIT_MIN_COLUMNS = 54;
export const OPTION_COLUMN_WIDTH = 30;
export const COLUMN_GAP = 4;
/** 卡片总高上限相对终端行数的余量：给宿主留底部 4 行（沿用上一版）。 */
const SCREEN_RESERVE = 4;

/** 键名里这几个人话化后更好认；其余按键名首字母大写即可。 */
const NAMED_KEYS: Record<string, string> = { pageUp: "PgUp", pageDown: "PgDn", escape: "Esc", enter: "Enter", tab: "Tab", space: "Space" };

/**
 * 两套字形：Unicode 档与简易回退档。
 * 回退档不是纯 ASCII（`√` U+221A、`×` U+00D7），与上游回退表逐字一致。
 */
export interface Glyphs {
	pointer: string;
	tick: string;
	boxOn: string;
	boxOff: string;
	arrow: string;
	ellipsis: string;
}

export const UNICODE_GLYPHS: Glyphs = { pointer: "❯", tick: "✔", boxOn: "☒", boxOff: "☐", arrow: "›", ellipsis: "…" };
export const FALLBACK_GLYPHS: Glyphs = { pointer: ">", tick: "√", boxOn: "[×]", boxOff: "[ ]", arrow: ">", ellipsis: "..." };

/**
 * 字形能力判定：默认 Unicode，`TERM=dumb` 或三个 locale 变量都不含 UTF-8 时退回简易档。
 * 判定只做一次，整卡一致；测试可以显式传入字形集覆盖。
 */
export function pickGlyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
	if (env.TERM === "dumb") return FALLBACK_GLYPHS;
	const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter((value) => value).join(" ");
	return /utf-?8/i.test(locale) ? UNICODE_GLYPHS : FALLBACK_GLYPHS;
}

/** 剪裁标注串，全文只此一处产出，避免各处写法漂移。 */
export function hiddenMarker(hidden: number): string {
	return `─── ✂ ─── ${hidden} lines hidden `;
}

/** 超限就切，并给标注留一行；返回实际保留的行与被剪掉的行数。 */
function clip(lines: string[], maxLines: number): { lines: string[]; hidden: number } {
	if (maxLines <= 0) return { lines: [], hidden: lines.length };
	if (lines.length <= maxLines) return { lines, hidden: 0 };
	const keep = Math.max(0, maxLines - 1);
	return { lines: lines.slice(0, keep), hidden: lines.length - keep };
}

/** Use native editing/undo, but insert pastes through the non-collapsing public API. */
class FullTextEditor extends Editor {
	#paste: string | undefined;

	get isPasting(): boolean { return this.#paste !== undefined; }

	override handleInput(data: string): void {
		const start = data.indexOf(PASTE_START);
		if (this.isPasting || start >= 0) {
			if (this.#paste === undefined) {
				if (start > 0) super.handleInput(data.slice(0, start));
				this.#paste = data.slice(start + PASTE_START.length);
			} else {
				this.#paste += data;
			}
			const end = this.#paste.indexOf(PASTE_END);
			if (end < 0) return;
			const content = this.#paste.slice(0, end);
			const remaining = this.#paste.slice(end + PASTE_END.length);
			this.#paste = undefined;
			this.insertTextAtCursor(stripTerminalSequences(content).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""));
			if (remaining) this.handleInput(remaining);
			return;
		}
		if (data.length > 1 && !data.includes("\x1b") && data.charCodeAt(0) >= 32) {
			this.insertTextAtCursor(data);
			return;
		}
		super.handleInput(data);
	}
}

interface QuestionState {
	chosen: Set<number>;
	/** 已采用的 Other 正文；未采用时撤销，但草稿留着。 */
	other?: string;
	/** Other 草稿，Esc 退出不丢。 */
	draft: string;
	/** 备注，随答案一起回传。 */
	notes: string;
	cursor: number;
}

/** 当前编辑态：改 Other、还是改备注。 */
type Editing = "other" | "notes";

/** One bounded component works in both regular and fullscreen custom() slots. */
export class QuestionCard implements Component, Focusable {
	readonly #questions: QuestionSpec[];
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keys: KeybindingsManager;
	readonly #glyphs: Glyphs;
	readonly #done: (outcome: CardOutcome | undefined) => void;
	readonly #states: QuestionState[];
	readonly #signal?: AbortSignal;
	readonly #onAbort = () => this.#finish(undefined);
	#focused = false;
	/** 当前屏：0..n-1 是题目，n 是提交屏。 */
	#index = 0;
	#editor?: FullTextEditor;
	#editing?: Editing;
	#listScroll = 0;
	#error = "";
	#closed = false;

	constructor(
		questions: QuestionSpec[],
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: (outcome: CardOutcome | undefined) => void,
		signal?: AbortSignal,
		glyphs: Glyphs = pickGlyphs(),
	) {
		this.#questions = questions;
		this.#tui = tui;
		this.#theme = theme;
		this.#keys = keys ?? getKeybindings();
		this.#glyphs = glyphs;
		this.#done = done;
		this.#signal = signal;
		this.#states = questions.map(() => ({ chosen: new Set<number>(), draft: "", notes: "", cursor: 0 }));
		signal?.addEventListener("abort", this.#onAbort, { once: true });
		if (signal?.aborted) queueMicrotask(this.#onAbort);
	}

	get focused(): boolean { return this.#focused; }
	set focused(value: boolean) {
		this.#focused = value;
		if (this.#editor) this.#editor.focused = value;
	}

	#refresh(): void { this.#tui.requestRender(); }
	#question(): QuestionSpec { return this.#questions[this.#index]!; }
	#state(): QuestionState { return this.#states[this.#index]!; }
	#isSubmit(): boolean { return this.#index === this.#questions.length; }
	/** 列表项：0..options-1 是普通项，最后一项是 Other。 */
	#isOther(): boolean { return this.#state().cursor === this.#question().options.length; }
	#itemCount(): number { return this.#question().options.length + 1; }
	#matches(data: string, action: Keybinding): boolean { return this.#keys.matches(data, action); }
	#valid(state: QuestionState): boolean { return state.chosen.size > 0 || Boolean(state.other?.trim()); }
	/** 单题且单选时才提供 Chat；多选没有这条出口。 */
	#hasChat(): boolean { return !this.#isSubmit() && !this.#question().multiSelect; }

	#picks(): Pick[] {
		return this.#questions.map((question, i) => {
			const state = this.#states[i]!;
			const selected = [...state.chosen].map((index) => question.options[index]!.label);
			const preview = [...state.chosen].map((index) => question.options[index]!.preview).find((value) => value !== undefined);
			const notes = state.notes.trim();
			return {
				id: question.id,
				selected,
				...(state.other ? { other: state.other } : {}),
				...(preview !== undefined ? { preview } : {}),
				...(notes ? { notes } : {}),
			};
		});
	}

	#finish(outcome: CardOutcome | undefined): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.focused = false;
		this.#editor = undefined;
		for (const state of this.#states) {
			state.draft = "";
			state.other = undefined;
			state.notes = "";
			state.chosen.clear();
		}
		this.#done(outcome);
	}

	dispose(): void { this.#finish(undefined); }

	#goto(index: number): void {
		this.#index = index;
		this.#error = "";
		this.#editor = undefined;
		this.#editing = undefined;
		this.#listScroll = 0;
	}

	/**
	 * 推进到下一屏：普通题往后走，最后一题走到提交屏。
	 * 单题卡片没有标签栏，也就没有提交屏——答完即结束（上游同样对单题隐藏 Submit）。
	 */
	#advance(): void {
		if (this.#questions.length === 1) {
			this.#finish({ kind: "picks", picks: this.#picks() });
			return;
		}
		this.#goto(Math.min(this.#index + 1, this.#questions.length));
	}

	#submit(): void {
		const missing = this.#states.findIndex((state) => !this.#valid(state));
		if (missing >= 0) {
			this.#goto(missing);
			this.#error = "请先作答本题。";
			return;
		}
		this.#finish({ kind: "picks", picks: this.#picks() });
	}

	/** 单选 Enter = 选中并提交本题；多选 Enter = 确认已有勾选。 */
	#confirm(): void {
		const state = this.#state();
		const question = this.#question();
		if (this.#isOther()) {
			if (state.other) this.#advance();
			else this.#edit("other");
			return;
		}
		if (!question.multiSelect) state.chosen = new Set([state.cursor]);
		if (!this.#valid(state)) {
			this.#error = "请选择一项或填写 Other。";
			return;
		}
		this.#advance();
	}

	#toggle(): void {
		const state = this.#state();
		this.#error = "";
		if (this.#isOther()) {
			if (this.#question().multiSelect && state.other) state.other = undefined;
			else this.#edit("other");
			return;
		}
		if (this.#question().multiSelect) {
			if (state.chosen.has(state.cursor)) state.chosen.delete(state.cursor);
			else state.chosen.add(state.cursor);
		} else {
			state.chosen = new Set([state.cursor]);
			state.other = undefined;
		}
	}

	#edit(which: Editing): void {
		const theme: EditorTheme = {
			borderColor: (text) => this.#theme.fg("borderAccent", text),
			selectList: {
				selectedPrefix: (text) => this.#theme.fg("accent", text),
				selectedText: (text) => this.#theme.fg("accent", text),
				description: (text) => this.#theme.fg("muted", text),
				scrollInfo: (text) => this.#theme.fg("dim", text),
				noMatch: (text) => this.#theme.fg("warning", text),
			},
		};
		const state = this.#state();
		const editor = new FullTextEditor(this.#tui, theme);
		editor.setText(which === "other" ? state.draft : state.notes);
		editor.focused = this.focused;
		editor.onSubmit = (value) => {
			if (which === "notes") {
				state.notes = value;
				this.#editor = undefined;
				this.#editing = undefined;
				this.#error = "";
				this.#refresh();
				return;
			}
			if (!value.trim()) {
				editor.setText(state.draft);
				this.#error = "请输入非空答案。";
				return;
			}
			state.draft = value;
			state.other = value.trim();
			if (!this.#question().multiSelect) state.chosen.clear();
			this.#editor = undefined;
			this.#editing = undefined;
			this.#error = "";
			this.#advance();
		};
		this.#editor = editor;
		this.#editing = which;
	}

	#leaveEdit(): void {
		const state = this.#state();
		const editor = this.#editor;
		if (!editor) return;
		if (this.#editing === "notes") state.notes = editor.getExpandedText();
		else state.draft = editor.getExpandedText();
		editor.focused = false;
		this.#editor = undefined;
		this.#editing = undefined;
		this.#error = "";
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (this.#editor) {
			const editor = this.#editor;
			if (!editor.isPasting && matchesKey(data, Key.escape)) {
				this.#leaveEdit();
			} else {
				editor.handleInput(data);
				if (this.#editor === editor && !this.#closed) {
					const state = this.#state();
					if (this.#editing === "notes") state.notes = editor.getExpandedText();
					else state.draft = editor.getExpandedText();
				}
			}
			this.#refresh();
			return;
		}

		if (this.#matches(data, "tui.select.cancel")) {
			this.#finish(undefined);
			return;
		}

		// 数字键直选：单选等同于「移过去 + 确认」，多选只切换勾选（与上游多选列表一致）。
		const digit = /^[1-9]$/.exec(data);
		if (digit && !this.#isSubmit()) {
			const at = Number(digit[0]) - 1;
			const total = this.#itemCount() + (this.#hasChat() ? 1 : 0);
			if (at < total) {
				this.#state().cursor = at;
				if (this.#isChat()) this.#finish({ kind: "chat" });
				else if (this.#question().multiSelect) this.#toggle();
				else this.#confirm();
			}
			this.#refresh();
			return;
		}

		if (matchesKey(data, Key.space) && !this.#isSubmit()) {
			this.#toggle();
		} else if (this.#questions.length > 1 && (this.#matches(data, "tui.input.tab") || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			const back = matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
			const count = this.#questions.length + 1;
			this.#goto((this.#index + (back ? count - 1 : 1)) % count);
		} else if (data === "n" && !this.#isSubmit()) {
			this.#edit("notes");
		} else if (this.#isSubmit()) {
			if (this.#matches(data, "tui.select.confirm")) this.#submit();
		} else if (this.#matches(data, "tui.select.up") || this.#matches(data, "tui.select.down")) {
			const state = this.#state();
			const count = this.#itemCount() + (this.#hasChat() ? 1 : 0);
			state.cursor = (state.cursor + (this.#matches(data, "tui.select.up") ? count - 1 : 1)) % count;
		} else if (this.#matches(data, "tui.select.confirm")) {
			if (this.#isChat()) {
				this.#finish({ kind: "chat" });
				return;
			}
			this.#confirm();
		}
		this.#refresh();
	}

	/** 光标停在 Chat 行上（只有单选才有这一项，编号接在 Other 之后）。 */
	#isChat(): boolean { return this.#hasChat() && this.#state().cursor === this.#itemCount(); }

	invalidate(): void { this.#editor?.invalidate(); }

	#wrap(text: string, width: number, prefix = ""): string[] {
		const indent = visibleWidth(prefix);
		if (indent >= width) return wrapTextWithAnsi(prefix + text, width);
		return wrapTextWithAnsi(text, width - indent).map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`);
	}

	/** 键名按宿主配置渲染，不写死——用户换过绑定后底栏提示仍然是真的。 */
	#formatKey(key: string): string {
		const parts = key.split("+");
		const last = parts.pop() ?? "";
		const base = NAMED_KEYS[last] ?? (last.length === 1 ? last.toUpperCase() : last.charAt(0).toUpperCase() + last.slice(1));
		const head = parts.filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+");
		return head ? `${head}+${base}` : base;
	}

	#key(action: Keybinding): string {
		return this.#formatKey(this.#keys.getKeys(action)[0] ?? "-");
	}

	#allKeys(action: Keybinding): string {
		const keys = this.#keys.getKeys(action);
		return keys.length ? keys.map((key) => this.#formatKey(key)).join("/") : "-";
	}

	// —— 渲染 ——

	/** 题目标签栏：`← ☒ 题一 ☐ 题二 ✔ Submit →`，宽度不足按三层降级。 */
	#tabBar(width: number): string[] {
		if (this.#questions.length <= 1) return [];
		const g = this.#glyphs;
		const theme = this.#theme;
		const labels = this.#questions.map((q) => q.header || `Q${this.#questions.indexOf(q) + 1}`);
		const submit = ` ${g.tick} 提交 `;
		const left = "← ";
		const right = " →";
		const room = width - visibleWidth(left) - visibleWidth(right) - visibleWidth(submit);

		const cell = (label: string, index: number): string => {
			const answered = this.#valid(this.#states[index]!);
			const mark = answered ? g.boxOn : g.boxOff;
			const text = `${mark} ${label}`;
			if (index === this.#index) return theme.fg("accent", text);
			return this.#isSubmit() && index === this.#questions.length ? theme.fg("accent", text) : theme.fg("muted", text);
		};

		let parts: string[];
		const natural = labels.map((label, i) => cell(label, i));
		const naturalWidth = natural.reduce((sum, text, i) => sum + visibleWidth(text) + (i > 0 ? 2 : 0), 0);
		if (naturalWidth <= room) {
			parts = natural;
		} else {
			// 压缩：当前题最多占一半，其余每项至少 6 列。
			const half = Math.max(6, Math.floor(room / 2));
			const others = Math.max(1, this.#questions.length - 1);
			const each = Math.max(6, Math.floor((room - half) / others));
			parts = labels.map((label, i) => {
				const budget = i === this.#index ? half : each;
				return cell(this.#ellipsize(label, Math.max(1, budget - 4)), i);
			});
		}
		if (room <= 0 || parts.reduce((sum, text, i) => sum + visibleWidth(text) + (i > 0 ? 2 : 0), 0) > room) {
			// 兜底：只留当前题，标签回退 Q{n} 并截到 3 列。
			const at = Math.min(this.#index, this.#questions.length - 1);
			parts = [cell(`Q${at + 1}`.slice(0, 3), at)];
		}

		const tail = this.#isSubmit() ? theme.fg("accent", submit) : theme.fg("muted", submit);
		const line = theme.fg("muted", left) + parts.join("  ") + tail + theme.fg("muted", right);
		return [this.#ellipsizeAnsi(line, width)];
	}

	#ellipsize(text: string, width: number): string {
		if (visibleWidth(text) <= width) return text;
		const ellipsis = this.#glyphs.ellipsis;
		return wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(ellipsis)))[0] + ellipsis;
	}

	#ellipsizeAnsi(line: string, width: number): string {
		if (visibleWidth(line) <= width) return line;
		return this.#ellipsize(stripTerminalSequences(line), width);
	}

	/** 选项列表：`❯ 1. 标签 ✔`（多选带前置方框），描述另起一行。按「项」分组返回，供窗口切分。 */
	#optionItems(width: number): string[][] {
		const question = this.#question();
		const state = this.#state();
		const g = this.#glyphs;
		const theme = this.#theme;
		const items: string[][] = [];
		const indexWidth = String(this.#itemCount()).length + 1;

		for (let index = 0; index < this.#itemCount(); index++) {
			const bucket: string[] = [];
			items.push(bucket);
			const other = index === question.options.length;
			const selected = other ? Boolean(state.other) : state.chosen.has(index);
			const focused = state.cursor === index;
			const pointer = focused ? theme.fg("accent", g.pointer) : " ";
			const number = theme.fg("dim", `${index + 1}.`.padEnd(indexWidth));
			const mark = question.multiSelect ? `${selected ? theme.fg("success", g.boxOn) : g.boxOff} ` : "";
			const label = other ? `Other${!state.other && state.draft ? " · 草稿" : ""}` : question.options[index]!.label;
			const title = selected ? theme.fg("success", theme.bold(label)) : focused ? theme.fg("accent", label) : theme.fg("text", label);
			const tick = !question.multiSelect && selected ? ` ${theme.fg("success", g.tick)}` : "";
			const prefix = `${pointer} ${number} ${mark}`;
			bucket.push(...this.#wrap(`${title}${tick}`, width, prefix));
			const indent = " ".repeat(visibleWidth(prefix));
			// Other 空着时用占位文案顶上（上游的 input 项也是这么表达的），采用后换成正文。
			const placeholder = question.multiSelect ? "Type something" : "Type something.";
			const description = other ? state.other : question.options[index]!.description;
			if (description) bucket.push(...this.#wrap(theme.fg(selected ? "success" : "muted", description), width, indent));
			else if (other) bucket.push(...this.#wrap(theme.fg("dim", placeholder), width, indent));
		}

		if (this.#hasChat()) {
			const focused = this.#isChat();
			const pointer = focused ? theme.fg("accent", g.pointer) : " ";
			const number = theme.fg("dim", `${this.#itemCount() + 1}.`.padEnd(indexWidth));
			const label = focused ? theme.fg("accent", "Chat about this") : theme.fg("muted", "Chat about this");
			items.push(this.#wrap(label, width, `${pointer} ${number} `));
		}
		return items;
	}

	/**
	 * 列表窗口：最多 `VISIBLE_ITEMS` 项、且总行数不超过可用高度，焦点项必须在窗口内。
	 * 窗口只随焦点移动，不给独立翻页键（上游同样没有）。
	 */
	#window(items: string[][], focusItem: number, height: number, maxItems = VISIBLE_ITEMS): { start: number; rows: string[] } {
		// 单项自己也超高的（比如一条很长的描述）按可用高度剪掉并标注，不能让一个选项把卡片撑破。
		const weigh = (bucket: string[]) => Math.min(bucket.length, height);
		let start = Math.max(0, Math.min(this.#listScroll, Math.max(0, items.length - 1)));
		if (focusItem < start) start = focusItem;
		let end = start;
		let used = 0;
		while (end < items.length && end - start < maxItems) {
			const h = weigh(items[end]!);
			if (used + h > height && end > start) break;
			used += h;
			end += 1;
		}
		if (focusItem >= end) {
			start = focusItem;
			end = focusItem + 1;
			used = weigh(items[focusItem]!);
			while (end < items.length && end - start < maxItems && used + weigh(items[end]!) <= height) {
				used += weigh(items[end]!);
				end += 1;
			}
		}
		this.#listScroll = start;
		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const bucket = items[i]!;
			if (bucket.length <= height) {
				rows.push(...bucket);
				continue;
			}
			const keep = Math.max(0, height - 1);
			rows.push(...bucket.slice(0, keep), this.#theme.fg("warning", hiddenMarker(bucket.length - keep)));
		}
		return { start, rows };
	}

	/** 列表超窗时在底栏给出位置提示；没超就是空串。 */
	#positionHint(): string {
		if (this.#isSubmit()) return "";
		const total = this.#itemCount() + (this.#hasChat() ? 1 : 0);
		if (total <= VISIBLE_ITEMS) return "";
		return ` ${this.#state().cursor + 1}/${total}`;
	}

	/** 预览面板：有边框，超行剪裁并把标注插在内容之后、下边框之前。 */
	#previewPanel(preview: string | undefined, width: number, maxLines: number): string[] {
		const theme = this.#theme;
		const grid = "─";
		const ifEmpty = this.#theme.fg("muted", "（本项无预览）");
		const body = preview === undefined
			? [ifEmpty]
			: preview.length > MAX_PREVIEW_CHARS
				? this.#wrap(theme.fg("muted", "（预览过长，无法完整显示——请直接比较各选项的标签与描述）"), Math.max(1, width - 4))
				: this.#wrap(preview, Math.max(1, width - 4));

		const inner = Math.max(1, width - 4);
		const interiorBudget = Math.max(1, maxLines - 2);
		const clipped = body.length > interiorBudget;
		const keep = clipped ? Math.max(0, interiorBudget - 1) : body.length;
		const visible = body.slice(0, keep);
		const hidden = body.length - keep;

		const top = theme.fg("borderMuted", `┌${grid.repeat(Math.max(0, width - 2))}┐`);
		const bottom = theme.fg("borderMuted", `└${grid.repeat(Math.max(0, width - 2))}┘`);
		const lines = [top];
		for (const line of visible) {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			lines.push(`${theme.fg("borderMuted", "│")} ${line}${pad} ${theme.fg("borderMuted", "│")}`);
		}
		if (clipped) {
			const marker = this.#ellipsize(hiddenMarker(hidden), Math.max(0, width - 2));
			const pad = grid.repeat(Math.max(0, width - 2 - visibleWidth(marker)));
			lines.push(theme.fg("warning", `├${marker}${pad}┤`));
		}
		lines.push(bottom);
		return lines;
	}

	/** 提交屏：逐题列出答案，缺项标出。 */
	#submitRows(width: number): string[] {
		const g = this.#glyphs;
		const theme = this.#theme;
		const rows: string[] = [];
		this.#questions.forEach((question, i) => {
			const state = this.#states[i]!;
			const done = this.#valid(state);
			const mark = done ? theme.fg("success", g.boxOn) : theme.fg("warning", g.boxOff);
			const header = `${mark} ${i + 1}. ${question.header || question.id}`;
			rows.push(...this.#wrap(done ? theme.fg("text", header) : theme.fg("warning", header), width));
			const answer = [...state.chosen].map((index) => question.options[index]!.label);
			if (state.other) answer.push(state.other);
			rows.push(...this.#wrap(done ? answer.join(", ") : "未回答", width, "  "));
			if (state.notes.trim()) rows.push(...this.#wrap(theme.fg("muted", `备注：${state.notes.trim()}`), width, "  "));
		});
		if (rows.length > 0) rows.push("");
		rows.push(...this.#wrap(theme.fg("muted", "整体提交后交给模型。"), width));
		return rows;
	}

	/** 备注行：有内容显示内容（最多三行，超出剪掉并标注），没有显示入口提示。 */
	#notesRow(width: number): string[] {
		if (this.#isSubmit()) return [];
		const notes = this.#state().notes.trim();
		const theme = this.#theme;
		if (!notes) return this.#wrap(theme.fg("dim", "按 n 加备注"), width);
		const capped = clip(this.#wrap(`${theme.fg("muted", "备注：")}${notes}`, width), 3);
		return capped.hidden > 0 ? [...capped.lines, theme.fg("warning", hiddenMarker(capped.hidden))] : capped.lines;
	}

	#footer(width: number): string[] {
		const theme = this.#theme;
		let text: string;
		if (this.#editor) {
			text = this.#editing === "notes"
				? `${this.#key("tui.input.submit")} 采用  Esc 返回  ${this.#allKeys("tui.input.newLine")} 换行`
				: `${this.#key("tui.input.submit")} 确认  Esc 返回  ${this.#allKeys("tui.input.newLine")} 换行`;
		} else if (this.#isSubmit()) {
			text = `${this.#key("tui.select.confirm")} 提交  ${this.#key("tui.input.tab")} 返回  ${this.#key("tui.select.cancel")} 取消`;
		} else {
			const nav = this.#questions.length > 1 ? `${this.#key("tui.input.tab")}/↑↓ 导航` : "↑↓ 导航";
			text = `Enter 选择  ${nav}${this.#positionHint()}  n 备注  ${this.#key("tui.select.cancel")} 取消`;
		}
		const lines = this.#wrap(theme.fg("dim", text), width);
		if (this.#error) lines.unshift(...this.#wrap(theme.fg("error", this.#error), width));
		return lines;
	}

	render(width: number): string[] {
		if (this.#closed) return [];
		width = Math.max(1, width);
		const theme = this.#theme;
		const limit = Math.max(3, this.#tui.terminal.rows - SCREEN_RESERVE);

		const tabBar = this.#tabBar(width);
		const notes = this.#notesRow(width);
		const footer = this.#footer(width);

		if (this.#editor) {
			const head = this.#wrap(theme.fg("accent", theme.bold(this.#editing === "notes" ? "备注" : `[${this.#index + 1}/${this.#questions.length}] ${this.#question().header}`)), width);
			const rendered = this.#editor.render(width);
			const content = rendered.slice(1, -1);
			const cursor = Math.max(0, content.findIndex((line) => line.includes(CURSOR_MARKER)));
			const budget = Math.max(1, limit - tabBar.length - head.length - notes.length - footer.length - 2);
			const start = Math.max(0, Math.min(cursor - budget + 1, content.length - budget));
			return [...tabBar, ...head, rendered[0]!, ...content.slice(start, start + budget), rendered.at(-1)!, ...notes, ...footer];
		}

		// 正文预算：扣掉标签栏、备注行、底栏和题目后的空行，剩下的分给「题目 + 内容」。
		const chrome = tabBar.length + notes.length + footer.length + 2; // +2：题目后空行 + 内容与其上下的间隔
		const bodyBudget = Math.max(1, limit - chrome);
		const questionCap = Math.max(1, Math.floor(bodyBudget / 3));
		const questionBody = this.#wrap(theme.fg("text", this.#isSubmit() ? "核对答案" : this.#question().question), width);
		const question = clip(questionBody, questionCap);
		const questionLines = [...question.lines];
		if (question.hidden > 0) questionLines.push(theme.fg("warning", hiddenMarker(question.hidden)));

		const contentHeight = Math.max(1, bodyBudget - questionLines.length);
		const split = !this.#isSubmit() && !this.#question().multiSelect && this.#question().options.some((option) => option.preview !== undefined) && width >= SPLIT_MIN_COLUMNS;

		let content: string[];
		if (split) {
			const leftWidth = OPTION_COLUMN_WIDTH;
			const rightWidth = Math.max(1, width - leftWidth - COLUMN_GAP);
			const items = this.#optionItems(leftWidth);
			const focused = this.#state().cursor;
			// 左栏放不下就按项滚动，跟随焦点；右栏超限交给面板自己剪并标注。
			const left = this.#window(items, focused, contentHeight).rows;
			const preview = this.#isChat() ? undefined : this.#question().options[focused]?.preview;
			const right = this.#previewPanel(preview, rightWidth, contentHeight);
			content = [];
			for (let i = 0; i < contentHeight; i++) {
				const cell = left[i] ?? "";
				const pad = " ".repeat(Math.max(0, leftWidth - visibleWidth(cell)));
				content.push(`${cell}${pad}${" ".repeat(COLUMN_GAP)}${right[i] ?? ""}`);
			}
		} else {
			const submit = this.#isSubmit();
			const items = submit ? this.#submitRows(width).map((row) => [row]) : this.#optionItems(width);
			const preview = !submit && !this.#question().multiSelect ? this.#question().options[this.#state().cursor]?.preview : undefined;
			const panel = preview !== undefined ? this.#previewPanel(preview, width, Math.max(3, Math.min(contentHeight, 6))) : [];
			const listHeight = Math.max(1, contentHeight - panel.length);
			// 提交屏按行滚动，不受「最多 5 项」的列表窗口约束。
			const list = this.#window(items, submit ? 0 : this.#state().cursor, listHeight, submit ? Number.POSITIVE_INFINITY : VISIBLE_ITEMS).rows.slice(0, listHeight);
			content = [...list, ...panel];
		}

		// 内容区按预算预留了高度，两栏都短时会留一圈空白——卡片高度要跟内容走，不是跟预算走。
		while (content.length > 0 && stripTerminalSequences(content.at(-1)!).trim() === "") content.pop();
		const blank = content.length > 0 ? [""] : [];
		return [...tabBar, ...questionLines, ...blank, ...content, ...notes, ...footer];
	}
}
