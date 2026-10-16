/**
 * 吸顶条组件：按当前滚动位置派生「显示谁」，并处理点击跳转。
 *
 * 这一层只做三件事：读 Pi 的布局、渲染一行、收点击。判定规则全在 prompt-index.ts 里。
 *
 * 坐标约定（spec §4.0）：行号是 **ScrollView 滚动内容的绝对行号**，第 0 行是内容容器的
 * 首行（header），不是第一条聊天消息。区间表也从第 0 行起算，header 高度天然含在内。
 */

import {
	type Component,
	type ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getScrollViewBox } from "@earendil-works/pi-tui/dist/layout.js";
import { UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { buildIndex, pickSticky, totalHeight, type ContentBlock, type StickySelection } from "./prompt-index.ts";

/**
 * TuiAltScreen 上 TS 标了 private、运行时可达的字段（spec §2.1）。
 * 用结构化类型把它们说清楚，把类型逃逸收敛到这一处。
 */
interface StackEntryLike {
	component?: unknown;
}
interface AltScreenLike {
	mode?: string;
	layoutRoot?: { entries?: StackEntryLike[] };
	currentLayout?: unknown;
}

/** 探针结果（spec §4.6）：硬前提与软前提分开报，两者的处置不一样。 */
export interface Probe {
	/** 硬前提：根布局、transcript、内容容器都取得到。不满足就**不能**工作。 */
	hard: boolean;
	/** 软前提：校验和取得到。不满足只是**降级**，功能照旧。 */
	checksum: boolean;
	/** 失败原因，给告警文案用 */
	reason?: string;
}

/** 吸顶条的指示符。宽度按显示宽度算，不按字符数——`↑` 在部分字体里是双宽。 */
const PREFIX = "↑ ";

/** 取 transcript 那个 ScrollView：按 `primary === true` 认，不认固定下标。 */
function findTranscript(tui: unknown): ScrollView | undefined {
	const entries = (tui as AltScreenLike | undefined)?.layoutRoot?.entries;
	if (!Array.isArray(entries)) return undefined;
	for (const entry of entries) {
		const component = entry?.component as { primary?: boolean } | undefined;
		if (component?.primary === true) return component as unknown as ScrollView;
	}
	return undefined;
}

/**
 * 内容容器：`ScrollView` 构造时做过 `this.children.push(component)`，所以走**公开**的
 * `Container.children` 就取得到，不必碰它那个 TS private 的 `child`（spec §2.2）。
 */
function contentContainer(scrollView: ScrollView): Component | undefined {
	return (scrollView.children ?? [])[0];
}

/** 内容里是不是有用户提问块——用来认出哪个区段是聊天区（不认固定下标）。 */
function holdsPrompts(container: Component): boolean {
	const children = (container as { children?: Component[] }).children;
	return Array.isArray(children) && children.some((child) => child instanceof UserMessageComponent);
}

export function probe(tui: unknown): Probe {
	const scrollView = findTranscript(tui);
	if (scrollView === undefined) return { hard: false, checksum: false, reason: "找不到 primary transcript" };
	const container = contentContainer(scrollView);
	if (container === undefined) return { hard: false, checksum: false, reason: "内容容器取不到" };
	if (!Array.isArray((container as { children?: Component[] }).children)) {
		return { hard: false, checksum: false, reason: "内容容器结构不符" };
	}
	const frame = (tui as AltScreenLike).currentLayout;
	if (frame === undefined) return { hard: true, checksum: false, reason: "布局帧尚未生成（首帧正常）" };
	const lines = getScrollViewBox(frame as never, scrollView)?.scrollContentLines;
	if (lines === undefined) return { hard: true, checksum: false, reason: "布局帧里找不到内容行" };
	return { hard: true, checksum: true };
}

export class StickyBar implements Component {
	readonly #tui: unknown;
	/** 每次渲染都重新取主题：`ctx.ui.theme` 会随 /theme 换实例，捕获一次就跟不上了。 */
	readonly #getTheme: () => Theme;
	/** 组件高度缓存。键是组件身份，值是「哪个宽度下量出来的」。 */
	#heights = new WeakMap<Component, { width: number; height: number }>();
	/** 上一帧看到的组件序列。变了说明增删了内容块，缓存得作废。 */
	#signature: readonly Component[] = [];
	/** 上一次逐块算出来的总高。校验和要拿它跟**同一帧**的布局帧值比。 */
	#lastSum: number | undefined;
	/** 本帧选中哪条，供点击用。 */
	#active: StickySelection | null = null;
	#activeScrollView: ScrollView | undefined;

	constructor(tui: unknown, getTheme: () => Theme) {
		this.#tui = tui;
		this.#getTheme = getTheme;
	}

	render(width: number): string[] {
		const scrollView = findTranscript(this.#tui);
		this.#activeScrollView = scrollView;
		this.#active = null;
		if (scrollView === undefined) return [];

		// 跟随末尾时不显示：你正看着最新输出，不需要锚点（spec §4.1）。
		if (scrollView.isFollowingEnd) {
			this.#lastSum = undefined;
			return [];
		}

		const contentWidth = scrollView.getContentWidth(width);
		const blocks = this.#blocks(scrollView, contentWidth);
		// 摘要要给指示符让位，否则会撑破一行。
		const textWidth = width - visibleWidth(PREFIX);
		const selection = pickSticky(blocks, buildIndex(blocks), scrollView.scrollTop, textWidth);
		if (selection === null) return [];

		this.#active = selection;
		const theme = this.#getTheme();
		const line = theme.fg("muted", PREFIX) + theme.fg("accent", selection.text);
		// 撑满整行：右侧补空格。补的是无色空格，不做背景填充。
		return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 只认 click（按下 + 在同一组件上抬起）。press 就跳会让「按下后拖走」也触发。
		if (event.type !== "click" || event.button !== "left") return undefined;
		const selection = this.#active;
		const scrollView = this.#activeScrollView;
		if (selection === null || scrollView === undefined) return undefined;

		// 滚回那条提问的起始行，顶部对齐视口顶（spec §4.5）。
		// 跳完该提问进了视口，下一帧就不再是候选，吸顶条自己会消失——不需要额外抑制。
		scrollView.scrollTo(selection.interval.start);
		this.#active = null;
		return { handled: true, render: true };
	}

	invalidate(): void {
		// 主题变或宽度变都会让高度变，缓存一律作废。
		this.#heights = new WeakMap();
		this.#signature = [];
		this.#lastSum = undefined;
	}

	/** 把滚动内容摊成块序列，并在这一步做缓存与校验和。 */
	#blocks(scrollView: ScrollView, contentWidth: number): ContentBlock[] {
		const container = contentContainer(scrollView);
		if (container === undefined) return [];
		const sections = (container as { children?: Component[] }).children ?? [];

		// ① 先认结构：聊天区（含用户提问块的那个区段）要摊到消息级，其余区段整块算。
		const parts: Array<{ component: Component; prompts: boolean }> = [];
		for (const section of sections) {
			if (holdsPrompts(section)) {
				for (const child of (section as { children?: Component[] }).children ?? []) {
					parts.push({ component: child, prompts: true });
				}
			} else {
				parts.push({ component: section, prompts: false });
			}
		}

		// ② 结构变了就作废缓存（`addChild` 是原地 push，数组引用不变，只能比元素）。
		const signature = parts.map((part) => part.component);
		if (!sameComponents(signature, this.#signature)) {
			this.#heights = new WeakMap();
			this.#signature = signature;
			this.#lastSum = undefined;
		}

		// ③ 对账：布局帧是**上一帧**的（`tui-alt-screen.js:1547` 在 `renderLayoutFrame`
		//    之后才赋值 `currentLayout`），所以只能拿它跟「上一帧算出来的和」比，
		//    不能跟这一帧刚算的比——否则流式输出时每帧都会误判成缓存陈旧。
		const frame = (this.#tui as AltScreenLike).currentLayout;
		const contentLines = frame === undefined ? undefined : getScrollViewBox(frame as never, scrollView)?.scrollContentLines;
		if (contentLines !== undefined && this.#lastSum !== undefined && this.#lastSum !== contentLines.length) {
			this.#heights = new WeakMap();
		}

		// ④ 再量。最后一块**不缓存**：流式输出长高的就是它，缓存住会每帧都触发全量重算。
		const last = parts.length - 1;
		const blocks: ContentBlock[] = [];
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (part === undefined) continue;
			const height = index === last ? part.component.render(contentWidth).length : this.#measure(part.component, contentWidth);
			const isPrompt = part.prompts && part.component instanceof UserMessageComponent;
			blocks.push({
				height,
				isPrompt,
				text: isPrompt ? promptText(part.component) : "",
			});
		}
		this.#lastSum = totalHeight(blocks);
		return blocks;
	}

	#measure(component: Component, width: number): number {
		const hit = this.#heights.get(component);
		if (hit !== undefined && hit.width === width) return hit.height;
		const height = component.render(width).length;
		this.#heights.set(component, { width, height });
		return height;
	}
}

function sameComponents(a: readonly Component[], b: readonly Component[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * 提问正文存在 `UserMessageComponent` 实例上。`.d.ts` 里是 `private text`，
 * 类型上读不到，只能运行时取（spec §2.3 / §10）。取不到就当空串——那条会被
 * `summarize` 判成不可用而跳过，不会画出一条空行。
 */
function promptText(component: Component): string {
	const text = (component as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}
