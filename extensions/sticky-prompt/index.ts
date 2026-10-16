/**
 * sticky-prompt —— 把「上一次的输入」常驻在 transcript 顶部。
 *
 * 这个文件只做接线：注册命令、读写设置、把吸顶条同步进 Pi 的根布局。
 * 判定规则在 prompt-index.ts，布局读取与渲染在 sticky-bar.ts。
 *
 * 只在全屏模式（`tuiMode: "fullscreen"`）生效；regular 模式没有布局系统，
 * 插件在那里完全 inert——不注入、不报错、不告警（spec §3）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { probe, StickyBar } from "./sticky-bar.ts";

const COMMAND = "sticky-prompt";

/**
 * 设置文件路径。`PI_STICKY_PROMPT_STATE` 可覆盖——单测靠它指到临时目录，
 * 不会去动使用者真实的 `~/.pi/agent/`。按调用时取值，不在模块加载时定死。
 */
function stateFile(): string {
	return process.env.PI_STICKY_PROMPT_STATE ?? join(homedir(), ".pi", "agent", "sticky-prompt.json");
}
/** 临时 widget 的 key：只为拿到活 tui 引用，拿到就撤掉。 */
const CAPTURE_KEY = "sticky-prompt.capture";
/**
 * 打在吸顶条组件上的标记。`/reload` 会换一个新实例，靠实例比对认不出布局里
 * 残留的旧条子；标记是记在组件上的，跨实例认得出。
 */
const BAR_MARK = Symbol.for("pi-plugins.sticky-prompt.bar");
/** 自愈巡检间隔。只做几次数组查找，代价可忽略；见 startHeal() 的说明。 */
const HEAL_INTERVAL_MS = 1000;

interface BarComponent extends Component {
	[BAR_MARK]?: boolean;
}

interface StackEntryLike {
	component?: unknown;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
}

/** 根布局只管到 `entries` 这一层，其余字段原样不动。 */
export interface RootLike {
	entries?: StackEntryLike[];
}

interface TuiLike {
	mode?: string;
	layoutRoot?: RootLike;
	requestRender?: () => void;
}

export interface State {
	enabled: boolean;
}

const DEFAULT_STATE: State = { enabled: true };

/** 读设置：读不到、格式不对、内容损坏，一律回落默认值，不报错。 */
export function loadState(file: string = stateFile()): State {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const enabled = (parsed as { enabled?: unknown }).enabled;
			if (typeof enabled === "boolean") return { enabled };
		}
	} catch {
		// 没有文件 / 不是合法 JSON 都走这里
	}
	return { ...DEFAULT_STATE };
}

/** 写设置：先写 `.tmp` 再 rename，中途崩不会留下半截 JSON。失败不阻塞。 */
export function saveState(state: State, file: string = stateFile()): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(state, null, 2));
		renameSync(tmp, file);
	} catch {
		// 写不进去就算了，不该因为设置落盘失败挡住用
	}
}

function isTranscriptEntry(entry: StackEntryLike | undefined): boolean {
	return (entry?.component as { primary?: boolean } | undefined)?.primary === true;
}

function isBar(component: unknown): boolean {
	return (component as BarComponent | undefined)?.[BAR_MARK] === true;
}

/**
 * 把吸顶条同步进根布局，返回是否真的改动了它。
 *
 * 三条自我约束（spec §4.6）：
 * ① 只动 `entries` 的**顺序**，transcript 与 dock 那些 entry 原样复用——别的扩展
 *    可能按 `root.entries` 找自己，嵌套或复制会让它找不到自己；
 * ② 硬前提不满足（项数不足 / 找不到 transcript）就什么都不做，不猜、不硬插；
 * ③ 开了要幂等地保证它在第 0 项，关了要把它摘干净、其余顺序不变。
 */
