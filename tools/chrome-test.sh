#!/bin/bash
# 安全无头 Chrome 调试封装：独立临时 profile + 专用 CDP 端口，绝不触碰主浏览器。
#
# 纪律（2026-07-29 主浏览器崩溃事故后定，违反任意一条都可能再搞崩用户的 Chrome）：
#   1) 任何 Chrome 启动都必须带 --user-data-dir=独立临时目录——后台上下文启动的
#      headless 若占用默认 profile，会持有 singleton 并让用户 GUI Chrome 激活时 SIGABRT。
#   2) CDP 端口用 --remote-debugging-port=0（系统随机分配，从 profile 的
#      DevToolsActivePort 读回），无任何固定端口概念——用户主 Chrome 持久开了
#      9222 调试端口，固定端口既有误占风险也会并发互撞。
#   3) 只杀本脚本 spawn 的 PID；禁止 pkill/pgrep/lsof 批量匹配杀 chrome——那会
#      连同用户正在用的 GUI 实例一起杀掉。
#
# 用法：
#   tools/chrome-test.sh shot "<url>" <out.png> [宽,高]   截图；TEST-* 日志打到 stdout
#   tools/chrome-test.sh cdp <probe.mjs> [参数...]        起 CDP 实例→node 跑探针→自动清理
set -u
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# 首跑/崩溃上报子进程会让 headless 退出拖沓，全部关掉
COMMON_FLAGS="--headless --enable-unsafe-swiftshader --no-first-run --no-default-browser-check --disable-breakpad --disable-crash-reporter --disable-crashpad-forwarding"

MODE="${1:?用法: chrome-test.sh shot|cdp ...}"
PROF=$(mktemp -d /tmp/ub-chrome.XXXXXX)
CHROME_PID=""
cleanup() {
  if [ -n "$CHROME_PID" ]; then kill "$CHROME_PID" 2>/dev/null; wait "$CHROME_PID" 2>/dev/null; fi
  # chrome 退出后仍可能有子进程写 profile，重试几次再放弃（/tmp 系统会清）
  for _ in 1 2 3 4; do rm -rf "$PROF" 2>/dev/null && break; sleep 0.5; done
}
trap cleanup EXIT

case "$MODE" in
  shot)
    URL="${2:?缺 url}"; OUT="${3:?缺输出 png}"; SIZE="${4:-1100,520}"
    # 日志写文件再 grep：crashpad 等子进程继承 stderr 会挂住管道，读文件不受此影响。
    # 不等 chrome 自行退出：它在这台机器上渲完 WebGL 页后经常不退（截图已落盘），
    # 改为等截图文件出现即杀自己 spawn 的实例（TEST-* 日志在页面求值期早于截图）。
    LOG="$PROF/chrome.log"
    "$CHROME" $COMMON_FLAGS --hide-scrollbars \
      --user-data-dir="$PROF" --window-size="$SIZE" \
      --virtual-time-budget=4000 --enable-logging=stderr --v=0 \
      --screenshot="$OUT" "$URL" >"$LOG" 2>&1 &
    CHROME_PID=$!
    for _ in $(seq 1 240); do [ -s "$OUT" ] && break; sleep 0.5; done
    sleep 1
    kill "$CHROME_PID" 2>/dev/null
    wait "$CHROME_PID" 2>/dev/null
    CHROME_PID=""
    cp "$LOG" /tmp/ub-last-shot.log 2>/dev/null || true # 排错留存（profile 退出即删）
    grep -oE 'TEST-[A-Z]+ \{.*\}' "$LOG" || true
    ;;
  cdp)
    SCRIPT="${2:?缺探针脚本}"
    "$CHROME" $COMMON_FLAGS \
      --user-data-dir="$PROF" --remote-debugging-port=0 \
      --disable-background-timer-throttling --disable-renderer-backgrounding \
      --disable-backgrounding-occluded-windows \
      --window-size=1100,520 about:blank >/dev/null 2>&1 &
    CHROME_PID=$!
    # 随机端口从 profile 的 DevToolsActivePort 读回（首行即端口号）
    PORT=""
    for _ in $(seq 1 30); do
      [ -s "$PROF/DevToolsActivePort" ] && { PORT=$(head -1 "$PROF/DevToolsActivePort"); break; }
      sleep 0.5
    done
    [ -z "$PORT" ] && { echo "Chrome 未写出 DevToolsActivePort" >&2; exit 1; }
    for _ in $(seq 1 30); do
      curl -s "http://localhost:$PORT/json/version" >/dev/null && break
      sleep 0.5
    done
    UB_CDP_PORT="$PORT" node "$SCRIPT" "${@:3}"
    ;;
  *) echo "未知模式: $MODE" >&2; exit 2 ;;
esac
