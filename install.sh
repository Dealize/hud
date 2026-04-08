#!/usr/bin/env bash
# claude-hud enhanced wrapper installer
# 用法：curl -fsSL https://raw.githubusercontent.com/Dealize/hud/main/install.sh | bash
set -e

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HUD_DIR="$CLAUDE_DIR/plugins/claude-hud"
REPO_RAW="https://raw.githubusercontent.com/Dealize/hud/main"

echo "==> 检查依赖"
command -v node >/dev/null || { echo "❌ 需要 Node.js (推荐 20+)"; exit 1; }
command -v bun >/dev/null || command -v /opt/homebrew/bin/bun >/dev/null || {
  echo "❌ 需要 Bun (https://bun.sh/) —— claude-hud 底层用它跑 TypeScript"; exit 1;
}
command -v jq >/dev/null || { echo "❌ 需要 jq (brew install jq)"; exit 1; }

echo "==> 1/4 安装 claude-hud 上游 plugin"
if [ ! -d "$CLAUDE_DIR/plugins/cache/claude-hud" ]; then
  echo "   请在 Claude Code 内依次运行："
  echo "     /plugin marketplace add jarrodwatts/claude-hud"
  echo "     /plugin install claude-hud@claude-hud"
  echo "   装完后再次运行本脚本"
  exit 1
fi

echo "==> 2/4 部署 wrapper.mjs + config.json"
mkdir -p "$HUD_DIR"
if [ -f "./wrapper.mjs" ]; then
  cp ./wrapper.mjs "$HUD_DIR/wrapper.mjs"
  cp ./config.json "$HUD_DIR/config.json"
else
  curl -fsSL "$REPO_RAW/wrapper.mjs" -o "$HUD_DIR/wrapper.mjs"
  curl -fsSL "$REPO_RAW/config.json" -o "$HUD_DIR/config.json"
fi
chmod +x "$HUD_DIR/wrapper.mjs"

echo "==> 3/4 写入 settings.json statusLine"
SETTINGS="$CLAUDE_DIR/settings.json"
NODE_BIN="$(command -v node)"
CMD="$NODE_BIN $HUD_DIR/wrapper.mjs"

if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi
# 备份
cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
# 注入 statusLine
TMP=$(mktemp)
jq --arg cmd "$CMD" '.statusLine = {"type": "command", "command": $cmd}' "$SETTINGS" > "$TMP"
mv "$TMP" "$SETTINGS"

echo "==> 4/4 完成 ✅"
echo ""
echo "重启 Claude Code 后 HUD 就会出现。"
echo "文件位置："
echo "  wrapper:  $HUD_DIR/wrapper.mjs"
echo "  config:   $HUD_DIR/config.json"
echo "  设置备份: $SETTINGS.bak.*"
