import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Editor, getKeybindings, Key, matchesKey, ScrollView,
	stripTerminalSequences, visibleWidth, wrapTextWithAnsi,
	type Component, type EditorTheme, type Focusable, type Keybinding, type KeybindingsManager, type TUI,
} from "@earendil-works/pi-tui";
import type { Pick, QuestionSpec } from "./question-card.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
	other?: string;
	draft: string;
	confirmed: boolean;
	cursor: number;
}

/** One bounded component works in both regular and fullscreen custom() slots. */
export class QuestionCard implements Component, Focusable {
	readonly #questions: QuestionSpec[];
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keys: KeybindingsManager;
	readonly #done: (picks: Pick[] | undefined) => void;
	readonly #states: QuestionState[];
	readonly #scroll: ScrollView;
	readonly #scrollPositions: number[];
	readonly #signal?: AbortSignal;
	readonly #onAbort = () => this.#finish(undefined);
	#focused = false;
	#index = 0;
	#editor?: FullTextEditor;
	#body: string[] = [];
	#viewportHeight = 1;
	#restoreScroll = true;
	#followFocus = false;
	#closed = false;
	#error = "";

	constructor(questions: QuestionSpec[], tui: TUI, theme: Theme, keys: KeybindingsManager, done: (picks: Pick[] | undefined) => void, signal?: AbortSignal) {
		this.#questions = questions;
		this.#tui = tui;
		this.#theme = theme;
		this.#keys = keys ?? getKeybindings();
		this.#done = done;
		this.#signal = signal;
		this.#states = questions.map(() => ({ chosen: new Set<number>(), draft: "", confirmed: false, cursor: 0 }));
		this.#scrollPositions = Array.from({ length: questions.length + 1 }, () => 0);
		this.#scroll = new ScrollView({ render: () => this.#body, invalidate() {} }, { overscroll: "contain" });
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
	#isReview(): boolean { return this.#index === this.#questions.length; }
	#isOther(): boolean { return this.#state().cursor === this.#question().options.length; }
	#matches(data: string, action: Keybinding): boolean { return this.#keys.matches(data, action); }
	#valid(state: QuestionState): boolean { return state.chosen.size > 0 || Boolean(state.other?.trim()); }

	#picks(): Pick[] {
		return this.#questions.map((question, i) => {
			const state = this.#states[i]!;
			const selected = [...state.chosen].map((index) => question.options[index]!.label);
			const preview = [...state.chosen].map((index) => question.options[index]!.preview).find((value) => value !== undefined);
			return { id: question.id, selected, ...(state.other ? { other: state.other } : {}), ...(preview !== undefined ? { preview } : {}) };
		});
	}

	#finish(picks: Pick[] | undefined): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.focused = false;
		this.#editor = undefined;
		for (const state of this.#states) {
			state.draft = "";
			state.other = undefined;
			state.chosen.clear();
		}
		this.#done(picks);
	}

	dispose(): void { this.#finish(undefined); }

	#switchPage(index: number): void {
		this.#scrollPositions[this.#index] = this.#scroll.scrollTop;
		this.#index = index;
		this.#restoreScroll = true;
		this.#followFocus = false;
		this.#error = "";
	}

	#confirmQuestion(): void {
		if (!this.#valid(this.#state())) {
			this.#error = "请选择一项或填写 Other。";
			return;
		}
		this.#state().confirmed = true;
		if (this.#questions.length === 1) this.#finish(this.#picks());
		else this.#switchPage(this.#index + 1);
	}

	#submit(): void {
		const missing = this.#states.findIndex((state) => !state.confirmed || !this.#valid(state));
		if (missing >= 0) {
			this.#switchPage(missing);
			this.#error = "请先选择并确认本题。";
			return;
		}
		this.#finish(this.#picks());
	}

	#editOther(): void {
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
		const editor = new FullTextEditor(this.#tui, theme);
		editor.setText(this.#state().draft);
		editor.focused = this.focused;
		editor.onSubmit = (value) => {
			if (!value.trim()) {
				editor.setText(this.#state().draft);
				this.#error = "请输入非空答案。";
				return;
			}
			const state = this.#state();
			state.draft = value;
			state.other = value.trim();
			if (!this.#question().multiSelect) state.chosen.clear();
			this.#editor = undefined;
			this.#error = "";
			this.#confirmQuestion();
		};
		this.#editor = editor;
	}

	/** Fullscreen Pi otherwise routes these keys to the transcript before the focused card. */
	handleReservedInput(data: string): boolean {
		if (this.#closed) return false;
		const actions: Keybinding[] = this.#editor
			? ["tui.select.pageUp", "tui.select.pageDown", "tui.editor.pageUp", "tui.editor.pageDown"]
			: ["tui.select.pageUp", "tui.select.pageDown"];
		if (!actions.some((action) => this.#matches(data, action))) return false;
		this.handleInput(data);
		return true;
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (this.#editor) {
			const editor = this.#editor;
			if (!editor.isPasting && matchesKey(data, Key.escape)) {
				this.#state().draft = editor.getExpandedText();
				editor.focused = false;
				this.#editor = undefined;
				this.#error = "";
				this.#followFocus = true;
			} else {
				editor.handleInput(data);
				if (this.#editor === editor && !this.#closed) this.#state().draft = editor.getExpandedText();
			}
			this.#refresh();
			return;
		}
		if (this.#matches(data, "tui.select.cancel")) {
			this.#finish(undefined);
			return;
		}
		if (this.#questions.length > 1 && (this.#matches(data, "tui.input.tab") || matchesKey(data, Key.shift("tab")))) {
			const count = this.#questions.length + 1;
			this.#switchPage((this.#index + (matchesKey(data, Key.shift("tab")) ? count - 1 : 1)) % count);
		} else if (this.#matches(data, "tui.select.pageUp") || this.#matches(data, "tui.select.pageDown")) {
			const direction = this.#matches(data, "tui.select.pageUp") ? -1 : 1;
			this.#scroll.scrollBy(direction * Math.max(1, this.#viewportHeight - 1));
			this.#scrollPositions[this.#index] = this.#scroll.scrollTop;
			this.#followFocus = false;
		} else if (this.#isReview()) {
			if (this.#matches(data, "tui.select.confirm")) this.#submit();
		} else if (this.#matches(data, "tui.select.up") || this.#matches(data, "tui.select.down")) {
			const state = this.#state();
			const count = this.#question().options.length + 1;
			state.cursor = (state.cursor + (this.#matches(data, "tui.select.up") ? count - 1 : 1)) % count;
			this.#followFocus = true;
		} else if (matchesKey(data, Key.space)) {
			const state = this.#state();
			state.confirmed = false;
			this.#error = "";
			if (this.#isOther()) {
				if (this.#question().multiSelect && state.other) state.other = undefined;
				else this.#editOther();
			} else if (this.#question().multiSelect) {
				if (state.chosen.has(state.cursor)) state.chosen.delete(state.cursor);
				else state.chosen.add(state.cursor);
			} else {
				state.chosen = new Set([state.cursor]);
				state.other = undefined;
			}
			this.#followFocus = true;
		} else if (this.#matches(data, "tui.select.confirm")) {
			if (this.#isOther()) this.#editOther();
			else {
				if (!this.#question().multiSelect) {
					this.#state().chosen = new Set([this.#state().cursor]);
					this.#state().other = undefined;
				}
				this.#confirmQuestion();
			}
		}
		this.#refresh();
	}

	invalidate(): void { this.#editor?.invalidate(); }

	#wrap(text: string, width: number, prefix = ""): string[] {
		const indent = visibleWidth(prefix);
		if (indent >= width) return wrapTextWithAnsi(prefix + text, width);
		return wrapTextWithAnsi(text, width - indent).map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`);
	}

	#key(action: Keybinding): string {
		return (this.#keys.getKeys(action)[0] ?? "-").replace("pageUp", "PgUp").replace("pageDown", "PgDn").replace("escape", "Esc").replace("enter", "Enter").replace("tab", "Tab");
	}

	#footer(width: number): string[] {
		const text = this.#editor
			? `${this.#key("tui.input.submit")} 确认  Esc 返回  Ctrl+J 换行`
			: this.#isReview()
				? `${this.#key("tui.select.confirm")} 提交  ${this.#key("tui.input.tab")} 返回  ${this.#key("tui.select.cancel")} 取消`
				: `Space 选择  ${this.#key("tui.select.confirm")} 确认  ${this.#key("tui.select.cancel")} 取消`;
		const lines = this.#wrap(this.#theme.fg("dim", text), width);
		if (!this.#editor) {
			const position = this.#body.length ? ` ${this.#scroll.scrollTop + 1}/${this.#body.length}` : "";
			const navigation = `${this.#key("tui.select.pageUp")}/${this.#key("tui.select.pageDown")} 翻页${position}${this.#questions.length > 1 && !this.#isReview() ? `  ${this.#key("tui.input.tab")} 切题` : ""}`;
			lines.push(...this.#wrap(this.#theme.fg("dim", navigation), width));
		}
		if (this.#error) lines.unshift(...this.#wrap(this.#theme.fg("error", this.#error), width));
		return lines;
	}

	#renderBody(width: number): { lines: string[]; focusRow: number } {
		const lines: string[] = [];
		let focusRow = 0;
		if (this.#isReview()) {
			for (const [i, question] of this.#questions.entries()) {
				const state = this.#states[i]!;
				const confirmed = state.confirmed && this.#valid(state);
				lines.push(...this.#wrap(this.#theme.fg(confirmed ? "success" : "warning", `${confirmed ? "[x]" : "[ ]"} ${i + 1}. ${question.header || question.id}${confirmed ? "" : "（待确认）"}`), width));
				const answer = [...state.chosen].map((index) => question.options[index]!.label);
				if (state.other) answer.push(state.other);
				lines.push(...this.#wrap(answer.join(", ") || "未回答", width, "  "), "");
			}
			return { lines, focusRow };
		}
		const question = this.#question();
		const state = this.#state();
		lines.push(...this.#wrap(this.#theme.fg("text", question.question), width), "");
		for (let index = 0; index <= question.options.length; index++) {
			const other = index === question.options.length;
			const option = question.options[index];
			const selected = other ? Boolean(state.other) : state.chosen.has(index);
			const focused = state.cursor === index;
			if (focused) focusRow = lines.length;
			const mark = question.multiSelect ? (selected ? "[x]" : "[ ]") : (selected ? "(*)" : "( )");
			const pointer = focused ? this.#theme.fg("accent", ">") : " ";
			const label = other ? `Other（自定义）${!state.other && state.draft ? " · 草稿" : ""}` : option!.label;
			const title = selected ? this.#theme.fg("success", this.#theme.bold(label)) : this.#theme.fg("text", label);
			const prefix = `${pointer} ${this.#theme.fg(selected ? "success" : "muted", mark)} `;
			lines.push(...this.#wrap(title, width, prefix));
			const description = other ? state.other : option!.description;
			if (description) lines.push(...this.#wrap(this.#theme.fg(selected ? "success" : "muted", description), width, "      "));
			lines.push("");
		}
		const preview = question.options[state.cursor]?.preview;
		if (preview) {
			lines.push(this.#theme.fg("borderMuted", "─".repeat(width)), this.#theme.fg("dim", "预览"));
			lines.push(...this.#wrap(preview, width));
		}
		return { lines, focusRow };
	}

	render(width: number): string[] {
		if (this.#closed) return [];
		width = Math.max(1, width);
		const title = this.#isReview()
			? `核对答案 ${this.#states.filter((state) => state.confirmed && this.#valid(state)).length}/${this.#questions.length}`
			: `[${this.#index + 1}/${this.#questions.length}] ${this.#question().header}  ${this.#editor ? "Other" : this.#question().multiSelect ? "多选" : "单选"}`;
		const header = this.#wrap(this.#theme.fg("accent", this.#theme.bold(title)), width);
		const bodyLayout = this.#editor ? undefined : this.#renderBody(width);
		if (bodyLayout) this.#body = bodyLayout.lines;
		const footer = this.#footer(width);
		// Pi's editor slot shares the screen with its status and footer rows.
		const available = Math.max(3, this.#tui.terminal.rows - 4 - header.length - footer.length);
		if (this.#editor) {
			const rendered = this.#editor.render(width);
			const content = rendered.slice(1, -1);
			const cursor = Math.max(0, content.findIndex((line) => line.includes(CURSOR_MARKER)));
			const height = Math.max(1, available - 2);
			const start = Math.max(0, Math.min(cursor - height + 1, content.length - height));
			return [...header, rendered[0]!, ...content.slice(start, start + height), rendered.at(-1)!, ...footer];
		}
		const { lines, focusRow } = bodyLayout!;
		this.#viewportHeight = available;
		this.#scroll.updateLayout(lines.length, available, () => this.#refresh());
		if (this.#restoreScroll) {
			this.#scroll.scrollTo(this.#scrollPositions[this.#index] ?? 0);
			this.#restoreScroll = false;
		}
		if (this.#followFocus) {
			if (focusRow < this.#scroll.scrollTop) this.#scroll.scrollTo(focusRow);
			else if (focusRow >= this.#scroll.scrollTop + available) this.#scroll.scrollTo(focusRow - available + 1);
			this.#followFocus = false;
		}
		this.#scrollPositions[this.#index] = this.#scroll.scrollTop;
		const body = this.#scroll.render(width).slice(this.#scroll.scrollTop, this.#scroll.scrollTop + available);
		return [...header, ...body, ...this.#footer(width)];
	}
}
