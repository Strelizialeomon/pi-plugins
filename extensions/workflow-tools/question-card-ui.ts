import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Editor, getKeybindings, getNativeClipboard, Key, matchesKey, stripTerminalSequences, visibleWidth, wrapTextWithAnsi,
	type Component, type EditorTheme, type Focusable, type Keybinding, type KeybindingsManager, type TUI,
} from "@earendil-works/pi-tui";
import { paddedForCursor, pasteFromClipboard, type PasteDeps } from "./clipboard-paste.ts";
import type { CardOutcome, Pick, QuestionSpec } from "./question-card.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** 列表可见项上限（对齐上游默认值 5）。 */
export const VISIBLE_ITEMS = 5;
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

/** One bounded component works in both regular and fullscreen custom() slots. */
export class QuestionCard implements Component, Focusable {
	readonly #questions: QuestionSpec[];
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keys: KeybindingsManager;
	readonly #glyphs: Glyphs;
	readonly #pasteDeps: PasteDeps;
	readonly #done: (outcome: CardOutcome | undefined) => void;
	readonly #states: QuestionState[];
	readonly #signal?: AbortSignal;
	readonly #onAbort = () => this.#finish(undefined);
	#focused = false;
	/** 当前屏：0..n-1 是题目，n 是提交屏。 */
	#index = 0;
	/** 备注用的模态编辑器（按 n 打开）。 */
	#editor?: FullTextEditor;
	/** Other 行的行内编辑器：焦点落在 Other 上时存在，走开就写回草稿并丢弃。 */
	#otherEd?: FullTextEditor;
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
		pasteDeps: PasteDeps = { reader: getNativeClipboard() },
	) {
		this.#questions = questions;
		this.#tui = tui;
		this.#theme = theme;
		this.#keys = keys ?? getKeybindings();
		this.#glyphs = glyphs;
		this.#pasteDeps = pasteDeps;
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
		if (this.#otherEd) this.#otherEd.focused = value;
	}

	#refresh(): void { this.#tui.requestRender(); }
	#question(): QuestionSpec { return this.#questions[this.#index]!; }
	#state(): QuestionState { return this.#states[this.#index]!; }
	#isSubmit(): boolean { return this.#index === this.#questions.length; }
	/** 列表项：0..options-1 是普通项，最后一项是 Other。提交屏没有当前题，恒为 false。 */
	#isOther(): boolean { return !this.#isSubmit() && this.#state().cursor === this.#question().options.length; }
	#itemCount(): number { return this.#question().options.length + 1; }
	#matches(data: string, action: Keybinding): boolean { return this.#keys.matches(data, action); }
	#valid(state: QuestionState): boolean { return state.chosen.size > 0 || Boolean(state.other?.trim()); }
	/** 单题且单选时才提供 Chat；多选没有这条出口。 */
	#hasChat(): boolean { return !this.#isSubmit() && !this.#question().multiSelect; }

	#picks(): Pick[] {
		return this.#questions.map((question, i) => {
			const state = this.#states[i]!;
			const selected = [...state.chosen].map((index) => question.options[index]!.label);
			const notes = state.notes.trim();
			return {
				id: question.id,
				selected,
				...(state.other ? { other: state.other } : {}),
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
		this.#otherEd = undefined;
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
		this.#dropOtherEditor();
		this.#index = index;
		this.#error = "";
		this.#editor = undefined;
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
		if (this.#question().multiSelect) {
			if (state.chosen.has(state.cursor)) state.chosen.delete(state.cursor);
			else state.chosen.add(state.cursor);
		} else {
			state.chosen = new Set([state.cursor]);
			state.other = undefined;
		}
	}

	#editorTheme(): EditorTheme {
		return {
			borderColor: (text) => this.#theme.fg("borderAccent", text),
			selectList: {
				selectedPrefix: (text) => this.#theme.fg("accent", text),
				selectedText: (text) => this.#theme.fg("accent", text),
				description: (text) => this.#theme.fg("muted", text),
				scrollInfo: (text) => this.#theme.fg("dim", text),
				noMatch: (text) => this.#theme.fg("warning", text),
			},
		};
	}

	/** 备注编辑器是模态的：按 n 打开，Enter 采用，Esc 退回。 */
	#editNotes(): FullTextEditor {
		const state = this.#state();
		const editor = new FullTextEditor(this.#tui, this.#editorTheme());
		editor.setText(state.notes);
		editor.focused = this.focused;
		editor.onSubmit = (value) => {
			state.notes = value;
			this.#editor = undefined;
			this.#error = "";
			this.#refresh();
		};
		this.#editor = editor;
		return editor;
	}

	#leaveNotes(): void {
		const state = this.#state();
		const editor = this.#editor;
		if (!editor) return;
		state.notes = editor.getExpandedText();
		editor.focused = false;
		this.#editor = undefined;
		this.#error = "";
	}

	/**
	 * Other 行的行内编辑器：它复用 Pi 的编辑器做输入解码与编辑
	 * （kitty CSI-u / modifyOtherKeys 这些终端编码、粘贴、IME、字素安全都靠它），
	 * 渲染时只取它的内容行、不画边框，文字直接接在 `Other: ` 后面。
	 */
	#otherEditor(): FullTextEditor {
		if (!this.#otherEd) {
			const editor = new FullTextEditor(this.#tui, this.#editorTheme());
			editor.setText(this.#state().draft);
			editor.focused = this.#focused;
			// 宿主若把确认键改绑走了，Enter 会落到编辑器里触发提交——pi 的 submitValue
			// 先清空正文再回调，所以这里必须把内容放回去，否则输入被静默吃掉。
			editor.onSubmit = (value) => {
				editor.setText(value);
				this.#state().draft = value;
				this.#refresh();
			};
			this.#otherEd = editor;
		}
		return this.#otherEd;
	}

	/** 把行内编辑器的内容写回草稿并丢弃它（离开 Other 行时调用）。 */
	#dropOtherEditor(): void {
		if (!this.#otherEd) return;
		this.#state().draft = this.#otherEd.getExpandedText();
		this.#otherEd.focused = false;
		this.#otherEd = undefined;
	}

	/** Enter 落在 Other 行上：采用正文并确认本题；空输入报错停下。 */
	#adoptOther(): void {
		const state = this.#state();
		const value = (this.#otherEd?.getExpandedText() ?? state.draft).trim();
		if (!value) {
			state.other = undefined;
			// 空输入没有可采用的正文：本题已有别的有效选择（多选）就当「确认已有选择」，
			// 否则报错停下——不能让一段屏幕上已经看不见的旧正文留在答案里。
			if (this.#valid(state)) {
				this.#advance();
				return;
			}
			this.#error = "请输入非空答案。";
			this.#refresh();
			return;
		}
		// 把裁掉边缘空白的正文也写回编辑器，免得随后 #dropOtherEditor 用未 trim 的原文覆盖草稿。
		this.#otherEd?.setText(value);
		state.draft = value;
		state.other = value;
		if (!this.#question().multiSelect) state.chosen.clear();
		this.#error = "";
		this.#advance();
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (this.#editor) {
			const editor = this.#editor;
			if (!editor.isPasting && matchesKey(data, Key.escape)) {
				this.#leaveNotes();
			} else {
				editor.handleInput(data);
				if (this.#editor === editor && !this.#closed) this.#state().notes = editor.getExpandedText();
			}
			this.#refresh();
			return;
		}

		// 焦点落在 Other 行：导航键归卡片，其余输入全交给行内编辑器。
		// 自己写「只认裸字符」的判断会漏掉终端的按键编码（kitty CSI-u / modifyOtherKeys），
		// 用户实测就是那样彻底打不进字——交给 Pi 的编辑器解码才认。
		if (!this.#isSubmit() && this.#isOther()) {
			// 粘贴键要排在「当正文输入」前面，否则 Ctrl+V 会被当成控制字符塞进正文。
			if (this.#matchesPasteKey(data)) {
				void this.#pasteFromClipboard();
				return;
			}
			const pasting = this.#otherEd?.isPasting === true;
			if (!pasting && this.#matches(data, "tui.select.cancel")) {
				this.#finish(undefined);
				return;
			}
			if (this.#matches(data, "tui.select.up") || this.#matches(data, "tui.select.down")) {
				const state = this.#state();
				const count = this.#itemCount() + (this.#hasChat() ? 1 : 0);
				state.cursor = (state.cursor + (this.#matches(data, "tui.select.up") ? count - 1 : 1)) % count;
				this.#dropOtherEditor();
				this.#refresh();
				return;
			}
			if (this.#questions.length > 1 && (this.#matches(data, "tui.input.tab") || matchesKey(data, Key.shift("tab")))) {
				const count = this.#questions.length + 1;
				this.#goto((this.#index + (matchesKey(data, Key.shift("tab")) ? count - 1 : 1)) % count);
				return;
			}
			if (this.#matches(data, "tui.select.confirm")) {
				this.#adoptOther();
				return;
			}
			const editor = this.#otherEditor();
			editor.handleInput(data);
			const draft = editor.getExpandedText();
			this.#state().draft = draft;
			// 多选下 Other 是可独立取消的补充项：把正文删空就是取消它（§7.2）。
			if (!draft.trim() && this.#state().other !== undefined) this.#state().other = undefined;
			this.#refresh();
			return;
		}
		this.#dropOtherEditor();

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
			this.#editNotes();
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
		}
		this.#refresh();
	}

	/**
	 * 宿主键位表里的粘贴键（`app.clipboard.pasteImage`，默认 Ctrl+V）。
	 * 它不属于 pi-tui 的 `tui.*` 那套，类型上只能按名字匹配；
	 * 只在焦点位于 Other 行时拦——别的位置维持现状，不动宿主的语义。
	 */
	#matchesPasteKey(data: string): boolean {
		return this.#keys.matches(data, "app.clipboard.pasteImage" as Keybinding);
	}

	/** 从剪贴板取一次内容插进行内编辑器（文件路径 / 图片落盘后的路径 / 文本）。 */
	async #pasteFromClipboard(): Promise<void> {
		const outcome = await pasteFromClipboard(this.#pasteDeps);
		if (this.#closed || outcome.kind === "none") return;
		if (outcome.kind === "error") {
			this.#error = outcome.message;
			this.#refresh();
			return;
		}
		const editor = this.#otherEditor();
		const cursor = editor.getCursor();
		const line = editor.getText().split("\n")[cursor.line] ?? "";
		const before = cursor.col > 0 ? (line[cursor.col - 1] ?? "") : "";
		const after = line[cursor.col] ?? "";
		editor.insertTextAtCursor(paddedForCursor(outcome.text, before, after));
		const draft = editor.getExpandedText();
		this.#state().draft = draft;
		this.#error = "";
		this.#refresh();
	}

	/** 光标停在 Chat 行上（只有单选才有这一项，编号接在 Other 之后）。 */
	#isChat(): boolean { return this.#hasChat() && this.#state().cursor === this.#itemCount(); }

	invalidate(): void { this.#editor?.invalidate(); this.#otherEd?.invalidate(); }

	#wrap(text: string, width: number, prefix = ""): string[] {
		const indent = visibleWidth(prefix);
		if (indent >= width) return wrapTextWithAnsi(prefix + text, width);
		return wrapTextWithAnsi(text, width - indent).map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`);
	}

	/**
	 * 清洗外部原文（模型给的题目 / 标签 / 描述，用户敲的 Other 与备注）：
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
	#optionItems(width: number, editorRows: number = VISIBLE_ITEMS): string[][] {
		const question = this.#question();
		const state = this.#state();
		const g = this.#glyphs;
		const theme = this.#theme;
		const items: string[][] = [];
		const indexWidth = String(this.#itemCount()).length + 1;

		for (let index = 0; index < this.#itemCount(); index++) {
			const bucket: string[] = [];
			items.push(bucket);
			const focused = state.cursor === index;
			const pointer = focused ? theme.fg("accent", g.pointer) : " ";
			const number = theme.fg("dim", `${index + 1}.`.padEnd(indexWidth));
			const prefix = `${pointer} ${number} `;

			if (index === question.options.length) {
				// Other 行本身就是输入框：文字直接接在 `Other: ` 后面，不弹边框编辑器。
				const head = "Other: ";
				const indent = visibleWidth(prefix) + visibleWidth(head);
				// 剩余宽度太窄就别上编辑器：pi 的折行遇到「字素比折行宽还宽」会自递归（RangeError），
				// 而 `Math.max(1, …)` 的保底会让每行溢出 1 列。退回纯文本渲染，至少不崩不溢出。
				if (focused && width - indent >= 4) {
					const all = this.#otherEditor().render(width - indent).slice(1, -1);
					// 长输入只显示光标附近的一段：把光标钉在窗口里，别让它跑出屏幕。
					const budget = Math.max(1, Math.min(editorRows, VISIBLE_ITEMS));
					const at = Math.max(0, all.findIndex((line) => line.includes(CURSOR_MARKER)));
					const start = Math.max(0, Math.min(at - budget + 1, all.length - budget));
					const lines = all.slice(start, start + budget);
					bucket.push(prefix + head + (lines[0] ?? ""), ...lines.slice(1).map((line) => " ".repeat(indent) + line));
				} else {
					const placeholder = question.multiSelect ? "Type something" : "Type something.";
					const adopted = Boolean(state.other);
					const body = state.draft ? theme.fg(adopted ? "success" : "text", this.#clean(state.draft)) : theme.fg("dim", placeholder);
					bucket.push(...this.#wrap(`${head}${body}`, width, prefix));
				}
				continue;
			}

			const selected = state.chosen.has(index);
			const mark = question.multiSelect ? `${selected ? theme.fg("success", g.boxOn) : g.boxOff} ` : "";
			const label = this.#clean(question.options[index]!.label);
			const title = selected ? theme.fg("success", theme.bold(label)) : focused ? theme.fg("accent", label) : theme.fg("text", label);
			const tick = !question.multiSelect && selected ? ` ${theme.fg("success", g.tick)}` : "";
			const full = `${prefix}${mark}`;
			bucket.push(...this.#wrap(`${title}${tick}`, width, full));
			const indent = " ".repeat(visibleWidth(full));
			const description = this.#clean(question.options[index]!.description);
			if (description) bucket.push(...this.#wrap(theme.fg(selected ? "success" : "muted", description), width, indent));
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
			text = `${this.#key("tui.input.submit")} 采用 · Esc 返回 · ${this.#allKeys("tui.input.newLine")} 换行`;
		} else if (this.#isOther()) {
			text = `${this.#key("tui.select.confirm")} 采用 · 直接打字 · ${this.#scrollKeys()} 离开 · ${this.#key("tui.select.cancel")} 取消`;
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
			const head = this.#wrap(theme.fg("accent", theme.bold(`[${this.#index + 1}/${this.#questions.length}] 备注`)), width);
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

		let content: string[];
		{
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
				const items = this.#optionItems(width, contentHeight);
				content = this.#window(items, this.#state().cursor, contentHeight, width).rows.slice(0, contentHeight);
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
