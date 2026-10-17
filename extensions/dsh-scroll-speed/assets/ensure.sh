#!/bin/sh
# dsh 滚轮补丁自愈：只在 App.js 变化时跑 node，平时是 stat + cat（~2ms）。
# 由 dst() 在启动前调用；dsh 升级/重装后第一次启动会自动补回。
DIR="$HOME/.dsh/patches/scroll-speed"
APP="$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ink/components/App.js"
STAMP="$DIR/stamp"
SKIP="$DIR/skip"

[ -f "$APP" ] || exit 0
[ -f "$DIR/patch.mjs" ] || exit 0

hash() { shasum -a 256 "$DIR/scroll-wheel-speed.js" 2>/dev/null | cut -c1-12; }
cur="$(stat -f '%m:%z' "$APP" 2>/dev/null || stat -c '%Y:%s' "$APP" 2>/dev/null):$(hash)"
[ -n "$cur" ] || exit 0

[ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$cur" ] && exit 0
[ -f "$SKIP" ] && [ "$(cat "$SKIP" 2>/dev/null)" = "$cur" ] && exit 0

if node "$DIR/patch.mjs" --ensure >/dev/null 2>&1; then
  cur="$(stat -f '%m:%z' "$APP" 2>/dev/null || stat -c '%Y:%s' "$APP" 2>/dev/null):$(hash)"
  printf '%s' "$cur" > "$STAMP"
  rm -f "$SKIP"
else
  printf '%s' "$cur" > "$SKIP"
  printf '%s\n' "[dsh-scroll] 这个 dsh-tui 版本的滚轮代码结构变了，本次跳过补丁（原厂手感）。" >&2
fi
exit 0
