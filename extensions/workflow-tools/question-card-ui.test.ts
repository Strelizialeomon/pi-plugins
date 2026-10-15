import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, stripTerminalSequences, TuiAltScreen, TuiMainScreen, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { askQuestions, type QuestionSpec } from "./question-card.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const BACK_TAB = "\x1b[Z";
const ESC = "\x1b";
const ENTER = "\r";

function question(over: Partial<QuestionSpec> = {}): QuestionSpec {
	return {
		id: "q", header: "选择", question: "请选择", multiSelect: false,
		options: [{ label: "A", description: "第一个" }, { label: "B", description: "第二个" }],
		...over,
	};
}

function harness(t: TestContext, questions = [question()], rows = 24, keybindings = getKeybindings()) {
	let component!: Component & { focused?: boolean; dispose?(): void };
	let done!: (value: undefined) => void;
	let settled = false;
	let palette = "32";
	const theme = {
		fg: (color: string, text: string) => `\x1b[${color === "success" ? palette : color === "accent" ? "36" : color === "error" ? "31" : "37"}m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const terminal = { rows, columns: 80 };
	const tui = { terminal, requestRender() {} } as TUI;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { custom(factory: (tui: TUI, theme: Theme, kb: typeof keybindings, done: (value: undefined) => void) => typeof component) {
			return new Promise<undefined>((resolve) => {
				done = resolve;
				component = factory(tui, theme, keybindings, resolve);
				component.focused = true;
			});
		} },
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	const result = askQuestions(ctx, questions, controller.signal).then((value) => { settled = true; return value; });
	t.after(async () => { done(undefined); component.dispose?.(); await result; });
	const input = (...data: string[]) => { for (const chunk of data) component.handleInput!(chunk); };
	const render = (width = 80) => component.render(width);
	const plain = (width = 80) => render(width).map(stripTerminalSequences).join("\n");
	return { input, render, plain, result, controller, component, tui, terminal, settled: () => settled, changeTheme() { palette = "92"; component.invalidate(); } };
}

function readPages(card: ReturnType<typeof harness>, width = 80, direction = PAGE_DOWN): string {
	const frames: string[] = [];
	for (let i = 0; i < 250; i++) {
		const frame = card.render(width);
		// 每一帧都要守住列宽，不能只查首屏那一帧
		for (const line of frame) assert.ok(visibleWidth(line) <= width, `${width} 列下溢出：${JSON.stringify(stripTerminalSequences(line))}`);
		const text = frame.map(stripTerminalSequences).join("\n");
		if (frames.at(-1) === text) break;
		frames.push(text);
		card.input(direction);
	}
	return frames.join("\n");
}

for (const width of [40, 80, 120]) {
	test(`全文与预览可翻页读到末尾：${width} 列`, (t) => {
		const card = harness(t, [question({
			question: `${"问题中文 English 😀 e\u0301 ".repeat(35)} QUESTION_END`,
			options: [
				{ label: "A", description: `${"说明文字 ".repeat(90)} DESCRIPTION_END`, preview: `${"预览 ".repeat(80)} PREVIEW_END` },
				{ label: "B", description: "第二项" },
			],
		})], 12);
		assert.match(card.plain(width), /问题中文/);
		for (const line of card.render(width)) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
		const full = readPages(card, width);
		for (const end of ["QUESTION_END", "DESCRIPTION_END", "PREVIEW_END"]) assert.ok(full.includes(end), end);
		card.input(DOWN);
		assert.match(card.plain(width), /> \( \) B/);
		card.input(ENTER);
	});
}

test("翻页、重绘、缩放不改选，阅读位置不会每帧跳回光标", async (t) => {
	const card = harness(t, [question({ question: "长问题\n".repeat(50), multiSelect: true })], 12);
	card.render(40);
	card.input(PAGE_DOWN);
	const page = card.plain(40);
	card.component.invalidate();
	assert.equal(card.plain(40), page);
	card.terminal.rows = 24;
	for (const line of card.render(80)) assert.ok(visibleWidth(line) <= 80);
	card.input(DOWN, " ", ENTER);
	assert.deepEqual((await card.result), { kind: "answered", answers: { q: "B" } });
});

test("单选有标记与成功色，移动光标不会改选，主题失效后重算颜色", (t) => {
	const card = harness(t);
	assert.match(card.plain(), /> \( \) A/);
	card.input(" ", DOWN);
	const selected = card.render().find((line) => stripTerminalSequences(line).includes("(*) A"))!;
	assert.ok(selected.includes("\x1b[32m") && selected.includes("\x1b[1m"));
	assert.match(card.plain(), /> \( \) B/);
	card.changeTheme();
	assert.ok(card.render().some((line) => line.includes("\x1b[92m")));
	assert.ok(!card.render().some((line) => line.includes("\x1b[32m")));
});

test("多选标记保持，Enter 不暗中选光标项", async (t) => {
	const card = harness(t, [question({ multiSelect: true })]);
	card.input(" ", DOWN);
	assert.match(card.plain(), /\[x\] A/);
	assert.match(card.plain(), /> \[ \] B/);
	card.input(ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "A" } });
});

for (const [name, chunks, expected] of [
	["普通整段", ["pasted text"], "pasted text"],
	["普通多行", ["第一行\n第二行 😀"], "第一行\n第二行 😀"],
	["带标记多行", ["\x1b[200~第一行\n第二行 😀\x1b[201~"], "第一行\n第二行 😀"],
	["分块多行", ["\x1b[200~第一", "行\n第", "二行 😀", "\x1b[201~"], "第一行\n第二行 😀"],
	["1100 字符", [`\x1b[200~${"x".repeat(1100)}\x1b[201~`], "x".repeat(1100)],
	["30 行", [`\x1b[200~${Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")}\x1b[201~`], Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")],
] as Array<[string, string[], string]>) {
	test(`Other 接收${name}粘贴并返回全文`, async (t) => {
		const card = harness(t);
		card.input(DOWN, DOWN, ENTER, ...chunks);
		assert.equal(card.settled(), false, "粘贴不能自动提交");
		assert.ok(!card.plain().includes("[paste #"));
		card.input(ENTER);
		assert.deepEqual(await card.result, { kind: "answered", answers: { q: expected }, responses: { q: expected } });
	});
}

test("长粘贴还原全文可编辑，原生撤销仍可撤回整个粘贴", async (t) => {
	const card = harness(t);
	card.input(DOWN, DOWN, ENTER, `\x1b[200~${"x".repeat(1100)}\x1b[201~`);
	card.input("\x1b[D", "\x7f", "z");
	card.input(ENTER);
	const result = await card.result;
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") assert.equal(result.responses?.q, `${"x".repeat(1098)}zx`);
});

test("编辑态撤销粘贴不产生粘贴标记残留", async (t) => {
	const card = harness(t);
	card.input(DOWN, DOWN, ENTER, "prefix", `\x1b[200~${"x".repeat(1100)}\x1b[201~`, "\x1b[45;5u", ENTER);
	const result = await card.result;
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") assert.equal(result.responses?.q, "prefix");
});

test("中文、emoji 和组合字符按完整字素删除", async (t) => {
	const card = harness(t);
	card.input(DOWN, DOWN, ENTER, "中文😀e\u0301", "\x7f", "\x7f", ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "中文" }, responses: { q: "中文" } });
});

test("窄矮屏编辑仍有可见光标，30 行输入可向前翻到开头", (t) => {
	const card = harness(t, [question()], 12);
	card.input(DOWN, DOWN, ENTER, `\x1b[200~${Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")}\x1b[201~`);
	const lines = card.render(40);
	assert.ok(lines.length <= 10);
	assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	assert.match(readPages(card, 40, PAGE_UP), /line-0/);
});

test("Other 草稿 Esc 后恢复，未采用的草稿不进入答案", async (t) => {
	const card = harness(t);
	card.input(DOWN, DOWN, ENTER, "draft", ESC, ENTER);
	assert.match(card.plain(), /draft/);
	card.input(ESC, UP, ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B" } });
});

test("单选采用 Other 清除普通项", async (t) => {
	const card = harness(t);
	card.input(" ", DOWN, DOWN, ENTER, "custom", ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "custom" }, responses: { q: "custom" } });
});

