#!/usr/bin/env bash
# hud 配置工具
# 用法：./configure.sh subscription 100
set -e

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="$CLAUDE_DIR/plugins/claude-hud/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "❌ 未找到配置文件: $CONFIG"
  echo "   请先运行 ./install.sh"
  exit 1
fi

command -v jq >/dev/null || { echo "❌ 需要 jq (brew install jq)"; exit 1; }

usage() {
  echo "用法: ./configure.sh <命令> [参数]"
  echo ""
  echo "命令:"
  echo "  subscription <金额>    设置月订阅费用（USD），如: ./configure.sh subscription 100"
  echo "  expiration <日期>      设置订阅到期日期，如: ./configure.sh expiration 2026-12-31"
  echo "  show                   显示当前配置"
  echo "  set <key> <value>      设置任意配置项，如: ./configure.sh set language en"
  echo "  display <key> <bool>   切换显示开关，如: ./configure.sh display showGit false"
  echo ""
  echo "配置文件: $CONFIG"
}

case "${1:-}" in
  subscription|sub)
    if [ -z "${2:-}" ]; then
      current=$(jq -r '.subscription // 200' "$CONFIG")
      echo "当前订阅: \$$current/月"
      echo "用法: ./configure.sh subscription <金额>"
      exit 0
    fi
    amount="$2"
    if ! echo "$amount" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      echo "❌ 金额必须是数字，如: 200 或 19.99"
      exit 1
    fi
    TMP=$(mktemp)
    jq --argjson v "$amount" '.subscription = $v' "$CONFIG" > "$TMP"
    mv "$TMP" "$CONFIG"
    echo "✅ 订阅已设为 \$$amount/月"
    ;;

  show)
    echo "📄 $CONFIG"
    echo ""
    jq '.' "$CONFIG"
    ;;

  set)
    if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
      echo "用法: ./configure.sh set <key> <value>"
      exit 1
    fi
    key="$2"
    value="$3"
    TMP=$(mktemp)
    # 尝试作为 JSON 值解析，失败则当字符串
    if echo "$value" | jq -e '.' >/dev/null 2>&1; then
      jq --argjson v "$value" --arg k "$key" '.[$k] = $v' "$CONFIG" > "$TMP"
    else
      jq --arg v "$value" --arg k "$key" '.[$k] = $v' "$CONFIG" > "$TMP"
    fi
    mv "$TMP" "$CONFIG"
    echo "✅ $key = $value"
    ;;

  display)
    if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
      echo "用法: ./configure.sh display <key> <true|false>"
      echo ""
      echo "可用开关:"
      jq -r '.display // {} | to_entries[] | "  \(.key) = \(.value)"' "$CONFIG"
      exit 0
    fi
    key="$2"
    val="$3"
    if [ "$val" != "true" ] && [ "$val" != "false" ]; then
      echo "❌ 值必须是 true 或 false"
      exit 1
    fi
    TMP=$(mktemp)
    jq --arg k "$key" --argjson v "$val" '.display[$k] = $v' "$CONFIG" > "$TMP"
    mv "$TMP" "$CONFIG"
    echo "✅ display.$key = $val"
    ;;

  expiration|exp)
    if [ -z "${2:-}" ]; then
      current=$(jq -r '.subscriptionExpiration // "未设置"' "$CONFIG")
      echo "当前到期日期: $current"
      echo "用法: ./configure.sh expiration <YYYY-MM-DD>"
      exit 0
    fi
    date_val="$2"
    if ! echo "$date_val" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "❌ 日期格式错误，应为 YYYY-MM-DD，如: 2026-12-31"
      exit 1
    fi
    TMP=$(mktemp)
    jq --arg v "$date_val" '.subscriptionExpiration = $v' "$CONFIG" > "$TMP"
    mv "$TMP" "$CONFIG"
    echo "✅ 订阅到期日期已设为 $date_val"
    ;;

  help|--help|-h)
    usage
    ;;

  *)
    usage
    exit 1
    ;;
esac
