#!/bin/zsh
# 本机每日发现（launchd 调用）：两步路有头抓新轨迹 → 入库配对 → 自动提交推送 main，
# CI 周一只消费这份库存做离线轮换。必须在已登录图形界面的 Mac 上运行（有头浏览器过 WAF）。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
LOG="logs/discover-$(date +%F).log"

echo "===== $(date '+%F %T') discover start =====" >> "$LOG"
node scripts/fetch-routes.js --discover >> "$LOG" 2>&1
rc=$?
# 注意：变量不能叫 status——zsh 里 status 是只读特殊变量，赋值会直接中止整个脚本
if [ $rc -ne 0 ]; then
  echo "discover exited with $rc（库存保留，下次继续）" >> "$LOG"
fi

git add scripts/track-library.json public/photos/library 2>>"$LOG"
if ! git diff --cached --quiet 2>>"$LOG"; then
  git commit -m "chore(discover): 本机每日轨迹入库（$(date +%F)）" >> "$LOG" 2>&1
  git pull --rebase --autostash origin main >> "$LOG" 2>&1
  git push origin main >> "$LOG" 2>&1
  echo "synced to origin/main" >> "$LOG"
else
  echo "no new tracks, nothing to sync" >> "$LOG"
fi
echo "===== $(date '+%F %T') discover end =====" >> "$LOG"
