import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import extension, { loadState, saveState, syncBar, type RootLike } from "./index.ts";
import { probe, StickyBar } from "./sticky-bar.ts";

// ------------------------------------------------------------------ 假件

/** 造一个能过 `instanceof UserMessageComponent` 的假提问组件（原型对上即可）。 */
function fakePrompt(text: string, height: number): Component {
	const component = Object.create(UserMessageComponent.prototype) as Component & { text: string };
	component.text = text;
	component.render = () => new Array<string>(height).fill("提问");
	component.invalidate = () => {};
	return component;
}

function fakeBlock(height: number): Component {
	return {
		render: () => new Array<string>(height).fill("别的"),
		invalidate: () => {},
	};
}

interface FakeScroll {
	primary: true;
	children: Component[];
	scrollTop: number;
	isFollowingEnd: boolean;
	contentHeight: number;
	scrolled: number[];
	getContentWidth(width: number): number;
	scrollTo(top: number): void;
}

function container(children: Component[]): Component & { children: Component[] } {
	return { children, render: () => [], invalidate: () => {} };
}

/**
 * 造一个假 ScrollView，**结构照真身来**：
 * 内容容器 → [header 区段, 聊天区段]，消息块在聊天区段里，不是内容容器的直接子节点。
 * `headerHeights` 是 header 区段里几块不透明内容的高度（用来验坐标原点）。
 */
function fakeScrollView(prompts: Array<{ text: string; height: number }>, headerHeights: number[] = []): FakeScroll {
	const chat = container(prompts.map((prompt) => fakePrompt(prompt.text, prompt.height)));
	const document = container([...headerHeights.map(fakeBlock), chat]);
	return {
		primary: true,
		children: [document],
		scrollTop: 0,
		isFollowingEnd: false,
		contentHeight: 0,
		scrolled: [],
		getContentWidth: (width) => width,
		scrollTo(top) {
			this.scrolled.push(top);
			this.scrollTop = top;
		},
	};
}

function fakeTui(scroll: FakeScroll, frame?: unknown): unknown {
	return {
		mode: "fullscreen",
		layoutRoot: { entries: [{ component: scroll }, { component: { primary: false } }] },
		currentLayout: frame,
	};
}

/** 记号主题：把 token 名编进输出，方便断言「取色跟着主题走」。 */
function fakeTheme(mark: string) {
	return { fg: (token: string, text: string) => `<${mark}:${token}>${text}</>` } as never;
}

function render(scroll: FakeScroll, frame?: unknown, mark = "T"): { lines: string[]; bar: StickyBar } {
	const bar = new StickyBar(fakeTui(scroll, frame), () => fakeTheme(mark));
	return { lines: bar.render(40), bar };
}

// ------------------------------------------------------------------ 探针

test("探针：没有 transcript → 硬前提不满足", () => {
	assert.equal(probe({ mode: "fullscreen", layoutRoot: { entries: [] } }).hard, false);
	assert.equal(probe({ mode: "fullscreen" }).hard, false);
	assert.equal(probe(undefined).hard, false);
});

test("探针：结构就位但没有布局帧 → 硬前提满足、软前提不满足（降级）", () => {
	const check = probe(fakeTui(fakeScrollView([{ text: "A", height: 1 }])));
	assert.equal(check.hard, true);
	assert.equal(check.checksum, false);
});

test("探针：布局帧里能找到内容行 → 软前提也满足", () => {
	const scroll = fakeScrollView([{ text: "A", height: 1 }]);
	const frame = { root: { scrollView: scroll, scrollContentLines: ["x"], children: [] } };
	assert.equal(probe(fakeTui(scroll, frame)).checksum, true);
});

// ------------------------------------------------------------------ 外观与显隐

test("外观：显示态恰好 1 行，隐藏态恰好 0 行", () => {
	const scroll = fakeScrollView([{ text: "上一条提问", height: 2 }]);
	scroll.scrollTop = 2; // 整条滚出去了
	const shown = render(scroll).lines;
	assert.equal(shown.length, 1);

	scroll.scrollTop = 0; // 没滚出去
	assert.equal(render(scroll).lines.length, 0);
});

