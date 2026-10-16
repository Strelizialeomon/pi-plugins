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

/** 假的不透明内容块。`height` 可改——用来模拟「非尾块长高」。 */
interface FakeBlock extends Component {
	height: number;
}
function fakeBlock(height: number): FakeBlock {
	const block: FakeBlock = {
		height,
		render: () => new Array<string>(block.height).fill("别的"),
		invalidate: () => {},
	};
	return block;
}

interface FakeScroll {
	primary: true;
	children: Component[];
	scrollTop: number;
	isFollowingEnd: boolean;
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
 */
function fakeScrollView(prompts: Array<{ text: string; height: number }>, headerHeights: number[] = []): FakeScroll {
	const chat = container(prompts.map((prompt) => fakePrompt(prompt.text, prompt.height)));
	const document = container([...headerHeights.map(fakeBlock), chat]);
	return {
		primary: true,
		children: [document],
		scrollTop: 0,
		isFollowingEnd: false,
		scrolled: [],
		getContentWidth: (width) => width,
		scrollTo(top) {
			this.scrolled.push(top);
			this.scrollTop = top;
		},
	};
}

function fakeTui(scroll: FakeScroll | undefined, entries?: unknown[]): unknown {
	return {
		mode: "fullscreen",
		layoutRoot: { entries: entries ?? [{ component: scroll }, { component: { primary: false } }] },
	};
}

/** 记号主题：把 token 名编进输出，方便断言「取色跟着主题走」。 */
function fakeTheme(mark: string) {
	return { fg: (token: string, text: string) => `<${mark}:${token}>${text}</>` } as never;
}

function barFor(scroll: FakeScroll | undefined, theme: () => ReturnType<typeof fakeTheme> = () => fakeTheme("T")) {
	const bar = new StickyBar(fakeTui(scroll), theme);
	return { bar, render: (width = 40) => bar.render(width) };
}

// ------------------------------------------------------------------ 探针

test("探针：没有 transcript → 不通过", () => {
	assert.equal(probe({ mode: "fullscreen", layoutRoot: { entries: [] } }).ok, false);
	assert.equal(probe({ mode: "fullscreen" }).ok, false);
	assert.equal(probe(undefined).ok, false);
});

test("探针：项数不足 → 不通过（这条是硬前提，不能不吭声地放过）", () => {
	const scroll = fakeScrollView([{ text: "A", height: 1 }]);
	const check = probe(fakeTui(scroll, [{ component: scroll }]));
	assert.equal(check.ok, false);
	assert.ok(check.reason?.includes("项数不足"));
});

test("探针：内容容器没有内容 → 不通过", () => {
	const scroll = { ...fakeScrollView([]), children: [container([])] } as unknown as FakeScroll;
	const check = probe(fakeTui(scroll));
	assert.equal(check.ok, false);
	assert.ok(check.reason?.includes("没有内容区段"));
});

test("探针：内容容器取不到 → 不通过", () => {
	const scroll = { ...fakeScrollView([]), children: [] } as unknown as FakeScroll;
	assert.equal(probe(fakeTui(scroll)).ok, false);
});

test("探针：结构就位 → 通过", () => {
	assert.equal(probe(fakeTui(fakeScrollView([{ text: "A", height: 1 }]))).ok, true);
});

// ------------------------------------------------------------------ 外观与显隐

test("外观：显示态恰好 1 行，隐藏态恰好 0 行", () => {
	const scroll = fakeScrollView([{ text: "上一条提问", height: 2 }]);
	scroll.scrollTop = 2; // 整条滚出去了
	assert.equal(barFor(scroll).render().length, 1);

	scroll.scrollTop = 0; // 没滚出去
	assert.equal(barFor(scroll).render().length, 0);
});

test("外观：显示态那行宽度撑满", () => {
	const scroll = fakeScrollView([{ text: "短", height: 1 }]);
	scroll.scrollTop = 1;
	assert.equal(visibleWidth(barFor(scroll).render()[0] ?? ""), 40, "应当补空格撑满整行");
});

test("外观：行里有指示符 ↑", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	assert.ok((barFor(scroll).render()[0] ?? "").includes("↑"));
});

test("显隐：跟随末尾时不显示", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	scroll.isFollowingEnd = true;
	assert.equal(barFor(scroll).render().length, 0);
});

