import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, getKeybindings, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
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
	let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let released = false;
	let palette = "32";
	const theme = {
		fg: (color: string, text: string) => `\x1b[${color === "success" ? palette : color === "accent" ? "36" : color === "error" ? "31" : "37"}m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const terminal = { rows, columns: 80 };
	const tui = { terminal, requestRender() {} } as TUI;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { onTerminalInput(handler: typeof listener) {
			listener = handler;
			return () => { listener = undefined; released = true; };
		}, custom(factory: (tui: TUI, theme: Theme, kb: typeof keybindings, done: (value: undefined) => void) => typeof component) {
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
	return { input, render, plain, result, controller, component, tui, terminal, rawInput: (data: string) => listener?.(data), released: () => released, settled: () => settled, changeTheme() { palette = "92"; component.invalidate(); } };
}

function readPages(card: ReturnType<typeof harness>, width = 80, direction = PAGE_DOWN): string {
	const frames: string[] = [];
	for (let i = 0; i < 250; i++) {
		const frame = card.plain(width);
		if (frames.at(-1) === frame) break;
		frames.push(frame);
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

test("切换题目恢复各自焦点与阅读位置", (t) => {
	const card = harness(t, [question({ question: "first\n".repeat(30) }), question({ id: "q2" })], 12);
	card.render(40);
	card.input(PAGE_DOWN);
	const first = card.plain(40);
	card.input("\t");
	card.render(40);
	card.input(BACK_TAB);
	assert.equal(card.plain(40), first);
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
	assert.equal(card.released(), true);
	const next = harness(t);
	next.input(ENTER);
	assert.deepEqual(await next.result, { kind: "answered", answers: { q: "A" } });
});

test("全屏原始输入监听接管翻页键，关闭后释放，不接管普通键", async (t) => {
	const card = harness(t, [question({ question: "long question\n".repeat(40) })], 12);
	const initial = card.plain(40);
	assert.deepEqual(card.rawInput(PAGE_DOWN), { consume: true });
	assert.notEqual(card.plain(40), initial);
	assert.equal(card.rawInput(DOWN), undefined);
	card.input(DOWN, DOWN, ENTER, `\x1b[200~${Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n")}\x1b[201~`);
	const edited = card.plain(40);
	assert.deepEqual(card.rawInput(PAGE_UP), { consume: true });
	assert.notEqual(card.plain(40), edited);
	card.input(ESC, ESC);
	assert.deepEqual(await card.result, { kind: "cancelled" });
	assert.equal(card.released(), true);
	assert.equal(card.rawInput(PAGE_DOWN), undefined);
});

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