test("外观：显示态那行宽度撑满", () => {
	const scroll = fakeScrollView([{ text: "短", height: 1 }]);
	scroll.scrollTop = 1;
	const line = render(scroll).lines[0] ?? "";
	assert.equal(visibleWidth(line), 40, "应当补空格撑满整行");
});

test("外观：行里有指示符 ↑", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	assert.ok((render(scroll).lines[0] ?? "").includes("↑"));
});

test("显隐：跟随末尾时不显示", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	scroll.isFollowingEnd = true;
	assert.equal(render(scroll).lines.length, 0);
});

test("显隐：没有候选时不显示", () => {
	assert.equal(render(fakeScrollView([{ text: "上一条", height: 3 }])).lines.length, 0);
});

test("取色随主题：换主题后输出跟着变", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	const a = render(scroll, undefined, "甲").lines[0] ?? "";
	const b = render(scroll, undefined, "乙").lines[0] ?? "";
	assert.notEqual(a, b);
	assert.ok(a.includes("甲:accent") && a.includes("甲:muted"));
});

test("没有 transcript 时 render 返回空数组，不抛", () => {
	const bar = new StickyBar({ mode: "fullscreen" }, () => fakeTheme("T"));
	assert.deepEqual(bar.render(40), []);
});

// ------------------------------------------------------------------ 坐标（回归护栏）

test("坐标：header 高度计入行号——不会整体偏一行", () => {
	// 头一块 otherHeights=[5] 就是 header。提问在 [5,8)。
	const scroll = fakeScrollView([{ text: "目标提问", height: 3 }], [5]);
	// 只滚到第 4 行（提问还没整条出去）→ 不该显示
	scroll.scrollTop = 4;
	assert.equal(render(scroll).lines.length, 0, "忘了算 header 高度就会在这里漏出来");
	// 滚到第 8 行（提问整条出去）→ 该显示
	scroll.scrollTop = 8;
	assert.equal(render(scroll).lines.length, 1);
});

// ------------------------------------------------------------------ 点击

test("点击：滚回该提问的起始行，并立刻收起", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 3 }], [4]);
	scroll.scrollTop = 10;
	const { bar, lines } = render(scroll);
	assert.equal(lines.length, 1);

	const result = bar.handleMouse({ type: "click", button: "left" } as never);
	assert.deepEqual(scroll.scrolled, [4], "应滚到提问起始行（含 header 偏移）");
	assert.equal(result?.handled, true);
	assert.equal(bar.render(40).length, 0, "跳完不该还挂着（此时它已进视口）");
});

test("点击：非左键 / 非 click 不处理", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	const { bar } = render(scroll);
	assert.equal(bar.handleMouse({ type: "click", button: "right" } as never), undefined);
	assert.equal(bar.handleMouse({ type: "press", button: "left" } as never), undefined);
	assert.deepEqual(scroll.scrolled, []);
});

test("点击：没有选中项时不处理", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 5 }]);
	const { bar } = render(scroll);
	assert.equal(bar.handleMouse({ type: "click", button: "left" } as never), undefined);
});

// ------------------------------------------------------------------ 校验和自检

test("校验和：缓存与真实内容高度对不上时，下一帧整套重算", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 2 }], [3]);
	scroll.scrollTop = 5;

	// 首帧：报一个错误的校验和，让缓存「看起来是坏的」
	const wrongFrame = { root: { scrollView: scroll, scrollContentLines: ["a"], children: [] } };
	assert.equal(render(scroll, wrongFrame).lines.length, 1);

	// 第二帧：真实高度（3 + 2 = 5 行）与上一帧算出来的和对不上 → 缓存作废重算，
	// 结果仍然正确（说明自检不会把功能搞坏）
	const goodFrame = { root: { scrollView: scroll, scrollContentLines: ["a", "b", "c", "d", "e"], children: [] } };
	assert.equal(render(scroll, goodFrame).lines.length, 1);
});

