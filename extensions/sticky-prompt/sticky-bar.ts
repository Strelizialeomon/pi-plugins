/**
 * 吸顶条组件：按当前滚动位置派生「显示谁」，并处理点击跳转。
 *
 * 这一层只做三件事：读 Pi 的布局、渲染一行、收点击。判定规则在 prompt-index.ts 里。
 *
 * 坐标约定（spec §4.0）：行号是 **ScrollView 滚动内容的绝对行号**，第 0 行是内容容器的
 * 首行（header），不是第一条聊天消息。区间也从第 0 行起算，header 高度天然含在内。
 *
 * ## 为什么没有缓存
 *
 * 每帧都**实测**每个内容块的高度，不缓存。这不是偷懒，是权衡后的选择：
 *
 * 缓存要正确，就得有一个「我缓的值已经过时了」的信号，而 Pi 不提供这种信号。
 * 布局帧里的内容总高（`scrollContentLines.length`）比当前帧晚一拍——`tui-alt-screen.js`
 * 里 `currentLayout` 是在 `renderLayoutFrame` **之后**才赋值的；拿它做校验和，遇到
 * 「非尾块长高」（展开工具输出、思考块显隐、资源区变化）会**滞后一帧**，而修正又要
 * 再来一帧。于是用户停在那儿不动读屏的整段时间里，吸顶条一直显示错的提问、点击跳到
 * 错的位置。这个功能存在的意义就是「显示对的那一条」，所以这里选正确性。
 *
 * 代价有界且可测：只在**已离开底部**时才走，而且是**从内容第 0 行往前累加、越过视口顶
 * 就早退**——越靠近底部越便宜，跟随末尾时一次都不渲染。这笔账记在 spec §10，
 * 由 §7.2 的真机实测来判。
 */

import {
	type Component,
	type ScrollView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { pickSticky, type StickySelection, type StickySource } from "./prompt-index.ts";

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
}

