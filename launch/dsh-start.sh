#!/bin/bash
# DeepSeek Harness 启动脚本（供 launchd 调用）
# 从受保护的 key 文件读取 DEEPSEEK_API_KEY 注入环境后启动
# 该脚本不含任何明文密钥

set -e

DSH_ROOT="/Users/mac/cow/apps/dsh"
KEY_FILE="$HOME/.dsh/api-key.env"
LOG_DIR="$DSH_ROOT/logs"
mkdir -p "$LOG_DIR"

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