// ------------------------------------------------------------------ 布局注入

function entriesRoot(): RootLike {
	return {
		entries: [
			{ component: { primary: true }, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: { primary: false }, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		],
	};
}

test("注入：吸顶条插到第 0 项，其余 entry 是同一对象引用（非复制、非嵌套）", () => {
	const root = entriesRoot();
	const transcript = root.entries?.[0];
	const dock = root.entries?.[1];
	const bar = fakeBlock(1);

	assert.equal(syncBar(root, bar, true), true);
	assert.equal(root.entries?.length, 3);
	assert.equal(root.entries?.[0]?.component, bar);
	assert.equal(root.entries?.[1], transcript, "transcript 必须还是同一个 entry 对象");
	assert.equal(root.entries?.[2], dock, "dock 必须还是同一个 entry 对象");
});

test("注入：幂等——连调多次不会插出第二条", () => {
	const root = entriesRoot();
	const bar = fakeBlock(1);
	syncBar(root, bar, true);
	syncBar(root, bar, true);
	syncBar(root, bar, true);
	assert.equal(root.entries?.length, 3);
});

test("关闭恢复：顺序与选项回到注入前", () => {
	const root = entriesRoot();
	const before = JSON.parse(JSON.stringify(root.entries));
	const bar = fakeBlock(1);
	syncBar(root, bar, true);
	assert.equal(syncBar(root, bar, false), true);
	assert.deepEqual(JSON.parse(JSON.stringify(root.entries)), before);
});

test("关闭：本来就没插过 → 什么都不做（不谎报改动）", () => {
	const root = entriesRoot();
	assert.equal(syncBar(root, fakeBlock(1), false), false);
	assert.equal(root.entries?.length, 2);
});

test("硬前提不符：项数不足 / 找不到 transcript → 完全不动布局", () => {
	const tooShort: RootLike = { entries: [{ component: { primary: true } }] };
	assert.equal(syncBar(tooShort, fakeBlock(1), true), false);
	assert.equal(tooShort.entries?.length, 1);

	const noTranscript: RootLike = { entries: [{ component: {} }, { component: {} }] };
	assert.equal(syncBar(noTranscript, fakeBlock(1), true), false);
	assert.equal(noTranscript.entries?.length, 2);

	assert.equal(syncBar(undefined, fakeBlock(1), true), false);
	assert.equal(syncBar({}, fakeBlock(1), true), false);
});

test("不嵌套他人 entry：有第三方 entry 时注入与移除都不把它包起来", () => {
	const root = entriesRoot();
	const third = { component: { name: "别人" }, basis: "auto" as const, grow: 0, shrink: 0, minSize: 0 };
	root.entries?.push(third);
	const bar = fakeBlock(1);

	syncBar(root, bar, true);
	assert.equal(root.entries?.[3], third, "第三方 entry 必须原样在，且没被包进新容器");

	syncBar(root, bar, false);
	assert.equal(root.entries?.length, 3);
	assert.equal(root.entries?.[2], third);
});

test("旧实例残留：/reload 后旧条被摘掉，只留一条", () => {
	const root = entriesRoot();
	const oldBar = Object.assign(fakeBlock(1), { [Symbol.for("pi-plugins.sticky-prompt.bar")]: true });
	const newBar = Object.assign(fakeBlock(1), { [Symbol.for("pi-plugins.sticky-prompt.bar")]: true });

	syncBar(root, oldBar, true);
	assert.equal(root.entries?.[0]?.component, oldBar);

	syncBar(root, newBar, true);
	assert.equal(root.entries?.length, 3, "不该同时留着旧条和新条");
	assert.equal(root.entries?.[0]?.component, newBar);
});

test("关闭时也能摘掉旧实例的条（不看实例身份，看标记）", () => {
	const root = entriesRoot();
	const oldBar = Object.assign(fakeBlock(1), { [Symbol.for("pi-plugins.sticky-prompt.bar")]: true });
	syncBar(root, oldBar, true);
	assert.equal(syncBar(root, fakeBlock(1), false), true);
	assert.equal(root.entries?.length, 2);
});

// ------------------------------------------------------------------ 设置读写

test("设置：读不到文件 → 默认开启", () => {
	const dir = mkdtempSync(join(tmpdir(), "sticky-prompt-"));
	assert.deepEqual(loadState(join(dir, "missing.json")), { enabled: true });
});

test("设置：内容损坏 → 默认开启，不抛", () => {
	const dir = mkdtempSync(join(tmpdir(), "sticky-prompt-"));
	const file = join(dir, "broken.json");
	writeFileSync(file, "{ 这不是 JSON");
	assert.deepEqual(loadState(file), { enabled: true });

	writeFileSync(file, JSON.stringify({ enabled: "yes" }));
	assert.deepEqual(loadState(file), { enabled: true }, "类型不对也要回落默认");
});

test("设置：写完能读回，且不留 .tmp 半截文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "sticky-prompt-"));
	const file = join(dir, "sticky-prompt.json");
	saveState({ enabled: false }, file);
	assert.deepEqual(loadState(file), { enabled: false });
	assert.deepEqual(readdirSync(dir), ["sticky-prompt.json"], "不该留下 .tmp");
	assert.ok(readFileSync(file, "utf8").includes("false"));
});

