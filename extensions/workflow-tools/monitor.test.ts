import { test } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter } from "./monitor.ts";

test("一次到达的完整行按行切开", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("a\nb\n"), ["a", "b"]);
});

test("末尾没有换行的残行先扣住，等下一块补齐", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("a\nb"), ["a"]);
	assert.deepEqual(splitter.push("c\n"), ["bc"]);
});

test("跨多个块才凑齐一行也能拼对", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("he"), []);
	assert.deepEqual(splitter.push("ll"), []);
	assert.deepEqual(splitter.push("o\n"), ["hello"]);
});

test("CRLF 的 \\r 被剥掉，不留在事件文本里", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("a\r\nb\r\n"), ["a", "b"]);
});

test("空块不产出事件", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push(""), []);
});

test("空行是合法事件（日志里的空行有意义）", () => {
	const splitter = new LineSplitter();
	assert.deepEqual(splitter.push("a\n\nb\n"), ["a", "", "b"]);
});

test("flush 交出最后那段没有换行的残行", () => {
	const splitter = new LineSplitter();
	splitter.push("a\nb");
	assert.equal(splitter.flush(), "b");
});

test("没有残行时 flush 返回 undefined", () => {
	const splitter = new LineSplitter();
	splitter.push("a\n");
	assert.equal(splitter.flush(), undefined);
});
