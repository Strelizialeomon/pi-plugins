import { test } from "node:test";
import assert from "node:assert/strict";
import { imageExtension, paddedForCursor, pasteFromClipboard, type ClipboardReader } from "./clipboard-paste.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const BMP = new Uint8Array([0x42, 0x4d, 1, 2]);
const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 7]);
const UNKNOWN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** 记下每个方法被调了几次——用来断言「取到就停」。 */
function reader(parts: Partial<Record<"files" | "image" | "text", unknown>>) {
	const calls: string[] = [];
	const r: ClipboardReader = {
		async getFilePaths() { calls.push("files"); return parts.files as string[] | null | undefined; },
		async getImage() { calls.push("image"); return parts.image as Uint8Array | null | undefined; },
		async getText() { calls.push("text"); return parts.text as string | null | undefined; },
	};
	return { r, calls };
}

function harvester() {
	const written: Array<{ path: string; bytes: Uint8Array }> = [];
	return { written, writeFile: (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); } };
}

test("文件优先级最高：剪贴板里是文件时，只有路径被插入，图片与文本都不看", async () => {
	const { r, calls } = reader({ files: ["/tmp/a.png", "/tmp/b.txt"], image: PNG, text: "不该用到" });
	const out = await pasteFromClipboard({ reader: r });
	assert.deepEqual(out, { kind: "insert", text: "/tmp/a.png\n/tmp/b.txt" });
	assert.deepEqual(calls, ["files"]);
});

test("图片次之：落成临时文件后插入路径，文本不看", async () => {
	const { r, calls } = reader({ files: null, image: PNG, text: "不该用到" });
	const { written, writeFile } = harvester();
	const out = await pasteFromClipboard({ reader: r, writeFile, tmpDir: "/tmp/x", id: () => "abc" });
	assert.deepEqual(out, { kind: "insert", text: "/tmp/x/pi-clipboard-abc.png" });
	assert.deepEqual(calls, ["files", "image"]);
	assert.equal(written.length, 1);
	assert.deepEqual(written[0]!.bytes, PNG, "写出去的字节要和剪贴板里的一致");
});

test("文本最次：前面都没有才插文本", async () => {
	const { r, calls } = reader({ files: null, image: null, text: "一段文字" });
	assert.deepEqual(await pasteFromClipboard({ reader: r }), { kind: "insert", text: "一段文字" });
	assert.deepEqual(calls, ["files", "image", "text"]);
});

test("剪贴板啥也没有、或接口不可用：什么都不插，也不报错", async () => {
	const empty = reader({ files: null, image: null, text: null });
	assert.deepEqual(await pasteFromClipboard({ reader: empty.r }), { kind: "none" });
	assert.deepEqual(await pasteFromClipboard({ reader: undefined }), { kind: "none" });
});

test("剪贴板读取抛错：静默当作没有（别把卡片卡住）", async () => {
	const r: ClipboardReader = { async getFilePaths() { throw new Error("没有权限"); } };
	assert.deepEqual(await pasteFromClipboard({ reader: r }), { kind: "none" });
});

test("文件路径含控制字符：拒绝，且不插入任何东西", async () => {
	const { r } = reader({ files: ["/tmp/ok.png", "/tmp/坏\u001b[31m.png"] });
	const out = await pasteFromClipboard({ reader: r });
	assert.equal(out.kind, "error");
	assert.match((out as { message: string }).message, /控制字符/);
});

test("写临时文件失败：报错，不留半截路径", async () => {
	const { r } = reader({ image: JPEG });
	const out = await pasteFromClipboard({ reader: r, writeFile: () => { throw new Error("磁盘满了"); }, tmpDir: "/tmp/x", id: () => "z" });
	assert.equal(out.kind, "error");
	assert.match((out as { message: string }).message, /磁盘满了/);
});

test("图片格式按字节头认，认不出来落 png", () => {
	assert.equal(imageExtension(PNG), "png");
	assert.equal(imageExtension(JPEG), "jpg");
	assert.equal(imageExtension(GIF), "gif");
	assert.equal(imageExtension(WEBP), "webp");
	assert.equal(imageExtension(BMP), "bmp");
	assert.equal(imageExtension(TIFF), "tiff");
	assert.equal(imageExtension(UNKNOWN), "png");
	assert.equal(imageExtension(new Uint8Array()), "png", "空字节也得给个兜底");
});

test("插入点两侧不是空白时补空格，是空白就不补", () => {
	assert.equal(paddedForCursor("X", "a", "b"), " X ");
	assert.equal(paddedForCursor("X", " ", "b"), "X ");
	assert.equal(paddedForCursor("X", "a", " "), " X");
	assert.equal(paddedForCursor("X", "", ""), "X");
	assert.equal(paddedForCursor("X", "\n", " "), "X", "换行也算空白");
});
