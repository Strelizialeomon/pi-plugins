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
const NAMED_KEYS: Record<string, string> = {
	pageUp: "PgUp", pageDown: "PgDn", escape: "Esc", enter: "Enter", tab: "Tab", space: "Space",
	up: "↑", down: "↓", left: "←", right: "→",
};

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
		if (!question.multiSelect) {
			// 单选：普通项与已采用的 Other 互斥，选中普通项就把 Other 正文丢掉。
			state.chosen = new Set([state.cursor]);
			state.other = undefined;
		}
		if (!this.#valid(state)) {
			this.#error = "请选择一项或填写 Other。";
			return;
		}
		this.#advance();
	}

	#toggle(): void {
		const state = this.#state();
		this.#error = "";
		// Chat 行不是选项：空格与 Enter 一样，都是「先不选，聊两句」。
		// 少了这条，空格会把它的下标当成普通项写进答案，取值时越界。
		if (this.#isChat()) {
			this.#finish({ kind: "chat" });
			return;
		}
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

	#edit(which: Editing): FullTextEditor {
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
		return editor;
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
			// 提交屏内容放不下时靠上下键翻看，边界由渲染时夹取。
			else if (this.#matches(data, "tui.select.up")) this.#listScroll = Math.max(0, this.#listScroll - 1);
			else if (this.#matches(data, "tui.select.down")) this.#listScroll += 1;
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
		} else if (!this.#isSubmit() && this.#isOther() && this.#isTyping(data)) {
			// 上游的 Other 就是个内联输入框：打字（或粘贴）直接落到它上面，不需要先按 Enter。
			// 走到这里说明这一下输入没被任何已绑定按键吃掉，是真正的正文输入。
			const editor = this.#edit("other");
			editor.handleInput(data);
			this.#state().draft = editor.getExpandedText();
			this.#refresh();
			return;
		}
		this.#refresh();
	}

	/** 这一下输入是「打字 / 粘贴」而不是某个按键：只在这一层兜底里用。 */
	#isTyping(data: string): boolean {
		if (data.startsWith(PASTE_START)) return true;
		return !data.includes("\x1b") && data.length > 0 && data.charCodeAt(0) >= 32;
	}

	/** 光标停在 Chat 行上（只有单选才有这一项，编号接在 Other 之后）。 */
	#isChat(): boolean { return this.#hasChat() && this.#state().cursor === this.#itemCount(); }

	invalidate(): void { this.#editor?.invalidate(); }

	#wrap(text: string, width: number, prefix = ""): string[] {
		const indent = visibleWidth(prefix);
		if (indent >= width) return wrapTextWithAnsi(prefix + text, width);
		return wrapTextWithAnsi(text, width - indent).map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`);
	}

	/**
	 * 清洗外部原文（模型给的题目 / 标签 / 描述 / 预览，用户敲的 Other 与备注）：
	 * 先剥掉 ANSI 序列，再把剩下的控制字符压成空格——制表符在真终端里会撑乱列对齐，
	 * 而裸 ESC 能让外部文本自己上色。
	 * ⚠️ 只能在套主题色**之前**用；`#wrap` 收到的是已经上过色的串，那里不能做这件事。
	 */
	#clean(text: string): string {
		// 保留 \n（0x0a）：显式换行是正文的一部分，压平它会把预览挤成一整段。
		return stripTerminalSequences(text).replace(/[\t\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
	}

	/** 上下键的提示串：宿主改绑后跟着变，默认渲染成 `↑↓`。 */
	#scrollKeys(): string {
		const up = this.#key("tui.select.up");
		const down = this.#key("tui.select.down");
		return up === "↑" && down === "↓" ? "↑↓" : `${up}/${down}`;
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
		const labels = this.#questions.map((q) => this.#clean(q.header) || `Q${this.#questions.indexOf(q) + 1}`);
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

		// 每格除了标签还有方框（2 列）和一个空格；格与格之间再留 2 列。
		const OVERHEAD = 3;
		const GAP = 2;
		const total = (list: string[]) => list.reduce((sum, text, i) => sum + visibleWidth(text) + (i > 0 ? GAP : 0), 0);

		let parts: string[];
		const natural = labels.map((label, i) => cell(label, i));
		if (total(natural) <= room) {
			parts = natural;
		} else {
			// 压缩：当前题最多占可用宽一半（够用就不占满），其余每项平分剩下的，都留着方框的位置。
			const usable = room - GAP * (labels.length - 1);
			const want = Math.max(OVERHEAD + 1, Math.min(visibleWidth(labels[this.#index]!) + OVERHEAD, Math.floor(usable / 2)));
			const others = Math.max(1, labels.length - 1);
			const each = Math.max(OVERHEAD + 1, Math.floor((usable - want) / others));
			parts = labels.map((label, i) => {
				const budget = i === this.#index ? want : each;
				return cell(this.#ellipsize(label, Math.max(1, budget - OVERHEAD)), i);
			});
		}
		if (room <= 0 || total(parts) > room) {
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
			const label = other ? `Other${!state.other && state.draft ? " · 草稿" : ""}` : this.#clean(question.options[index]!.label);
			const title = selected ? theme.fg("success", theme.bold(label)) : focused ? theme.fg("accent", label) : theme.fg("text", label);
			const tick = !question.multiSelect && selected ? ` ${theme.fg("success", g.tick)}` : "";
			const prefix = `${pointer} ${number} ${mark}`;
			bucket.push(...this.#wrap(`${title}${tick}`, width, prefix));
			const indent = " ".repeat(visibleWidth(prefix));
			// Other 空着时用占位文案顶上（上游的 input 项也是这么表达的），采用后换成正文。
			const placeholder = question.multiSelect ? "Type something" : "Type something.";
			const raw = other ? state.other : question.options[index]!.description;
			const description = raw === undefined ? undefined : this.#clean(raw);
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
	#window(items: string[][], focusItem: number, height: number, width: number, maxItems = VISIBLE_ITEMS): { start: number; rows: string[] } {
		// 单项自己也超高的（比如一条很长的描述）按可用高度剪掉并标注，不能让一个选项把卡片撑破。
		const weigh = (bucket: string[]) => Math.min(bucket.length, height);
		const budgetOf = (from: number, to: number) => items.slice(from, to).reduce((sum, bucket) => sum + weigh(bucket), 0);

		let start = Math.max(0, Math.min(this.#listScroll, Math.max(0, items.length - 1)));
		if (focusItem < start) start = focusItem;
		let end = start;
		while (end < items.length && end - start < maxItems && (end === start || budgetOf(start, end + 1) <= height)) end += 1;
		if (focusItem >= end) {
			// 焦点跑到窗口外：以它为新锚点，先往后长，再把前面能塞下的补回来——只留焦点那一项会让人失去上下文。
			start = focusItem;
			end = focusItem + 1;
			while (end < items.length && end - start < maxItems && budgetOf(start, end + 1) <= height) end += 1;
			while (start > 0 && end - start < maxItems && budgetOf(start - 1, end) <= height) start -= 1;
		}
		this.#listScroll = start;

		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const bucket = items[i]!;
			if (bucket.length <= height) {
				rows.push(...bucket);
				continue;
			}
			// 只剩一行预算时保住内容第一行（选项的标签本身永远不该被剪没），放不下标注就不放。
			if (height <= 1) {
				rows.push(bucket[0]!);
				continue;
			}
			const keep = height - 1;
			rows.push(...bucket.slice(0, keep), this.#marker(width, bucket.length - keep));
		}
		return { start, rows };
	}

	/** 剪裁标注：窄终端下也要截断到可用宽度，它自己不能溢出。 */
	#marker(width: number, hidden: number): string {
		return this.#theme.fg("warning", this.#ellipsize(hiddenMarker(hidden), width));
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
		const clean = preview === undefined ? undefined : this.#clean(preview);
		const body = clean === undefined
			? [ifEmpty]
			: clean.length > MAX_PREVIEW_CHARS
				? this.#wrap(theme.fg("muted", "（预览过长，无法完整显示——请直接比较各选项的标签与描述）"), Math.max(1, width - 4))
				: this.#wrap(clean, Math.max(1, width - 4));

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
			const header = `${mark} ${i + 1}. ${this.#clean(question.header) || question.id}`;
			rows.push(...this.#wrap(done ? theme.fg("text", header) : theme.fg("warning", header), width));
			const answer = [...state.chosen].map((index) => this.#clean(question.options[index]!.label));
			if (state.other) answer.push(this.#clean(state.other));
			rows.push(...this.#wrap(done ? answer.join(", ") : "未回答", width, "  "));
			if (state.notes.trim()) rows.push(...this.#wrap(theme.fg("muted", `备注：${this.#clean(state.notes.trim())}`), width, "  "));
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
		const capped = clip(this.#wrap(`${theme.fg("muted", "备注：")}${this.#clean(notes)}`, width), 3);
		return capped.hidden > 0 ? [...capped.lines, this.#marker(width, capped.hidden)] : capped.lines;
	}

	#footer(width: number): string[] {
		const theme = this.#theme;
		let text: string;
		if (this.#editor) {
			text = this.#editing === "notes"
				? `${this.#key("tui.input.submit")} 采用  Esc 返回  ${this.#allKeys("tui.input.newLine")} 换行`
				: `${this.#key("tui.input.submit")} 确认  Esc 返回  ${this.#allKeys("tui.input.newLine")} 换行`;
		} else if (this.#isSubmit()) {
			text = `${this.#key("tui.select.confirm")} 提交 · ${this.#scrollKeys()} 翻看 · ${this.#key("tui.input.tab")} 返回 · ${this.#key("tui.select.cancel")} 取消`;
		} else {
			const nav = this.#questions.length > 1 ? `${this.#key("tui.input.tab")}/${this.#scrollKeys()} 导航` : `${this.#scrollKeys()} 导航`;
			text = `${this.#key("tui.select.confirm")} 选择 · ${nav}${this.#positionHint()} · n 备注 · ${this.#key("tui.select.cancel")} 取消`;
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
		const questionBody = this.#wrap(theme.fg("text", this.#isSubmit() ? "核对答案" : this.#clean(this.#question().question)), width);
		const question = clip(questionBody, questionCap);
		const questionLines = [...question.lines];
		if (question.hidden > 0) questionLines.push(this.#marker(width, question.hidden));

		const contentHeight = Math.max(1, bodyBudget - questionLines.length);
		const split = !this.#isSubmit() && !this.#question().multiSelect && this.#question().options.some((option) => option.preview !== undefined) && width >= SPLIT_MIN_COLUMNS;

		let content: string[];
		if (split) {
			const leftWidth = OPTION_COLUMN_WIDTH;
			const rightWidth = Math.max(1, width - leftWidth - COLUMN_GAP);
			const items = this.#optionItems(leftWidth);
			const focused = this.#state().cursor;
			// 左栏放不下就按项滚动，跟随焦点；右栏超限交给面板自己剪并标注。
			const left = this.#window(items, focused, contentHeight, leftWidth).rows;
			const preview = this.#isChat() ? undefined : this.#question().options[focused]?.preview;
			const right = this.#previewPanel(preview, rightWidth, contentHeight);
			content = [];
			for (let i = 0; i < contentHeight; i++) {
				const cell = left[i] ?? "";
				const pad = " ".repeat(Math.max(0, leftWidth - visibleWidth(cell)));
				content.push(`${cell}${pad}${" ".repeat(COLUMN_GAP)}${right[i] ?? ""}`);
			}
		} else {
			if (this.#isSubmit()) {
				// 提交屏按行滚动（不受「最多 5 项」的列表窗口约束）：放不下时末行换成标注，
				// 缺项不能静默消失，↑↓ 可以往下翻。
				const all = this.#submitRows(width);
				const capacity = Math.max(1, contentHeight);
				const maxStart = Math.max(0, all.length - capacity);
				this.#listScroll = Math.max(0, Math.min(this.#listScroll, maxStart));
				const visible = all.slice(this.#listScroll, this.#listScroll + capacity);
				const below = all.length - this.#listScroll - visible.length;
				content = below > 0 && visible.length > 1 ? [...visible.slice(0, -1), this.#marker(width, below)] : visible;
			} else {
				const items = this.#optionItems(width);
				const preview = !this.#question().multiSelect ? this.#question().options[this.#state().cursor]?.preview : undefined;
				const panel = preview !== undefined ? this.#previewPanel(preview, width, Math.max(3, Math.min(contentHeight, 6))) : [];
				const listHeight = Math.max(1, contentHeight - panel.length);
				const list = this.#window(items, this.#state().cursor, listHeight, width).rows.slice(0, listHeight);
				content = [...list, ...panel];
			}
		}

		// 内容区按预算预留了高度，两栏都短时会留一圈空白——卡片高度要跟内容走，不是跟预算走。
		while (content.length > 0 && stripTerminalSequences(content.at(-1)!).trim() === "") content.pop();
		const blank = content.length > 0 ? [""] : [];
		const out = [...tabBar, ...questionLines, ...blank, ...content, ...notes, ...footer];
		// 极小终端下各段的 `max(1, …)` 下限加起来可能超过上限：先丢备注，再硬压到上限，
		// 保证「卡片总高 ≤ 终端行数 − 4」在任何尺寸下都成立。
		if (out.length > limit) {
			const trimmed = [...tabBar, ...questionLines, ...blank, ...content, ...footer];
			return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
		}
		return out;
	}
}
