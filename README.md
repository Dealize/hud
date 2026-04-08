# hud

基于 [claude-hud](https://github.com/jarrodwatts/claude-hud) 的 Claude Code statusLine 增强。一个 wrapper 把官方 HUD 包成多行密集信息面板。

## 截图

```
📁 hud │ 优化claude hub │ ⏱  2h 44m │ [Opus 4.6 (1M context)]
⏳  上下文 ░░░░░░░░░░ 19% │ 用量 ░░░ 13% 4h 31m │ 本周 ░░░░░ 49% 3d 23h
🛠  3/5 SubAgent | 8/10 Edit | 1/2 Bash │ 4 MCPs | 7 钩子 | 46 技能
📝 本次 97 · 今日 250 ↑↑ · 7日均 137 · 30日均 137 · 全部 4129
💬 本项目 10 · 今日 6 ↓ · 7日均 7 ↓ · 30日均 9 · 全部 265
⚡ 49/avg ｜ 75/本峰 ｜ 2035/史峰 ━━ 当前 31 tok/s  ░░░░░░▇▅█▅▃▇▇▄ ○
🪙 75.6M 总  in:1k  out:151k  cache:75.5M
```

## 功能

- **身份行**：项目（git 分支）│ 会话名 │ 时长 │ 模型，自动重排
- **额度监控**：上下文 / 5h 用量 / 7d 周用量，按阈值染色 + 倒计时
- **工具活动**：当前 turn 内的 `已完成/总数`，运行中亮黄、完成灰；含 SubAgent
- **指令统计**：本次 · 今日 · 7 日均 · 30 日均 · 全部，附趋势箭头 ↑↑/↑/↓/↓↓
- **会话统计**：本项目 · 今日 · 7 日均 · 30 日均 · 全部（只算有真人输入的 session）
- **token 速度**：avg / 本峰 / 史峰 / 当前 + 字符 sparkline + 混合刻度
- **token 总量**：total / in / out / cache 实时
- **自适应宽度**：≥160 列全 7 行；120–159 折叠中等；<120 紧凑只留身份
- **24h 全局缓存**：扫一次全 transcript 缓存一天，开会话不卡

## 安装

### 1. 前置依赖

| 工具 | 安装 |
|---|---|
| Node.js 20+ | https://nodejs.org/ 或 `brew install node` |
| Bun | `brew install oven-sh/bun/bun` 或 https://bun.sh/ |
| jq | `brew install jq` |

### 2. 安装上游 claude-hud（首次必须）

打开 Claude Code，依次执行：

```
/plugin marketplace add jarrodwatts/claude-hud
/plugin install claude-hud@claude-hud
```

退出 Claude Code 让 plugin 真正生效。

### 3. 装本仓库的 wrapper

```bash
git clone https://github.com/Dealize/hud.git
cd hud
./install.sh
```

或者一行：

```bash
git clone https://github.com/Dealize/hud.git && cd hud && ./install.sh
```

`install.sh` 会：
1. 检查依赖
2. 拷贝 `wrapper.mjs` 和 `config.json` 到 `~/.claude/plugins/claude-hud/`
3. 备份并修改 `~/.claude/settings.json` 注入 `statusLine` 指向 wrapper
4. 提示重启

### 4. 重启 Claude Code

```bash
# 在终端里
exit  # 退出当前 claude session
claude
```

HUD 应该出现在输入框下方。

## 配置

显示开关在 `~/.claude/plugins/claude-hud/config.json`：

```json
{
  "lineLayout": "expanded",
  "language": "zh",
  "display": {
    "showUsageLimits": true,
    "showDuration": true,
    "showConfigCounts": true,
    "showTools": true,
    "showAgents": false,
    ...
  }
}
```

支持的字段见 [claude-hud 官方文档](https://github.com/jarrodwatts/claude-hud)。

修改后无需重启，下次 statusLine 触发渲染就生效。

## 自定义提示

如果你想再改 HUD 内容，直接编辑 `~/.claude/plugins/claude-hud/wrapper.mjs`：

- 颜色调色板在文件顶部 `const C = {...}`
- 阈值染色函数 `threshColor(pct)`、`speedColor(v, peak)`
- 各行渲染分散在文件中段（claude-hud 输出后处理）和末尾（自定义行）

修改保存即生效，下次 HUD 触发就会重新跑 wrapper。

## 卸载

```bash
# 1. 删 wrapper 和配置
rm -rf ~/.claude/plugins/claude-hud/wrapper.mjs ~/.claude/plugins/claude-hud/config.json

# 2. 还原 settings.json（找最近的 .bak）
ls ~/.claude/settings.json.bak.* | tail -1 | xargs -I{} cp {} ~/.claude/settings.json

# 3. 可选：卸载上游 claude-hud
# 在 Claude Code 内执行：/plugin uninstall claude-hud@claude-hud
```

## 故障

- **HUD 不出现**：检查 `~/.claude/settings.json` 里 `statusLine.command` 路径是否对，run `node ~/.claude/plugins/claude-hud/wrapper.mjs < /dev/null` 看是否报错
- **窄终端折叠成 1 行**：终端 < 120 列时是预期行为，把窗口拉宽
- **tokens 行不显示**：检查 transcript 是否有 usage 字段（一般要先发一条消息让模型回复）
- **subagent 计数不更新**：只统计当前 turn 内的，发新 prompt 自动清零

## 致谢

- 底层：[jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud)