/** 探针结果（spec §4.6）：不满足就不注入，并且要告警。 */
export interface Probe {
	ok: boolean;
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

function childrenOf(component: Component | undefined): Component[] | undefined {
	const children = (component as { children?: unknown } | undefined)?.children;
	return Array.isArray(children) ? (children as Component[]) : undefined;
}

/**
 * 内容容器：`ScrollView` 构造时做过 `this.children.push(component)`，所以走**公开**的
 * `Container.children` 就取得到，不必碰它那个 TS private 的 `child`（spec §2.2）。
 */
function contentContainer(scrollView: ScrollView): Component | undefined {
	return childrenOf(scrollView)?.[0];
}

/**
 * 把一个内容区段摊成消息级：聊天区（含用户提问块的那个区段）摊开，消息块才认得出；
 * 其余区段整块算一个块。
 *
 * 摊不摊开不影响行号——`Container.render` 就是子节点顺序拼接，块数变了、高度之和不变
 * （spec §2.2 已核过这点，§4.0 的坐标系因此稳当）。
 */
function partsOf(section: Component): Component[] {
	const children = childrenOf(section);
	if (children !== undefined && children.some((child) => child instanceof UserMessageComponent)) {
		return children;
	}
	return [section];
}

/**
 * 探针（spec §4.6）：注入前确认结构是我们认得的形状。不满足就**不注入**并告警，
 * 而不是硬插进去静默画错。
 */
export function probe(tui: unknown): Probe {
	const root = (tui as AltScreenLike | undefined)?.layoutRoot;
	const entries = root?.entries;
	if (!Array.isArray(entries) || entries.length < 2) {
		return { ok: false, reason: "根布局结构不符（项数不足）" };
	}
	const scrollView = findTranscript(tui);
	if (scrollView === undefined) return { ok: false, reason: "找不到 primary transcript" };
	const container = contentContainer(scrollView);
	if (container === undefined) return { ok: false, reason: "内容容器取不到" };
	const sections = childrenOf(container);
	if (sections === undefined || sections.length === 0) {
		return { ok: false, reason: "内容容器结构不符（没有内容区段）" };
	}
	return { ok: true };
}

/**
 * 把组件树包成判定用的块来源。每帧重建一个轻量对象，别的一概不缓存。
 */
function sourceOf(
	scrollView: ScrollView,
	contentWidth: number,
	onAnomaly: (reason: string) => void,
): StickySource | undefined {
	const sections = childrenOf(contentContainer(scrollView) ?? undefined);
	if (sections === undefined) return undefined;

	// 元数据（是不是提问 / 正文）与测量分开：早退时后面的块连 rendering 都不用做。
	const parts: Component[] = [];
	const isPrompt: boolean[] = [];
	const texts: string[] = [];
	for (const section of sections) {
		for (const part of partsOf(section)) {
			parts.push(part);
			const prompt = part instanceof UserMessageComponent;
			isPrompt.push(prompt);
			const text = prompt ? promptText(part) : "";
			if (prompt && text === undefined) {
				// `UserMessageComponent` 认出来了、正文却读不到 = Pi 换了字段名。
				// 这时绝不能画一条空行糊过去——那看起来像「这条提问本来就是空的」。
				onAnomaly("提问题的正文读不到（UserMessageComponent.text 可能改名了）");
			}
			texts.push(text ?? "");
		}
	}

	return {
		count: () => parts.length,
		measure: (index) => {
			const part = parts[index];
			return part === undefined ? 0 : part.render(contentWidth).length;
		},
		describe: (index) => ({ isPrompt: isPrompt[index] === true, text: texts[index] ?? "" }),
	};
}

export class StickyBar implements Component {
	readonly #tui: unknown;
	/** 每次渲染都重新取主题：`ctx.ui.theme` 会随 /theme 换实例，捕获一次就跟不上了。 */
	readonly #getTheme: () => Theme;
	/** 本帧选中哪条，供点击用。 */
	#active: StickySelection | null = null;
	#activeScrollView: ScrollView | undefined;
	/** 结构异常上报（正文读不到这类）。只报一次，别每帧刷。 */
	readonly #onAnomaly: (reason: string) => void;
	#anomalyReported = false;

	constructor(tui: unknown, getTheme: () => Theme, onAnomaly: (reason: string) => void = () => {}) {
		this.#tui = tui;
		this.#getTheme = getTheme;
		this.#onAnomaly = onAnomaly;
	}

	render(width: number): string[] {
		const scrollView = findTranscript(this.#tui);
		this.#activeScrollView = scrollView;
		this.#active = null;
		if (scrollView === undefined) return [];

		// 跟随末尾时不显示：你正看着最新输出，不需要锚点（spec §4.1）。
		// 这一条也顺带避开了最贵的情形——贴着底部时「视口之上」几乎是全部内容。
		if (scrollView.isFollowingEnd) return [];

		const contentWidth = scrollView.getContentWidth(width);
		const source = sourceOf(scrollView, contentWidth, (reason) => {
			if (this.#anomalyReported) return;
			this.#anomalyReported = true;
			this.#onAnomaly(reason);
		});
		if (source === undefined) return [];

		// 摘要要给指示符让位，否则会撑破一行。
		const selection = pickSticky(source, scrollView.scrollTop, width - visibleWidth(PREFIX));
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
		scrollView.scrollTo(selection.start);
		this.#active = null;
		return { handled: true, render: true };
	}

	invalidate(): void {
		// 无缓存可清：每帧都是实测的。留在这里而不是删掉——Component 要求实现它。
	}
}

/**
 * 提问正文存在 `UserMessageComponent` 实例上。`.d.ts` 里是 `private text`，
 * 类型上读不到，只能运行时取（spec §2.3 / §10）。
 * 字段不在（或不是字符串）时返回 `undefined`，由调用方当结构异常报出去。
 */
function promptText(component: Component): string | undefined {
	const text = (component as { text?: unknown }).text;
	return typeof text === "string" ? text : undefined;
}
