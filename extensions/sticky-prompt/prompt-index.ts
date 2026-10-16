/**
 * 吸顶行的判定与摘要 —— 纯逻辑，不碰 Pi 运行时，单测不用起 Pi。
 *
 * 坐标约定（spec §4.0）：所有行号都是 ScrollView **滚动内容的绝对行号**，
 * 第 0 行是内容容器的首行（header），不是第一条聊天消息。
 * 区间表也从第 0 行起算，所以 header 的高度天然含在内——不要另外补偏移量。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/** 一个内容块：渲染后的行数 + 是不是用户提问 + 提问正文（仅 isPrompt 时有效）。 */
export interface ContentBlock {
	height: number;
	isPrompt: boolean;
	text: string;
}

/**
 * 一条用户提问占的内容行区间 `[start, end)`。
 * `block` 是它在 blocks 里的下标，调用方靠它取回组件。
 */
export interface PromptInterval {
	block: number;
	start: number;
	end: number;
}

/** 选中结果。 */
export interface StickySelection {
	/** 在 intervals 里的下标 */
	index: number;
	interval: PromptInterval;
	/** 压成一行、已按宽度截断的摘要 */
	text: string;
}

function normalizeHeight(height: number): number {
	return Number.isFinite(height) && height > 0 ? Math.trunc(height) : 0;
}

/**
 * 逐块累加高度，得出每条用户提问的行区间。
 * 高度为 0 的块不产生区间（它占不了行，也就谈不上「滚出视口」）。
 */
export function buildIndex(blocks: readonly ContentBlock[]): PromptInterval[] {
	const intervals: PromptInterval[] = [];
	let cursor = 0;
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (block === undefined) continue;
		const height = normalizeHeight(block.height);
		if (block.isPrompt && height > 0) {
			intervals.push({ block: index, start: cursor, end: cursor + height });
		}
		cursor += height;
	}
	return intervals;
}

/** 所有块的高度之和。用来跟布局帧报的内容高度对账，验自己有没有算歪。 */
export function totalHeight(blocks: readonly ContentBlock[]): number {
	let sum = 0;
	for (const block of blocks) {
		if (block !== undefined) sum += normalizeHeight(block.height);
	}
	return sum;
}

/**
 * 把提问正文压成一行：取第一段 → 压平空白 → 按宽度截断。
 *
 * 归一化后为空、或以 `<` 开头（系统注入的包装内容）→ 返回 null，表示这条不作候选。
 */
export function summarize(text: string, width: number): string | null {
	if (!Number.isFinite(width) || width <= 0) return null;
	// 第一段 = 首个「空行」之前的部分。行内只有空格/制表不算空行。
	const firstParagraph = text.trim().split(/\n[^\S\n]*\n/)[0] ?? "";
	const flat = firstParagraph.replace(/\s+/g, " ").trim();
	if (flat === "" || flat.startsWith("<")) return null;
	return truncateToWidth(flat, Math.floor(width), "…");
}

/**
 * 选吸顶那一条：从最近的一条往远找，第一条同时满足
 * ① 整条完全在视口顶之上（`end <= scrollTop`）
 * ② 摘要有内容（`summarize` 不返回 null）
 * 的提问中选。
 *
 * 顺序很重要：②不满足时要**继续往上找**，而不是就此返回 null——
 * 否则一条系统注入的消息就能把吸顶行整条压掉。
 */
export function pickSticky(
	blocks: readonly ContentBlock[],
	intervals: readonly PromptInterval[],
	scrollTop: number,
	width: number,
): StickySelection | null {
	// scrollTop 是内容坐标，可能是小数（滚动补偿会带小数），取整后再比。
	const at = Math.max(0, Math.floor(scrollTop));
	for (let index = intervals.length - 1; index >= 0; index--) {
		const interval = intervals[index];
		if (interval === undefined || interval.end > at) continue;
		const block = blocks[interval.block];
		const text = summarize(block?.text ?? "", width);
		if (text === null) continue;
		return { index, interval, text };
	}
	return null;
}