test("多题回看时，多选补充不会被普通勾选清空，可单独取消补充", async (t) => {
	const card = harness(t, [question({ multiSelect: true }), question({ id: "q2" })]);
	card.input(" ", DOWN, DOWN, ENTER, "custom", ENTER);
	card.input(BACK_TAB, UP, " ");
	assert.match(card.plain(), /custom/);
	card.input(DOWN, " ", UP, ENTER, ENTER, ENTER);
	const result = await card.result;
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") {
		assert.equal(result.answers.q, "A, B");
		assert.equal(result.responses, undefined);
	}
});

test("空多选与空 Other 不提交，只有 Other 的多选可以完成", async (t) => {
	const card = harness(t, [question({ multiSelect: true })]);
	card.input(ENTER);
	await Promise.resolve();
	assert.equal(card.settled(), false);
	assert.match(card.plain(), /请选择/);
	card.input(DOWN, DOWN, ENTER, "   ", ENTER);
	await Promise.resolve();
	assert.equal(card.settled(), false);
	card.input("text", ENTER);
	const result = await card.result;
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") assert.equal(result.responses?.q, "text");
});

test("4 题跳转、核对页与返回修改，未确认题不能整体提交", async (t) => {
	const card = harness(t, [question(), question({ id: "q2" }), question({ id: "q3" }), question({ id: "q4" })]);
	card.input(ENTER, "\t", ENTER, ENTER);
	assert.match(card.plain(), /核对/);
	await Promise.resolve();
	assert.equal(card.settled(), false);
	card.input(ENTER);
	assert.match(card.plain(), /\[2\/4\]/);
	card.input(DOWN, ENTER, ENTER, ENTER);
	assert.match(card.plain(), /核对/);
	card.input("\t", DOWN, ENTER, ENTER, ENTER, ENTER, ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B", q2: "B", q3: "A", q4: "A" } });
});

test("切换题目恢复各自的阅读位置（两题都翻过页）", (t) => {
	const card = harness(t, [question({ question: "first\n".repeat(60) }), question({ id: "q2", question: "second\n".repeat(60) })], 12);
	card.render(40);
	card.input(PAGE_DOWN, PAGE_DOWN);
	const firstFrame = card.plain(40);
	card.input("\t");
	card.render(40);
	card.input(PAGE_DOWN);
	const secondFrame = card.plain(40);
	card.input(BACK_TAB);
	assert.equal(card.plain(40), firstFrame, "返回时恢复该题自己的阅读位置");
	card.input("\t");
	assert.equal(card.plain(40), secondFrame);
});

test("注入的选择按键配置生效", async (t) => {
	const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "ctrl+s" });
	const card = harness(t, [question()], 24, kb);
	card.input("j", "\x13");
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B" } });
});