// ------------------------------------------------------------------ 接线

interface FakePi {
	pi: { on(name: string, handler: (...args: never[]) => unknown): void; registerCommand(name: string, options: unknown): void };
	events: Map<string, (...args: never[]) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function fakePi(): FakePi {
	const events = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		pi: {
			on: (name, handler) => void events.set(name, handler),
			registerCommand: (name, options) => void commands.set(name, options as never),
		},
		events,
		commands,
	};
}

/** 假 ctx：记下所有通知，并盯住任何「动会话」的调用（纯展示要验的就是它没被动过）。 */
function fakeCtx(options: { mode: string; hasUI?: boolean; root?: RootLike }) {
	const notifications: string[] = [];
	const sessionTouches: string[] = [];
	let tui = { mode: options.mode, layoutRoot: options.root, requestRender: () => {} };
	const ui = {
		notify: (message: string) => void notifications.push(message),
		theme: fakeTheme("T"),
		setWidget: (_key: string, content: unknown) => {
			// captureTui 就是靠这个同步工厂拿到 tui 的，返回的组件我们不要
			if (typeof content === "function") (content as (t: unknown) => unknown)(tui);
		},
	};
	const ctx = {
		ui,
		hasUI: options.hasUI ?? true,
		sessionManager: { appendEntry: () => void sessionTouches.push("sessionManager.appendEntry") },
	};
	return { ctx, notifications, sessionTouches, setMode: (mode: string) => void (tui.mode = mode) };
}

/** 一个「结构就位」的根布局：transcript + dock。 */
function layoutRootWith(scroll: FakeScroll): RootLike {
	return { entries: [{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }, { component: {}, basis: "auto", grow: 0, shrink: 1, minSize: 1 }] };
}

async function startSession(pi: FakePi, ctx: unknown): Promise<void> {
	await (pi.events.get("session_start") as (e: unknown, c: unknown) => Promise<void>)({}, ctx);
}

test("接线：全屏模式启动后，吸顶条进了根布局第 0 项，并且认得出来", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	const root = layoutRootWith(scroll);
	const { ctx } = fakeCtx({ mode: "fullscreen", root });

	await startSession(pi, ctx);
	assert.equal(root.entries?.length, 3);
	const bar = root.entries?.[0]?.component;
	assert.ok(bar instanceof StickyBar, "第 0 项应当是吸顶条实例");
	assert.equal((bar as unknown as Record<symbol, unknown>)[Symbol.for("pi-plugins.sticky-prompt.bar")], true);
});

