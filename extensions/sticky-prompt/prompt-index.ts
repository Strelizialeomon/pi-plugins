/**
 * 吸顶行的判定与摘要 —— 纯逻辑，不碰 Pi 运行时，单测不用起 Pi。
 *
 * 坐标约定（spec §4.0）：所有行号都是 ScrollView **滚动内容的绝对行号**，
 * 第 0 行是内容容器的首行（header），不是第一条聊天消息。
 * 区间从第 0 行起算，所以 header 的高度天然含在内——不要另外补偏移量。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/** 选中的那条。 */
export interface StickySelection {
	/** 选中的块下标，调用方靠它取回组件 */
	index: number;
	/** 该块起始内容行（含） */
	start: number;
	/** 该块结束内容行（不含） */
	end: number;
	/** 压成一行、已按宽度截断的摘要 */
	text: string;
}

/**
 * 内容块来源。故意做成「问一次答一次」而不是先给一张表：
 * 高度必须**每帧实测**（见 sticky-bar.ts 文件头「为什么没有缓存」），
 * 而且早退要在测量之前就生效，所以只能按需去问。
 */
export interface StickySource {
	/** 内容块总数 */
	count(): number;
	/** 第 index 块渲染后的行数 */
	measure(index: number): number;
	/** 第 index 块是不是用户提问，以及它的正文（不是提问时正文无意义） */
	describe(index: number): { isPrompt: boolean; text: string };
}

function normalizeHeight(height: number): number {
	return Number.isFinite(height) && height > 0 ? Math.trunc(height) : 0;
}

/**
 * 把提问正文压成一行：取第一段 → 压平空白 → 按宽度截断。
 *
 * 归一化后为空、或以 `<` 开头（系统注入的包装内容）→ 返回 null，表示这条不作候选。
 */
export function summarize(text: string, width: number): string | null {
	if (!Number.isFinite(width) || width <= 0) return null;
	// 第一段 = 首个「空行」之前的部分。只含空格/制表的行也算空行。
	const firstParagraph = text.trim().split(/\n[^\S\n]*\n/)[0] ?? "";
	const flat = firstParagraph.replace(/\s+/g, " ").trim();
	if (flat === "" || flat.startsWith("<")) return null;
	return truncateToWidth(flat, Math.floor(width), "…");
}

/**
 * 选吸顶那条：从内容第 0 行往前累加，取**最后一个**「整条完全在视口顶之上」
 * （`end <= scrollTop`）且「摘要有内容」的提问。
 *
 * 两个要点：
 *
 * ① **早退**：游标一旦越过 `scrollTop`，后面所有块的起始行都更靠下，不可能再有
 *    `end <= scrollTop` 的块，立刻停。越靠底部走得越少；跟随末尾的情形由调用方
 *    在进来之前就挡掉了。
 *
 * ② **不被不可用的候选截断**：一条提问摘不出内容（系统注入 / 空）时要**继续往前找**，
 *    而不是就此返回 null——否则一条注入消息就能把吸顶行整条压掉。
 *    所以一路记「最后一个可用的候选」，而不是遇到第一个就返回。
 */
export function pickSticky(source: StickySource, scrollTop: number, width: number): StickySelection | null {
	const at = Math.max(0, Number.isFinite(scrollTop) ? Math.floor(scrollTop) : 0);
	const total = Math.max(0, Math.trunc(source.count()));
	let cursor = 0;
	let best: StickySelection | null = null;

	for (let index = 0; index < total; index++) {
		const start = cursor;
		cursor += normalizeHeight(source.measure(index));
		const { isPrompt, text } = source.describe(index);
		if (isPrompt && cursor <= at) {
			const summary = summarize(text, width);
			if (summary !== null) best = { index, start, end: cursor, text: summary };
		}
		if (cursor > at) break; // ① 早退
	}
	return best;
}
