#!/usr/bin/env node
/**
 * dsh 滚轮补丁（持久化版）
 *
 * 真正运行的代码在 profile 副本：
 *   ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui
 * 这个脚本负责把它补上 / 修好 / 还原。
 *
 * 用法：
 *   patch.mjs --ensure    幂等：已补则只同步 helper；没补则补上（失败不破坏，返回 2）
 *   patch.mjs --status    看当前状态
 *   patch.mjs --revert    还原成原厂
 *   patch.mjs --target DIR
 *
 * 退出码：0 成功/无需处理；2 版本不兼容（App.js 结构变了），已保持原样。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ensure = args.includes("--ensure");
const revert = args.includes("--revert");
const status = args.includes("--status");
const targetArg = args.includes("--target") ? args[args.indexOf("--target") + 1] : null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join("@deepseek-harness-tui", "dsh-tui");

function die(msg, code = 1) {
  console.error(`[dsh-scroll] ${msg}`);
  process.exit(code);
}

function candidates() {
  const list = [];
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  list.push(path.join(home, "profiles", "dsh-tui", "node_modules", PKG));
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 3000 }).trim();
    list.push(path.join(root, PKG));
  } catch {}
  return list;
}

function resolveTarget() {
  if (targetArg) return path.resolve(targetArg);
  for (const c of candidates()) {
    if (fs.existsSync(path.join(c, "lib/types/ink/components/App.js"))) return c;
  }
  die("找不到 dsh-tui 安装目录", 2);
}

const target = resolveTarget();
const appPath = path.join(target, "lib/types/ink/components/App.js");
const helperPath = path.join(target, "lib/types/ink/components/scroll-wheel-speed.js");
const backupDir = path.join(target, ".scroll-speed-backup");
const backup = path.join(backupDir, "App.js.orig");
const templatePath = path.join(HERE, "scroll-wheel-speed.js");

if (!fs.existsSync(appPath)) die(`App.js 不存在：${appPath}`, 2);

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

if (status) {
  const src = fs.readFileSync(appPath, "utf8");
  console.log(`target : ${target}`);
  console.log(`version: ${version()}`);
  console.log(`patched: ${src.includes("scroll-wheel-speed.js") ? "yes" : "no"}`);
  console.log(`helper : ${fs.existsSync(helperPath) ? "present" : "missing"}`);
  console.log(`backup : ${fs.existsSync(backup) ? "present" : "missing"}`);
  process.exit(0);
}

if (revert) {
  if (!fs.existsSync(backup)) die("没有备份可还原");
  fs.copyFileSync(backup, appPath);
  if (fs.existsSync(helperPath)) fs.rmSync(helperPath);
  console.log(`[dsh-scroll] 已还原 ${target}`);
  process.exit(0);
}

const src = fs.readFileSync(appPath, "utf8");

// 已打过补丁：只保证 helper 是最新版（升级 dsh 后 App.js 被换掉时不会走到这里）
if (src.includes("scroll-wheel-speed.js")) {
  const tpl = fs.readFileSync(templatePath, "utf8");
  if (!fs.existsSync(helperPath) || fs.readFileSync(helperPath, "utf8") !== tpl) {
    fs.writeFileSync(helperPath, tpl);
  }
  process.exit(0);
}

const IMPORT_LINE = 'import { wheelStep as __dshWheelStep } from "./scroll-wheel-speed.js";\n';
const VARIANT_A = /const step = \(item\.name === "wheelup" \|\| item\.name === "wheelleft"\) \? -3 : 3;/;
const VARIANT_B = /\/\/ One model:[\s\S]*?const step = Math\.max\(-20, Math\.min\(20, paid\)\);/;

let patched;
if (VARIANT_B.test(src)) {
  patched = src.replace(
    VARIANT_B,
    [
      'const dir = (item.name === "wheelup" || item.name === "wheelleft") ? -1 : 1;',
      "const rows = __dshWheelStep(dir);",
      "if (rows === 0) {",
      "    continue;",
      "}",
      "const step = Math.max(-20, Math.min(20, rows));",
    ].join("\n")
  );
} else if (VARIANT_A.test(src)) {
  patched = src.replace(
    VARIANT_A,
    'const step = __dshWheelStep(item.name === "wheelup" || item.name === "wheelleft" ? -1 : 1);'
  );
} else {
  die(`版本 ${version()} 的滚轮代码结构变了，未修改（保持原厂）。请更新补丁。`, 2);
}

fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(backup)) fs.copyFileSync(appPath, backup);
fs.writeFileSync(helperPath, fs.readFileSync(templatePath, "utf8"));
fs.writeFileSync(appPath, IMPORT_LINE + patched);

try {
  execFileSync("node", ["--check", appPath], { stdio: "pipe" });
  execFileSync("node", ["--check", helperPath], { stdio: "pipe" });
} catch (err) {
  fs.copyFileSync(backup, appPath);
  if (fs.existsSync(helperPath)) fs.rmSync(helperPath);
  die(`语法检查失败，已回滚：${err.stderr ?? err.message}`, 2);
}

if (!ensure) console.log(`[dsh-scroll] 已打补丁：${target} (v${version()})`);
process.exit(0);
