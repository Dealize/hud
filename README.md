# hud

基于 [claude-hud](https://github.com/jarrodwatts/claude-hud) 的增强 statusLine wrapper。

## 功能

在官方 claude-hud 之上加了：

- **身份行重排 + tokens 简化**：`项目 │ 会话名 │ 时长 │ 模型 │ Tokens: N(in:.. out:..)`
- **工具活动合并**：`SubAgent | Edit | Bash | ... │ MCPs | 钩子 | 技能` 单行
- **计数语义**：`已完成/总数`，运行中橙色高亮；只统计**当前任务**（最近一条用户 prompt 之后）
- **指令统计**：本次 · 今日 · 7日均 · 30日均 · 全部，带趋势箭头 ↑↑/↑/↓/↓↓
- **会话统计**：本项目 · 今日 · 7日均 · 30日均 · 全部（只算有 ≥3 条 prompt 的人工创建 session）
- **token 生成速度**：`avg/本峰/史峰/当前 tok/s` + 混合刻度 sparkline
- **skills 数量**：扫 `SKILL.md` 统计已加载技能数
- **自适应分层**：≥160 列全量，120–159 中等，<120 紧凑（防窄终端折叠）
- **全局统计缓存 24h**，不每次全盘扫

## 安装

### 前置依赖

- **Node.js 20+**
- **Bun**（claude-hud 底层要）：https://bun.sh/
- **jq**：`brew install jq`
- **claude-hud 上游 plugin** —— 在 Claude Code 里运行：
  ```
  /plugin marketplace add jarrodwatts/claude-hud
  /plugin install claude-hud@claude-hud
  ```

### 一键安装

```bash
git clone https://github.com/Dealize/hud.git
cd hud
./install.sh
```

或：

```bash
curl -fsSL https://raw.githubusercontent.com/Dealize/hud/main/install.sh | bash
```

安装完重启 Claude Code。

## 文件

- `wrapper.mjs` —— 包裹 claude-hud 的增强 statusLine 脚本
- `config.json` —— claude-hud 显示配置（language:zh / compact layout / 扩展字段开关）
- `install.sh` —— 安装脚本

脚本会：
1. 拷贝 `wrapper.mjs` 和 `config.json` 到 `~/.claude/plugins/claude-hud/`
2. 在 `~/.claude/settings.json` 里注入 `statusLine` 指向 wrapper

## 卸载

1. 删除 `~/.claude/plugins/claude-hud/wrapper.mjs`
2. 从 `~/.claude/settings.json` 移除 `statusLine` 字段（或恢复 `.bak`）
3. （可选）`/plugin uninstall claude-hud` 卸载上游

## 致谢

- 底层：[jarrodwatts/claude-hud](https://github.com/jarrodwatts/claude-hud)
# hud