test("AbortSignal 取消卡片并释放活动锁，重复取消不影响后续调用", async (t) => {
	const card = harness(t);
	card.controller.abort();
	card.controller.abort();
	const result = await Promise.race([card.result, new Promise((resolve) => setTimeout(() => resolve("timeout"), 100))]);
	assert.deepEqual(result, { kind: "cancelled" });
	const next = harness(t);
	next.input(ENTER);
	assert.deepEqual(await next.result, { kind: "answered", answers: { q: "A" } });
});

const STUB_TERMINAL = {
	columns: 80, rows: 24, kittyProtocolActive: false,
	start() {}, stop() {}, async drainInput() {}, write() { return ""; },
	moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
};

/**
 * 按 Pi 的真实挂法走一遍：`ui.custom(factory, options)` 收到什么就照做什么。
 * 只测卡片自己处理按键是不够的——全屏下 Pi 会先把翻页键给对话区，挂法错了就永远收不到。
 */
function mountedCard(t: TestContext, TuiClass: typeof TuiAltScreen | typeof TuiMainScreen, questions: QuestionSpec[]) {
	const tui = new TuiClass(STUB_TERMINAL as never, false);
	let component!: Component & { dispose?(): void };
	let mountOptions: { overlay?: boolean; overlayOptions?: unknown } | undefined;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: {
			custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: undefined) => void) => typeof component, options?: typeof mountOptions) {
				mountOptions = options;
				return new Promise<undefined>((resolve) => {
					component = factory(tui as unknown as TUI, { fg: (_c: string, text: string) => text, bold: (text: string) => text } as Theme, getKeybindings(), resolve);
					if (options?.overlay) tui.showOverlay(component, options.overlayOptions as never);
					else { tui.addChild(component); tui.setFocus(component); }
				});
			},
		},
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	const result = askQuestions(ctx, questions, controller.signal);
	t.after(async () => { controller.abort(); await result; });
	return { tui, mountOptions: () => mountOptions, plain: () => component.render(40).map(stripTerminalSequences).join("\n") };
}

