/**
 * Other 行的剪贴板粘贴：把「剪贴板里有什么」翻成「该往正文里插什么」。
 *
 * 行为照 Pi 主输入框（`interactive-mode.js` 的 `handleClipboardPaste`）：
 * 文件用原路径、图片落临时文件后插路径、其余插文本。
 * 这一层不碰终端、不碰卡片——剪贴板读写与落盘都从参数注入，单测直接跑。
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 只用到这三个方法；与 pi-tui 的 `NativeClipboard` 结构兼容。 */
export interface ClipboardReader {
	getFilePaths?(): Promise<string[] | null | undefined>;
	getImage?(): Promise<Uint8Array | null | undefined>;
	getText?(): Promise<string | null | undefined>;
}

export interface PasteDeps {
	/** 读剪贴板；传 `undefined` 表示这台机器没有可用的剪贴板接口。 */
	reader: ClipboardReader | undefined;
	/** 落盘；测试注入假的，不真写文件。 */
	writeFile?: (path: string, bytes: Uint8Array) => void;
	/** 临时目录；默认 `os.tmpdir()`。 */
	tmpDir?: string;
	/** 文件名里的随机段；测试注入固定值。 */
	id?: () => string;
}

export type PasteOutcome =
	/** `source` 说明这份内容从哪一级取到——宿主只给文件路径补空格，卡片按它区分。 */
	| { kind: "insert"; text: string; source: "files" | "image" | "text" }
	| { kind: "none" }
	| { kind: "error"; message: string };

/** 路径里出现控制字符就整批拒绝——不能把终端转义带进正文（照宿主做法）。 */
function hasControlChars(text: string): boolean {
	return /\p{Cc}/u.test(text);
}

/**
 * 从字节头认图片格式。
 * pi-tui 的 `getImage()` 只给字节、不给 mime（宿主内部那份带 mime 的读取器没从包根导出），
 * 所以这里按魔数认；认不出来按 `png` 存，与宿主的兜底一致。
 */
export function imageExtension(bytes: Uint8Array): string {
	const at = (offset: number, signature: number[]) => signature.every((value, i) => bytes[offset + i] === value);
	if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
	if (at(0, [0x47, 0x49, 0x46, 0x38])) return "gif";
	if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
	if (at(0, [0x42, 0x4d])) return "bmp";
	if (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a]) || at(0, [0x49, 0x49, 0x2b, 0x00])) return "tiff"; // 末一个是 BigTIFF
	return "png";
}

/**
 * 按「文件路径 → 图片字节 → 纯文本」取一次；取到就停。
 * 剪贴板接口不可用、读失败、内容为空，一律当作「什么都没发生」——宿主也是静默吞掉剪贴板错误。
 */
export async function pasteFromClipboard(deps: PasteDeps): Promise<PasteOutcome> {
	const reader = deps.reader;
	if (!reader) return { kind: "none" };

	try {
		const paths = await reader.getFilePaths?.();
		if (paths && paths.length > 0) {
			if (paths.some(hasControlChars)) return { kind: "error", message: "剪贴板里的文件路径含控制字符，已拒绝。" };
			return { kind: "insert", text: paths.join("\n"), source: "files" };
		}

		const image = await reader.getImage?.();
		if (image && image.length > 0) {
			const name = `pi-clipboard-${(deps.id ?? randomUUID)()}.${imageExtension(image)}`;
			const file = join(deps.tmpDir ?? tmpdir(), name);
			try {
				(deps.writeFile ?? writeFileSync)(file, image);
			} catch (error) {
				return { kind: "error", message: `写临时图片失败：${error instanceof Error ? error.message : String(error)}` };
			}
			return { kind: "insert", text: file, source: "image" };
		}

		const text = await reader.getText?.();
		if (typeof text === "string" && text.length > 0) return { kind: "insert", text, source: "text" };
		return { kind: "none" };
	} catch {
		// 剪贴板读取失败（没权限、后端缺失、超时）静默忽略，别把卡片卡住。
		return { kind: "none" };
	}
}

/** 插入点两侧不是空白时补空格，免得路径和前后文粘成一个词（照宿主做法）。 */
export function paddedForCursor(text: string, before: string, after: string): string {
	const lead = before && !/\s/.test(before) ? " " : "";
	const trail = after && !/\s/.test(after) ? " " : "";
	return `${lead}${text}${trail}`;
}