test("显隐：没有候选时不显示", () => {
	assert.equal(barFor(fakeScrollView([{ text: "上一条", height: 3 }])).render().length, 0);
});

test("没有 transcript 时 render 返回空数组，不抛", () => {
	assert.deepEqual(barFor(undefined).render(), []);
});

// ------------------------------------------------------------------ 取色随主题

test("取色随主题：同一个 bar 实例、换主题后输出跟着变（验的是懒取，不是构造时捕获）", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;

	let mark = "甲";
	const bar = new StickyBar(fakeTui(scroll), () => fakeTheme(mark));
	const first = bar.render(40)[0] ?? "";
	mark = "乙";
	const second = bar.render(40)[0] ?? "";

	assert.ok(first.includes("甲:accent") && first.includes("甲:muted"), first);
	assert.ok(second.includes("乙:accent") && second.includes("乙:muted"), second);
	assert.notEqual(first, second);
});

// ------------------------------------------------------------------ 结构异常

test("结构异常：提问正文读不到时上报一次，且不画空行", () => {
	// 造一个 instanceof 成立、但没有 text 字段的组件 —— 模拟 Pi 改了字段名
	const broken = Object.create(UserMessageComponent.prototype) as Component;
	broken.render = () => ["提问"];
	broken.invalidate = () => {};
	const scroll: FakeScroll = {
		primary: true,
		children: [container([container([broken])])],
		scrollTop: 1,
		isFollowingEnd: false,
		scrolled: [],
		getContentWidth: (width) => width,
		scrollTo(top) {
			this.scrolled.push(top);
			this.scrollTop = top;
		},
	};

	const reasons: string[] = [];
	const bar = new StickyBar(fakeTui(scroll), () => fakeTheme("T"), (reason) => reasons.push(reason));
	assert.deepEqual(bar.render(40), [], "绝不能画一条空行——那看起来像「这条提问本来就是空的」");
	bar.render(40);
	bar.render(40);
	assert.equal(reasons.length, 1, "只报一次，不许每帧刷屏");
	assert.ok(reasons[0]?.includes("正文读不到"));
});

// ------------------------------------------------------------------ 坐标

test("坐标：header 高度计入行号——不会整体偏一行", () => {
	// 头一块 otherHeights=[5] 就是 header。提问在 [5,8)。
	const scroll = fakeScrollView([{ text: "目标提问", height: 3 }], [5]);
	scroll.scrollTop = 4;
	assert.equal(barFor(scroll).render().length, 0, "忘了算 header 高度就会在这里漏出来");

	scroll.scrollTop = 8;
	const { bar } = barFor(scroll);
	assert.equal(bar.render(40).length, 1);
	bar.handleMouse({ type: "click", button: "left" } as never);
	assert.deepEqual(scroll.scrolled, [5], "跳转目标也必须是含 header 偏移后的 5");
});

// ------------------------------------------------------------------ 每帧实测（缓存的反回归）

test("每帧实测：候选**下方**的块长高不影响答案，也不会把点击目标带偏", () => {
	// 注意这条不是缓存的反回归（下方块的高度不进候选的行号），它守的是另一条不变量：
	// 流式输出把尾部撑高时，已经判定好的那条不该跟着变。
	// [header 2][提问 2][中间块]
	const tall = fakeBlock(3);
	const chat = container([fakePrompt("上一条", 2), tall]);
	const document = container([fakeBlock(2), chat]);
	const scroll: FakeScroll = {
		primary: true,
		children: [document],
		scrollTop: 6, // 提问 [2,4) 已滚出；中间块 [4,7)
		isFollowingEnd: false,
		scrolled: [],
		getContentWidth: (width) => width,
		scrollTo(top) {
			this.scrolled.push(top);
			this.scrollTop = top;
		},
	};
	const { bar } = barFor(scroll);

	// 中间块长到 10 行——提问的位置不变，仍然该显示
	assert.equal(bar.render(40).length, 1);
	tall.height = 10;

	assert.equal(bar.render(40).length, 1, "下方块长高不该把已经对的那条挤掉");
	const picked = bar.handleMouse({ type: "click", button: "left" } as never);
	assert.equal(picked?.handled, true);
	assert.deepEqual(scroll.scrolled, [2], "跳转目标不受下方块长高影响");
});