/** `handleTerminalInput` 在类型里是私有的，但正是 Pi 把终端按键送进来的那道门。 */
const sendTerminalKey = (tui: TuiAltScreen | TuiMainScreen, data: string) =>
	(tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);

for (const [name, TuiClass] of [["全屏", TuiAltScreen], ["常规", TuiMainScreen]] as const) {
	test(`${name}模式下翻页键真的到达卡片，来回翻位置准确`, async (t) => {
		const card = mountedCard(t, TuiClass, [question({ question: "long question\n".repeat(40) })]);
		assert.equal(card.mountOptions()?.overlay, true, "必须挂成浮层：挂编辑槽的普通组件在全屏下拿不到 PageUp/PageDown");
		const before = card.plain();
		sendTerminalKey(card.tui, PAGE_DOWN);
		const after = card.plain();
		assert.notEqual(after, before, "翻页键必须真的改变阅读位置");
		sendTerminalKey(card.tui, PAGE_UP);
		assert.equal(card.plain(), before);
	});
}

test("核对页取消不返回局部答案", async (t) => {
	const card = harness(t, [question(), question({ id: "q2" })]);
	card.input(ENTER, ENTER, ESC);
	assert.deepEqual(await card.result, { kind: "cancelled" });
});

test("粘贴中的控制字节不取消或提交卡片", async (t) => {
	const card = harness(t);
	card.input(DOWN, DOWN, ENTER, "\x1b[200~a", "\x1b", "\r\nb\x03", "\x1b[201~", ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "a\nb" }, responses: { q: "a\nb" } });
});

test("选择顺序与首个已选预览维持既有契约，焦点预览不混入答案", async (t) => {
	const card = harness(t, [question({ multiSelect: true, options: [
		{ label: "A", description: "", preview: "preview A" },
		{ label: "B", description: "", preview: "preview B" },
	] })]);
	card.input(DOWN, " ", UP, " ");
	assert.match(card.plain(), /preview A/);
	card.input(ENTER);
	assert.deepEqual(await card.result, { kind: "answered", answers: { q: "B, A" }, annotations: { q: { preview: "preview B" } } });
});

test("空格取消 Other 后重新编辑可恢复草稿", async (t) => {
	const card = harness(t, [question({ multiSelect: true }), question({ id: "q2" })]);
	card.input(DOWN, DOWN, ENTER, "draft", ENTER, BACK_TAB, " ", ENTER);
	assert.match(card.plain(), /draft/);
	card.input(ENTER, ENTER, ENTER);
	const result = await card.result;
	assert.equal(result.kind, "answered");
	if (result.kind === "answered") assert.equal(result.responses?.q, "draft");
});

