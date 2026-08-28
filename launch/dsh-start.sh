#!/bin/bash
# DeepSeek Harness 启动脚本（供 launchd 调用）
# 从受保护的 key 文件读取 DEEPSEEK_API_KEY 注入环境后启动
# 该脚本不含任何明文密钥

set -e

DSH_ROOT="/Users/mac/cow/apps/dsh"
KEY_FILE="$HOME/.dsh/api-key.env"
LOG_DIR="$DSH_ROOT/logs"
mkdir -p "$LOG_DIR"

# —— 端口守门（2026-08-20）：旧 DSH 进程残留占 3080 时，KeepAlive 会无限拉起→EADDRINUSE 崩溃循环。
# 启动前若 3080 被占：占用者是本服务旧 DSH → 等待/强杀让位；非 DSH 进程 → 退出交给 launchd 重试。 ——
PORT=3080
GUARD_LOG="$LOG_DIR/port-guard.log"

# —— 单实例保险（2026-08-20 修复崩溃循环）：若 3080 已被另一个 DSH node 进程监听，
# 说明发生并发拉起（如 kickstart 与 KeepAlive 竞态），当前实例自我退出让位，
# 不 kill 同伴、不抢端口，避免 EADDRINUSE 崩溃循环。 ——
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  HOLDER_PID=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$HOLDER_PID" ] && ps -p "$HOLDER_PID" -o command= 2>/dev/null | grep -q "bin.ts"; then
    echo "$(date '+%F %T') port $PORT already held by another DSH instance (pid=$HOLDER_PID); self-exit to avoid EADDRINUSE race" >> "$GUARD_LOG"
    exit 0
  fi
fi

for i in $(seq 1 12); do
  if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    break # 端口空闲
  fi
  HOLDER=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)
  HOLDER_CMD=$(ps -p "$HOLDER" -o command= 2>/dev/null || true)
  echo "$(date '+%F %T') port $PORT held by pid=$HOLDER cmd=${HOLDER_CMD:0:120}" >> "$GUARD_LOG"
  if echo "$HOLDER_CMD" | grep -q "dsh"; then
    if [ "$i" -eq 12 ]; then
      echo "$(date '+%F %T') killing stale dsh pid=$HOLDER" >> "$GUARD_LOG"
      kill -9 "$HOLDER" 2>/dev/null || true
      sleep 2
    else
      kill "$HOLDER" 2>/dev/null || true # 优雅退出窗口（最多 12×5s）
      sleep 5
    fi
  else
    echo "$(date '+%F %T') port $PORT held by non-dsh process; exiting for launchd retry" >> "$GUARD_LOG"
    exit 1
  fi
done

# 注入 DeepSeek API key（强制从 key 文件加载，避免 launchd 继承的旧 key 造成污染）
# 2026-08-14: 去掉 [ -z "$DEEPSEEK_API_KEY" ] 守卫 —— 否则 launchd 继承的失效 key
# 会让此处跳过加载，导致服务一直用旧 key。现在文件里是什么，服务就用什么。
if [ -f "$KEY_FILE" ]; then
  # shellcheck disable=SC2034
  source "$KEY_FILE"
fi

# 明确 PATH，避免 launchd 极简环境找不到工具
export PATH="/Users/mac/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
export HOME="/Users/mac"

cd "$DSH_ROOT" || exit 1

# 启动（前台，launchd 负责守护与日志）
exec /Users/mac/.local/bin/node --import tsx/esm apps/cli/src/bin.ts --profile web --port 3080