test("每帧实测：header 长高会立刻改变候选（上滚后该消失就消失）", () => {
	const header = fakeBlock(0);
	const document = container([header, container([fakePrompt("上一条", 2)])]);
	const scroll: FakeScroll = {
		primary: true,
		children: [document],
		scrollTop: 2, // 提问 [0,2) 已整条滚出 → 该显示
		isFollowingEnd: false,
		scrolled: [],
		getContentWidth: (width) => width,
		scrollTo(top) {
			this.scrolled.push(top);
			this.scrollTop = top;
		},
	};
	const { bar } = barFor(scroll);
	assert.equal(bar.render(40).length, 1);

	// header 长高 2 行 → 提问被推到 [2,4)，不再「整条在视口顶之上」→ 同帧就该隐藏
	header.height = 2;
	assert.equal(bar.render(40).length, 0, "同一帧就该隐藏");
});

// ------------------------------------------------------------------ 点击

test("点击：滚回该提问的起始行，并立刻收起", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 3 }], [4]);
	scroll.scrollTop = 10;
	const { bar } = barFor(scroll);
	assert.equal(bar.render(40).length, 1);

	const result = bar.handleMouse({ type: "click", button: "left" } as never);
	assert.deepEqual(scroll.scrolled, [4], "应滚到提问起始行（含 header 偏移）");
	assert.equal(result?.handled, true);
	assert.equal(bar.render(40).length, 0, "跳完不该还挂着（此时它已进视口）");
});

test("点击：非左键 / 非 click 不处理", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
	scroll.scrollTop = 1;
	const { bar } = barFor(scroll);
	bar.render(40);
	assert.equal(bar.handleMouse({ type: "click", button: "right" } as never), undefined);
	assert.equal(bar.handleMouse({ type: "press", button: "left" } as never), undefined);
	assert.deepEqual(scroll.scrolled, []);
});

