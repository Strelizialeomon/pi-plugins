import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ASSETS,
	hasHook,
	installAssets,
	installHook,
	parseStatus,
	readZshrc,
} from "./patcher.ts";

test("parseStatus 认得出 --status 的 key : value 输出", () => {
	const status = parseStatus(
		[
			"target : /Users/x/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui",
			"version: 0.15.0",
			"patched: yes",
			"helper : present",
			"backup : missing",
		].join("\n"),
	);
	assert.equal(status.version, "0.15.0");
	assert.equal(status.patched, true);
	assert.equal(status.helper, true);
	assert.equal(status.backup, false);
	assert.match(status.target ?? "", /dsh-tui$/);
});

test("parseStatus 忽略空行和不认识的行", () => {
	const status = parseStatus("\n  \nwhatever\npatched: no\n");
	assert.equal(status.patched, false);
	assert.equal(status.helper, undefined);
});

test("installAssets 把三个文件装到目标目录并给 ensure.sh 执行位", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-scroll-assets-"));
	try {
		const installed = installAssets(dir);
		assert.equal(installed.files.length, ASSETS.length);
		for (const name of ASSETS) assert.ok(existsSync(join(dir, name)), name);
		assert.match(readFileSync(join(dir, "scroll-wheel-speed.js"), "utf8"), /DSH_TUI_SCROLL_SLOW/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installHook 幂等：第二次返回 present，不重复追加", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-scroll-hook-"));
	const file = join(dir, "zshrc");
	try {
		writeFileSync(file, "export FOO=1\n");
		assert.equal(hasHook(file), false);
		assert.equal(installHook(file), "added");
		assert.equal(installHook(file), "present");
		const text = readZshrc(file);
		assert.equal(text.match(/dsh-scroll-speed >>>/g)?.length, 1);
		assert.match(text, /ensure\.sh/);
		assert.ok(text.startsWith("export FOO=1"), "不破坏已有内容");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("zshrc 不存在时 readZshrc 返回空串而不是抛错", () => {
	assert.equal(readZshrc(join(tmpdir(), "dsh-scroll-does-not-exist", "zshrc")), "");
});