export function syncBar(root: RootLike | undefined, bar: Component, enabled: boolean): boolean {
	const entries = root?.entries;
	if (!Array.isArray(entries) || entries.length < 2) return false;
	if (!entries.some(isTranscriptEntry)) return false;

	// 认两种：**实例身份**（本次进程里就是它）或**标记**（/reload 换了实例，只剩标记还认得）。
	// 只认标记的话，万一标记没打上就会重复插入——那个失败模式太安静了。
	const isOurs = (component: unknown): boolean => component === bar || isBar(component);
	const at = entries.findIndex((entry) => isOurs(entry?.component));
	if (!enabled) {
		if (at < 0) return false;
		entries.splice(at, 1);
		return true;
	}
	if (at === 0 && entries[0]?.component === bar) return false;
	// 旧实例残留、或不在第一位：先摘掉再插回最前。摘的是自己，不碰别人。
	if (at >= 0) entries.splice(at, 1);
	entries.unshift({ component: bar, basis: "auto", grow: 0, shrink: 0, minSize: 0 });
	return true;
}

/**
 * 拿活 tui 引用。`setWidget` 的工厂会被同步调用一次，在里面接住 tui，
 * 然后立刻把 widget 撤掉——不在界面上留任何东西。扩展 API 没有别的地方能拿到它。
 */
function captureTui(ui: ExtensionUIContext): TuiLike | undefined {
	let captured: TuiLike | undefined;
	ui.setWidget(CAPTURE_KEY, (tui) => {
		captured = tui as unknown as TuiLike;
		return new Text("", 0, 0);
	});
	ui.setWidget(CAPTURE_KEY, undefined);
	return captured;
}

export default function (pi: ExtensionAPI) {
	let state = loadState();
	let ui: ExtensionUIContext | undefined;
	let tui: TuiLike | undefined;
	let bar: StickyBar | undefined;
	let heal: ReturnType<typeof setInterval> | undefined;
	/** 告警只报一次，避免每帧刷屏（spec §4.6）。 */
	let warned = false;

	function warn(message: string): void {
		if (warned || ui === undefined) return;
		warned = true;
		ui.notify(`sticky-prompt: ${message}，吸顶行已停用。`, "warning");
	}

	/** 把当前开关状态落到布局上。返回是否改动过（改动过就补一帧）。 */
	function apply(): boolean {
		if (tui === undefined || bar === undefined) return false;
		return syncBar(tui.layoutRoot, bar, state.enabled);
	}

	function requestRender(): void {
		tui?.requestRender?.();
	}

	/**
	 * 巡检：根布局会在运行期被重建（比如用 /settings 切 tui-mode），重建后我们那条
	 * entry 就没了。而吸顶条一旦被摘掉就再也不会被渲染，自己发现不了——只能外面看一眼。
	 * 1 秒一次、只做「还在不在」的数组查找；在位时一次判断就返回。
	 */
	function startHeal(): void {
		if (heal !== undefined) return;
		heal = setInterval(() => {
			if (tui === undefined || bar === undefined) return;
			if (tui.mode !== "fullscreen") return;
			if (apply()) requestRender();
		}, HEAL_INTERVAL_MS);
		// 别让这个定时器把进程吊住
		heal.unref?.();
	}

	function stopHeal(): void {
		if (heal === undefined) return;
		clearInterval(heal);
		heal = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		tui = captureTui(ctx.ui);
		if (tui === undefined) return;

		// regular 模式没有布局系统，静默跳过（不算探针失败，不告警）。
		if (tui.mode !== "fullscreen") return;

		const check = probe(tui);
		if (!check.ok) {
			warn(check.reason ?? "布局结构不符");
			return;
		}

		// 正文读不到（Pi 改了字段名）时按结构异常报一次，而不是画一条空行糊过去。
		bar = new StickyBar(tui, () => ctx.ui.theme, (reason) => warn(reason));
		(bar as BarComponent)[BAR_MARK] = true;
		if (apply()) requestRender();
		startHeal();
	});

	pi.on("session_shutdown", async () => {
		stopHeal();
		// 摘干净再走，别把没人管的 entry 留在别人的布局里
		if (tui !== undefined && bar !== undefined) syncBar(tui.layoutRoot, bar, false);
		bar = undefined;
		ui = undefined;
		tui = undefined;
		warned = false;
	});

	pi.registerCommand(COMMAND, {
		description: "开关「上一次输入」吸顶行（仅全屏模式）",
		handler: async (_args, ctx) => {
			state = { enabled: !state.enabled };
			saveState(state);
			if (apply()) requestRender();
			ctx.ui.notify(state.enabled ? "sticky-prompt: 吸顶行已开启" : "sticky-prompt: 吸顶行已关闭", "info");
		},
	});
}