test("焦点移到屏幕外的选项时自动滚进视口", (t) => {
	const card = harness(t, [question({
		question: "长题干\n".repeat(30),
		options: [{ label: "AAA", description: "" }, { label: "BBB", description: "" }, { label: "CCC", description: "" }],
	})], 12);
	assert.ok(!card.plain(40).includes("CCC"), "这三个选项一开始都在视口外");
	card.input(DOWN, DOWN);
	assert.match(card.plain(40), /> \( \) CCC/, "焦点移过去后该选项必须可见");
	card.input(UP, UP);
	assert.match(card.plain(40), /> \( \) AAA/);
});

test("选了但没确认的题不能整体提交", async (t) => {
	const card = harness(t, [question(), question({ id: "q2" })]);
	card.input(" ", "\t", " ", "\t");
	assert.match(card.plain(), /核对/);
	card.input(ENTER);
	await Promise.resolve();
	assert.equal(card.settled(), false, "未确认的题不能被整体提交");
	assert.match(card.plain(), /\[1\/2\]/);
	assert.match(card.plain(), /请先选择并确认/);
});

test("核对页能翻页读完长答案", async (t) => {
	const long = `${"补充说明 ".repeat(120)}ANSWER_END`;
	const card = harness(t, [question(), question({ id: "q2" })], 12);
	card.input(DOWN, DOWN, ENTER, `\x1b[200~${long}\x1b[201~`, ENTER, "\t");
	assert.match(card.plain(40), /核对/);
	assert.ok(readPages(card, 40).includes("ANSWER_END"), "核对页要能翻到长答案末尾");
});

test("缩窄并降低高度后重新排版，内容仍可达且不溢出", (t) => {
	const card = harness(t, [question({
		question: `${"问题 ".repeat(60)}TEXT_END`,
		options: [{ label: "A", description: `${"说明 ".repeat(60)}DESC_END` }],
	})], 24);
	card.render(80);
	card.terminal.rows = 12;
	assert.ok(readPages(card, 40).includes("DESC_END"));
	card.terminal.rows = 24;
	assert.ok(card.plain(80).includes("问题"));
	card.input(ENTER);
});

test("Other 行标为「Other（自定义）」", (t) => {
	const card = harness(t, [question()]);
	card.input(DOWN, DOWN);
	assert.ok(card.render(40).map(stripTerminalSequences).some((line) => line.includes("Other（自定义）")));
});

test("描述续行保持 6 空格缩进，不与勾选标记挤成一长行", (t) => {
	const card = harness(t, [question({
		options: [
			{ label: "A", description: `${"很长的说明文字 ".repeat(20)}DESC_TAIL` },
			{ label: "B", description: "短说明" },
		],
	})]);
	const lines = card.render(40).map(stripTerminalSequences);
	const start = lines.findIndex((line) => line.includes("很长的说明文字"));
	assert.ok(start >= 0, "描述首行必须渲染出来");
	assert.ok(lines[start]!.startsWith("      "), "描述首行缩进 6 空格");
	assert.ok(lines[start + 1]!.startsWith("      "), "描述续行保持同一缩进");
	assert.ok(lines[start + 1]!.trim().length > 0);
});

test("编辑态底栏的换行键跟随宿主键位配置", (t) => {
	const card = harness(t, [question()], 24, new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.newLine": "ctrl+j" }));
	card.input(DOWN, DOWN, ENTER);
	assert.match(card.plain(), /Ctrl\+J 换行/);
	assert.ok(!card.plain().includes("Shift+Enter"), "只绑了一个键就不该提示另一个");
});

test("默认键位下换行提示列出所有可用键", (t) => {
	const card = harness(t, [question()]);
	card.input(DOWN, DOWN, ENTER);
	assert.match(card.plain(), /Shift\+Enter\/Ctrl\+J 换行/);
});