test("点击：没有选中项时不处理", () => {
	const scroll = fakeScrollView([{ text: "上一条", height: 5 }]);
	const { bar } = barFor(scroll);
	bar.render(40);
	assert.equal(bar.handleMouse({ type: "click", button: "left" } as never), undefined);
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
	const mark = { [Symbol.for("pi-plugins.sticky-prompt.bar")]: true };
	const oldBar = Object.assign(fakeBlock(1), mark);
	const newBar = Object.assign(fakeBlock(1), mark);

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
	pi: Record<string, unknown>;
	/** 被访问过的 pi 成员。纯展示要验的就是「只碰了该碰的」。 */
	touched: Set<string>;
	events: Map<string, (...args: never[]) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function fakePi(): FakePi {
	const events = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const touched = new Set<string>();
	const implementation: Record<string, unknown> = {
		on: (name: string, handler: (...args: never[]) => unknown) => void events.set(name, handler),
		registerCommand: (name: string, options: unknown) => void commands.set(name, options as never),
	};
	// 用 Proxy 记录访问：任何「读了 pi 的其他成员」都会露出来（例如偷偷用了会话 API）。
	const pi = new Proxy(implementation, {
		get: (target, property) => {
			touched.add(String(property));
			return Reflect.get(target, property);
		},
	});
	return { pi, touched, events, commands };
}

interface FakeCtx {
	ctx: unknown;
	notifications: string[];
	/** 任何「动会话」的调用都记这里 */
	sessionTouches: string[];
}

/** 假 ctx：记下所有通知，并盯住任何动会话的调用。 */
function fakeCtx(options: { mode: string; hasUI?: boolean; root?: RootLike }): FakeCtx {
	const notifications: string[] = [];
	const sessionTouches: string[] = [];
	const tui = { mode: options.mode, layoutRoot: options.root, requestRender: () => {} };
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
		sessionManager: {
			appendEntry: () => void sessionTouches.push("sessionManager.appendEntry"),
			getEntries: () => {
				sessionTouches.push("sessionManager.getEntries");
				return [];
			},
		},
		appendEntry: () => void sessionTouches.push("appendEntry"),
	};
	return { ctx, notifications, sessionTouches };
}

/** 一个「结构就位」的根布局：transcript + dock。 */
function layoutRootWith(scroll: FakeScroll): RootLike {
	return {
		entries: [
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: {}, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		],
	};
}

async function startSession(pi: FakePi, ctx: unknown): Promise<void> {
	await (pi.events.get("session_start") as (e: unknown, c: unknown) => Promise<void>)({}, ctx);
}

/**
 * 所有会构造插件的用例都必须在临时状态文件下跑。
 * 不隔离的话，`loadState()` 会去读使用者真实的 `~/.pi/agent/sticky-prompt.json`——
 * 谁用 `/sticky-prompt` 关过一次，这四个用例就会红。
 */
async function withTempState(run: (file: string) => Promise<void>): Promise<void> {
	const file = join(mkdtempSync(join(tmpdir(), "sticky-prompt-")), "sticky-prompt.json");
	process.env.PI_STICKY_PROMPT_STATE = file;
	try {
		await run(file);
	} finally {
		delete process.env.PI_STICKY_PROMPT_STATE;
	}
}

test("接线：全屏模式启动后，吸顶条进了根布局第 0 项，并且认得出来", async () => {
	await withTempState(async () => {
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
});

test("接线：regular 模式完全 inert——不注入、不报错、不告警", async () => {
	await withTempState(async () => {
		const pi = fakePi();
		extension(pi.pi as never);
		const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
		const root = layoutRootWith(scroll);
		const { ctx, notifications } = fakeCtx({ mode: "regular", root });

		await startSession(pi, ctx);
		assert.equal(root.entries?.length, 2, "regular 模式不该动布局");
		assert.deepEqual(notifications, [], "regular 模式是正常跳过，不该告警");
	});
});

test("接线：探针不通过 → 不注入，且告警恰好一次（含项数不足这条）", async () => {
	await withTempState(async () => {
		const pi = fakePi();
		extension(pi.pi as never);
		const root: RootLike = { entries: [{ component: {} }] }; // 项数不足 + 没有 transcript
		const { ctx, notifications } = fakeCtx({ mode: "fullscreen", root });

		await startSession(pi, ctx);
		assert.equal(root.entries?.length, 1, "不该动别人的布局");
		assert.equal(notifications.length, 1, "必须告警，不能静默");
		assert.ok(notifications[0]?.includes("sticky-prompt"));
		assert.ok(notifications[0]?.includes("停用"), `文案要说清是停用：${notifications[0]}`);
	});
});

test("纯展示：显示 → 点击 → 消失 全程不碰会话，也不读 pi 的其他能力", async () => {
	await withTempState(async () => {
		const pi = fakePi();
		extension(pi.pi as never);
		const scroll = fakeScrollView([{ text: "上一条", height: 2 }]);
		scroll.scrollTop = 2;
		const root = layoutRootWith(scroll);
		const { ctx, sessionTouches } = fakeCtx({ mode: "fullscreen", root });
		await startSession(pi, ctx);

		const bar = root.entries?.[0]?.component as StickyBar;
		assert.equal(bar.render(40).length, 1);
		bar.handleMouse({ type: "click", button: "left" } as never);
		assert.equal(bar.render(40).length, 0);

		assert.deepEqual(sessionTouches, [], "纯展示：不该写会话、不该读会话");
		assert.deepEqual([...pi.touched].sort(), ["on", "registerCommand"], "只该碰这两样 pi 能力");
	});
});

test("命令：/sticky-prompt 切换开关、落盘、通知", async () => {
	await withTempState(async (file) => {
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
	});
});

test("接线：使用者之前关过它（enabled:false）→ 启动时不注入，且不告警", async () => {
	await withTempState(async (file) => {
		saveState({ enabled: false }, file);
		const pi = fakePi();
		extension(pi.pi as never);
		const scroll = fakeScrollView([{ text: "上一条", height: 1 }]);
		const root = layoutRootWith(scroll);
		const { ctx, notifications } = fakeCtx({ mode: "fullscreen", root });

		await startSession(pi, ctx);
		assert.equal(root.entries?.length, 2, "关着的状态要跨会话保留");
		assert.deepEqual(notifications, [], "关着是用户的选择，不是故障，不该告警");
	});
});

test("关闭会话：把吸顶条摘干净，不留没人管的 entry", async () => {
	await withTempState(async () => {
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
});