test("接线：regular 模式完全 inert——不注入、不报错、不告警", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	const root = layoutRootWith(scroll);
	const { ctx, notifications } = fakeCtx({ mode: "regular", root });

	await startSession(pi, ctx);
	assert.equal(root.entries?.length, 2, "regular 模式不该动布局");
	assert.deepEqual(notifications, [], "regular 模式是正常跳过，不该告警");
});

test("接线：硬前提不符 → 不注入，且告警恰好一次", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const root: RootLike = { entries: [{ component: {} }] }; // 没有 transcript
	const { ctx, notifications } = fakeCtx({ mode: "fullscreen", root });

	await startSession(pi, ctx);
	assert.equal(root.entries?.length, 1);
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]?.includes("sticky-prompt"));
});

test("接线：软前提不符（没有布局帧）→ 照常注入并工作，只是告警一次", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	const root = layoutRootWith(scroll);
	const { ctx, notifications } = fakeCtx({ mode: "fullscreen", root });

	await startSession(pi, ctx);
	assert.equal(root.entries?.length, 3, "降级也要能用，必须注入");
	assert.equal(notifications.length, 1, "降级要告警，但不能因此不工作");
});

test("纯展示：显示 → 点击 → 消失 全程不碰会话", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const scroll = fakeScrollView([{ text: "上一条", height: 2 }]);
	scroll.scrollTop = 2;
	const root = layoutRootWith(scroll);
	const { ctx, sessionTouches } = fakeCtx({ mode: "fullscreen", root });
	await startSession(pi, ctx);

	// 走一遍吸顶条：它在布局第 0 项，直接拿来渲染与点击
	const bar = root.entries?.[0]?.component as StickyBar;
	assert.equal(bar.render(40).length, 1);
	bar.handleMouse({ type: "click", button: "left" } as never);
	assert.equal(bar.render(40).length, 0);

	assert.deepEqual(sessionTouches, [], "纯展示：不该写会话、不该 appendEntry");
});

test("命令：/sticky-prompt 切换开关、落盘、通知", async () => {
	// 指到临时目录：这条用例会真的走 saveState，绝不能写进使用者的 ~/.pi/agent/。
	const dir = mkdtempSync(join(tmpdir(), "sticky-prompt-"));
	const file = join(dir, "sticky-prompt.json");
	process.env.PI_STICKY_PROMPT_STATE = file;
	try {
		saveState({ enabled: true }, file); // 从「开」起步
		const pi = fakePi();
		extension(pi.pi as never);
		const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
		const root = layoutRootWith(scroll);
		const { ctx, notifications } = fakeCtx({ mode: "fullscreen", root });
		await startSession(pi, ctx);
		assert.equal(root.entries?.length, 3);

		const command = pi.commands.get("sticky-prompt");
		assert.ok(command, "命令应已注册");

		await command.handler("", ctx);
		assert.equal(root.entries?.length, 2, "关掉后吸顶条应被摘掉");
		assert.ok(notifications.at(-1)?.includes("关闭"));
		assert.deepEqual(loadState(file), { enabled: false }, "关掉的状态应已落盘");

		await command.handler("", ctx);
		assert.equal(root.entries?.length, 3, "再开一次应装回来");
		assert.ok(notifications.at(-1)?.includes("开启"));
		assert.deepEqual(loadState(file), { enabled: true }, "连按两次应回到原状态");
	} finally {
		delete process.env.PI_STICKY_PROMPT_STATE;
	}
});

test("关闭会话：把吸顶条摘干净，不留没人管的 entry", async () => {
	const pi = fakePi();
	extension(pi.pi as never);
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	const root = layoutRootWith(scroll);
	const { ctx } = fakeCtx({ mode: "fullscreen", root });
	await startSession(pi, ctx);
	assert.equal(root.entries?.length, 3);

	await (pi.events.get("session_shutdown") as () => Promise<void>)();
	assert.equal(root.entries?.length, 2);
});
