#!/usr/bin/env node
import { spawnSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const localDate = (iso) => {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 检测终端宽度：直接走父进程链找真实 tty（忽略 Claude Code 子进程 pipe 内的小值）
function detectTerminalWidth() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 6; i++) {
      const tty = execSync(`ps -o tty= -p ${pid} 2>/dev/null || true`).toString().trim();
      if (tty && tty !== '??' && tty !== '?') {
        const size = execSync(`stty size < /dev/${tty} 2>/dev/null || true`).toString().trim();
        const cols = parseInt(size.split(/\s+/)[1], 10);
        if (cols > 0) return cols;
      }
      const parent = execSync(`ps -o ppid= -p ${pid} 2>/dev/null || true`).toString().trim();
      const nextPid = parseInt(parent, 10);
      if (!nextPid || nextPid === pid || nextPid <= 1) break;
      pid = nextPid;
    }
  } catch {}
  // 兜底：subprocess 内部的 stdout/stderr/env
  if (process.stdout?.columns) return process.stdout.columns;
  if (process.stderr?.columns) return process.stderr.columns;
  if (process.env.COLUMNS && +process.env.COLUMNS > 0) return +process.env.COLUMNS;
  return 0;
}
// 宽度缓存 TTL=60s，避免每次渲染都跑 ps/stty 拖慢 statusLine
const widthCachePath = (process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`) + '/plugins/claude-hud/width.cache';
let cached = null;
try {
  const raw = readFileSync(widthCachePath, 'utf8').trim().split(',');
  const w = parseInt(raw[0], 10);
  const ts = parseInt(raw[1], 10);
  if (w >= 60 && ts && Date.now() - ts < 60_000) cached = w;
} catch {}

let rawWidth;
if (cached) {
  rawWidth = cached;
} else {
  const detected = detectTerminalWidth();
  let stale = 0;
  try { stale = parseInt(readFileSync(widthCachePath, 'utf8').split(',')[0], 10) || 0; } catch {}
  rawWidth = detected >= 60 ? detected : (stale >= 60 ? stale : 120);
  if (detected >= 60) {
    try { writeFileSync(widthCachePath, `${detected},${Date.now()}`); } catch {}
  }
}
const termWidth = Math.max(40, rawWidth - 4);

try {
  const h = process.stdout?.rows || 0;
  const line = `${new Date().toISOString()}  w=${rawWidth} h=${h} ppid=${process.ppid}\n`;
  writeFileSync((process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`) + '/plugins/claude-hud/debug.log', line, { flag: 'a' });
} catch {}
// 自适应分层：≥80 全量，<80 压缩
const tier = rawWidth >= 80 ? 'full' : 'compact';

// 颜色调色板
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightCyan: '\x1b[96m',
  brightYellow: '\x1b[93m',
  brightGreen: '\x1b[92m',
  brightMagenta: '\x1b[95m',
};
const wrap = (color, s) => `${color}${s}${C.reset}`;
// 数值阈值染色：低=绿、中=黄、高=红
const threshColor = (pct) => pct >= 80 ? C.red : pct >= 60 ? C.yellow : pct >= 30 ? C.brightCyan : C.green;
// 速度染色：高=亮黄、中=青、低=蓝
const speedColor = (v, peak) => {
  if (peak <= 0) return C.dim;
  const r = v / peak;
  return r >= 0.7 ? C.brightYellow : r >= 0.3 ? C.brightCyan : C.blue;
};

// API 定价（$/MTok）— https://platform.claude.com/docs/about-claude/pricing
const PRICING = {
  'opus-4.6':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, inputLong: 10, outputLong: 37.5 },
  'opus-4.5':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, inputLong: 10, outputLong: 37.5 },
  'opus-4.1':   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'opus-4':     { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, inputLong: 6, outputLong: 22.5 },
  'sonnet-4.5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, inputLong: 6, outputLong: 22.5 },
  'sonnet-4':   { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'haiku-4.5':  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'haiku-3.5':  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

function detectModelKey(str) {
  if (!str) return 'opus-4.6';
  const s = str.toLowerCase().replace(/[-_]/g, '.');
  if (/opus.*4\.6/.test(s))   return 'opus-4.6';
  if (/opus.*4\.5/.test(s))   return 'opus-4.5';
  if (/opus.*4\.1/.test(s))   return 'opus-4.1';
  if (/opus.*4(?!\.\d)/.test(s)) return 'opus-4';
  if (/sonnet.*4\.6/.test(s)) return 'sonnet-4.6';
  if (/sonnet.*4\.5/.test(s)) return 'sonnet-4.5';
  if (/sonnet.*4(?!\.\d)/.test(s)) return 'sonnet-4';
  if (/haiku.*4\.5/.test(s))  return 'haiku-4.5';
  if (/haiku.*3\.5/.test(s))  return 'haiku-3.5';
  return 'opus-4.6';
}

function calcEntryCost(usage, modelKey) {
  const p = PRICING[modelKey] || PRICING['opus-4.6'];
  const M = 1_000_000;
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const totalInput = inp + cacheRead + cacheWrite;
  const isLong = totalInput > 200_000 && p.inputLong;
  const inRate = isLong ? p.inputLong : p.input;
  const outRate = isLong ? (p.outputLong || p.output) : p.output;
  return (inp * inRate + out * outRate + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / M;
}

const fmtUSD = (v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${v.toFixed(0)}` : v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`;

// 中美假日集合（提前构建，供 renderClock 使用）
const _curYear = new Date().getFullYear();
const CN_HOLIDAYS = new Set([...buildCNHolidays(_curYear), ...buildCNHolidays(_curYear + 1)]);
const US_HOLIDAYS = new Set([...buildUSHolidays(_curYear), ...buildUSHolidays(_curYear + 1)]);

// ANSI 工具
const stripAnsiGlobal = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const visLen = s => stripAnsiGlobal(s).length;
// 右侧追加：紧跟左内容后面用加粗分隔符拼接，超宽则丢弃右侧
const rightAppend = (left, right) => {
  if (!right) return left;
  const sep = '\x1b[37m\x1b[1m ┃ \x1b[0m';
  if (visLen(left) + 3 + visLen(right) > termWidth) return left;
  return left + sep + right;
};

// ANSI-aware 截断：保留不可见转义序列，截断可见字符到 maxWidth
function truncateLine(line, maxWidth) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (visible >= maxWidth) { i++; continue; }
    out += ch;
    visible++;
    i++;
  }
  return out + '\x1b[0m';
}

// 包装 stdout.write：自动按行截断到终端宽度
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString();
  const trailingNL = s.endsWith('\n');
  const lines = (trailingNL ? s.slice(0, -1) : s).split('\n');
  const fixed = lines.map(l => truncateLine(l, termWidth)).join('\n') + (trailingNL ? '\n' : '');
  return realWrite(fixed, ...rest);
};

const input = readFileSync(0, 'utf8');
let meta = {};
try { meta = JSON.parse(input); } catch {}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// 读取配置（subscription 可在 config.json 中自定义）
const hudConfigPath = join(claudeDir, 'plugins/claude-hud/config.json');
let hudConfig = {};
try { hudConfig = JSON.parse(readFileSync(hudConfigPath, 'utf8')); } catch {}
const SUBSCRIPTION_MONTHLY = hudConfig.subscription || 200;

// 1) 跑原生 claude-hud
const cacheDir = join(claudeDir, 'plugins/cache/claude-hud/claude-hud');
let pluginDir = '';
try {
  const versions = readdirSync(cacheDir)
    .filter(v => /^\d+(\.\d+)+$/.test(v))
    .sort((a, b) => a.split('.').map(Number).reduce((d, n, i) => d || n - b.split('.').map(Number)[i], 0));
  pluginDir = join(cacheDir, versions[versions.length - 1]);
} catch {}

// 统计「当前任务」工具使用：从最近一条用户 prompt 开始，不回溯历史
function countToolUsage() {
  const result = { subagent: { running: 0, total: 0 }, tools: {}, bgShells: { running: 0, total: 0 } };
  if (!meta.transcript_path || !existsSync(meta.transcript_path)) return result;

  let entries = [];
  try {
    entries = readFileSync(meta.transcript_path, 'utf8').split('\n').filter(Boolean);
  } catch { return result; }

  // 向后找最近一条用户手动输入（非 tool_result、非 sidechain）的索引
  let turnStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(entries[i]);
      if (j.type !== 'user' || j.isSidechain === true) continue;
      const c = j.message?.content;
      const isToolResult = Array.isArray(c) && c.some(x => x?.type === 'tool_result');
      const isText = typeof c === 'string' || (Array.isArray(c) && c.some(x => x?.type === 'text'));
      if (!isToolResult && isText) { turnStart = i; break; }
    } catch {}
  }

  const idToName = new Map();
  const finished = new Set();
  for (let i = turnStart; i < entries.length; i++) {
    try {
      const j = JSON.parse(entries[i]);
      const content = j.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === 'tool_use' && c.id) idToName.set(c.id, c.name);
        if (c?.type === 'tool_result' && c.tool_use_id && idToName.has(c.tool_use_id)) finished.add(c.tool_use_id);
      }
    } catch {}
  }

  // 当前 turn 的普通工具
  for (const [id, name] of idToName) {
    const isDone = finished.has(id);
    if (name === 'Task' || name === 'Agent') continue; // SubAgent 改为全 transcript 统计
    if (!result.tools[name]) result.tools[name] = { running: 0, total: 0 };
    result.tools[name].total++;
    if (!isDone) result.tools[name].running++;
  }

  // SubAgent + 背景 shell：扫全 transcript（跨 turn 持久）
  const agentIds = new Map(); // id → done?
  let bgStarted = 0, bgKilled = 0;
  for (const line of entries) {
    try {
      const j = JSON.parse(line);
      const content = j.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === 'tool_use') {
          if ((c.name === 'Task' || c.name === 'Agent') && c.id) agentIds.set(c.id, false);
          if (c.name === 'Bash' && c.input?.run_in_background === true) bgStarted++;
          if (c.name === 'KillShell' || c.name === 'KillBash') bgKilled++;
        }
        if (c?.type === 'tool_result' && c.tool_use_id && agentIds.has(c.tool_use_id)) {
          agentIds.set(c.tool_use_id, true);
        }
      }
    } catch {}
  }
  for (const done of agentIds.values()) {
    result.subagent.total++;
    if (!done) result.subagent.running++;
  }
  result.bgShells.total = bgStarted;
  result.bgShells.running = Math.max(0, bgStarted - bgKilled);
  return result;
}

let tokensLine = '';

function findBun(){try{return execSync("command -v bun 2>/dev/null").toString().trim()||null}catch{}for(const p of ["/opt/homebrew/bin/bun","/usr/local/bin/bun",homedir()+"/.bun/bin/bun"]){if(existsSync(p))return p}return null}
const bunPath=findBun();

if (pluginDir && bunPath) {
  const r = spawnSync(bunPath, ['--env-file', '/dev/null', join(pluginDir, 'src/index.ts')], {
    input,
    env: { ...process.env, COLUMNS: '500' },
    encoding: 'utf8',
  });
  if (r.stdout) {
    const skills = countSkills();
    const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = r.stdout.replace(/\n$/, '').split('\n');

    // 重排身份行：模型 │ 项目 │ session │ 时长  →  📁 项目 │ ✏️ session │ ⏱ 时长 │ 🤖 模型
    const idIdx = lines.findIndex(l => /\[.+\].*│/.test(stripAnsi(l)));
    if (idIdx >= 0) {
      const rawParts = lines[idIdx].split(/\s*│\s*/);
      // 取出各部分（重新染色）
      let projectPart = '', sessionPart = '', timePart = '', modelPart = '';
      for (const p of rawParts) {
        const s = stripAnsi(p).trim();
        if (/\[.+\]/.test(s)) modelPart = s;
        else if (/⏱/.test(s)) timePart = s.replace(/⏱️?\s*/, '');
        else if (!projectPart) projectPart = s;
        else if (!sessionPart) sessionPart = s;
      }
      const idParts = [];
      if (projectPart) idParts.push(`📁 ${wrap(C.dim, '项目')}  ${wrap(C.brightCyan, projectPart)}`);
      if (sessionPart) idParts.push(wrap(C.dim, sessionPart));
      // 当前 turn 的 API 等待时间（差分计算）
      const totalApiMs = meta.cost?.total_api_duration_ms || 0;
      if (totalApiMs > 0) {
        const sid = meta.session_id || '';
        const apiStatePath = join(claudeDir, 'plugins/claude-hud/api-turn.json');
        let apiState = {};
        try { apiState = JSON.parse(readFileSync(apiStatePath, 'utf8')); } catch {}
        const prev = apiState[sid] || { baseMs: 0, promptCount: 0 };
        const curPrompts = meta.transcript_path ? parseTranscript(meta.transcript_path).prompts.length : 0;
        if (curPrompts !== prev.promptCount) {
          prev.baseMs = totalApiMs;
          prev.promptCount = curPrompts;
        }
        apiState[sid] = prev;
        try { writeFileSync(apiStatePath, JSON.stringify(apiState)); } catch {}
        const turnMs = Math.max(0, totalApiMs - prev.baseMs);
        const sec = Math.floor(turnMs / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const fmt = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
        idParts.push(`⏱  ${wrap(C.brightMagenta, fmt)}`);
      }
      if (modelPart) idParts.push(wrap(C.cyan, modelPart));
      lines[idIdx] = idParts.join(wrap(C.dim, ' │ '));
    }

    // Xh Ym → X:YY 的格式化（保留 d 天前缀）
    const fmtHM = (raw) => {
      const t = raw.trim();
      // 含天：3d 22h → 3d 22:00 ? 简单：保留 d，把后面 h m 转成冒号
      const dM = t.match(/^(\d+d)\s*(.*)$/);
      const prefix = dM ? `${dM[1]} ` : '';
      const rest = dM ? dM[2] : t;
      const hm = rest.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/);
      if (!hm || (!hm[1] && !hm[2])) return t;
      const h = hm[1] || '0';
      const m = (hm[2] || '0').padStart(2, '0');
      return `${prefix}${h}:${m}`;
    };

    // 倒计时：去掉「重置剩余」和括号，转格式
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i]
        .replace(/\(\s*重置剩余\s*([^)]+?)\s*\)/g, (_, t) => wrap(C.dim, fmtHM(t)))
        .replace(/\(\s*resets?\s+in\s+([^)]+?)\s*\)/gi, (_, t) => wrap(C.dim, fmtHM(t)));
    }

    // 上下文进度条：50% real = 100% visual，染色按质量线
    const contextThresh = (pct) => pct >= 50 ? C.red + C.bold : pct >= 45 ? C.red : pct >= 40 ? C.brightYellow : pct >= 25 ? C.brightCyan : C.green;
    const rescaleContextBar = (line) => {
      // 重绘上下文进度条：把 50% 映射成满格
      const s = stripAnsi(line);
      const m = s.match(/上下文.*?(\d+(?:\.\d+)?)\s*%/);
      if (!m) return line;
      const realPct = parseFloat(m[1]);
      const effectivePct = Math.min(100, Math.round(realPct * 2)); // 50% real = 100%
      const barLen = 10;
      const filled = Math.min(barLen, Math.round((effectivePct / 100) * barLen));
      const barColor = contextThresh(realPct);
      const bar = wrap(barColor, '█'.repeat(filled)) + wrap(C.dim, '░'.repeat(barLen - filled));
      // 替换原有进度条和百分比
      return line
        .replace(/[░▓█▁▂▃▄▅▆▇]+/g, '') // 去掉原 bar
        .replace(new RegExp(`${m[1]}\\s*%`), `${bar} ${wrap(barColor + C.bold, realPct + '%')}`);
    };
    const recolorAllPct = (line) => {
      return line.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => {
        const pct = parseFloat(n);
        return wrap(threshColor(pct) + C.bold, `${n}%`);
      });
    };

    // 估算剩余可用轮数
    let remainTurnsStr = '';
    {
      const ctxPct = meta.context_window?.used_percentage || 0;
      const ctxSize = meta.context_window?.context_window_size || 0;
      if (ctxPct >= 10 && ctxSize > 0 && meta.transcript_path && existsSync(meta.transcript_path)) {
        // 计算最近 10 轮每轮 token 消耗中位数
        const tLines = readFileSync(meta.transcript_path, 'utf8').split('\n').filter(Boolean);
        const turnTokens = [];
        let turnStart = 0;
        let inTurn = false;
        for (const line of tLines) {
          try {
            const j = JSON.parse(line);
            if (j.type === 'user' && j.isSidechain !== true) {
              const c = j.message?.content;
              const isTR = Array.isArray(c) && c.some(x => x?.type === 'tool_result');
              const isText = typeof c === 'string' || (Array.isArray(c) && c.some(x => x?.type === 'text'));
              if (!isTR && isText) { turnStart = 0; inTurn = true; }
            }
            if (inTurn && j.message?.usage) {
              const u = j.message.usage;
              // 只算 output + cache_creation（真正新增到 context 的部分）
              turnStart += (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
            }
            // turn 结束：assistant 有 stop_reason
            if (inTurn && j.type === 'assistant' && j.message?.stop_reason === 'end_turn') {
              if (turnStart > 0) turnTokens.push(turnStart);
              turnStart = 0;
              inTurn = false;
            }
          } catch {}
        }
        if (turnTokens.length >= 5) {
          const recent = turnTokens.slice(-10);
          const sorted = [...recent].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          const remaining = Math.max(0, (50 - ctxPct) / 100 * ctxSize);
          const estTurns = median > 0 ? Math.floor(remaining / median) : 0;
          if (ctxPct >= 50) {
            remainTurnsStr = wrap(C.red + C.bold, ' 已超质量线 建议新开');
          } else if (ctxPct >= 45) {
            remainTurnsStr = `${wrap(C.red, ` ~剩${estTurns}轮`)} ${wrap(C.red + C.bold, '建议新开')}`;
          } else if (ctxPct >= 40) {
            remainTurnsStr = wrap(C.brightYellow, ` ~剩${estTurns}轮`);
          } else {
            remainTurnsStr = wrap(C.dim, ` ~剩${estTurns}轮`);
          }
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (i === idIdx) continue;
      const s = stripAnsi(lines[i]);
      if (/上下文|context/i.test(s) && !/用量|usage|本周|weekly/i.test(s)) {
        // 纯上下文行：重绘 bar + 追加剩余轮数
        lines[i] = `⏳ ${wrap(C.dim, '额度')}  ${rescaleContextBar(lines[i])}${remainTurnsStr}`;
      } else if (/上下文.*用量|上下文.*本周/i.test(s) || /context.*usage/i.test(s)) {
        // 合并行（上下文 + 用量 + 本周）：上下文部分重绘，其他保留
        lines[i] = `⏳ ${wrap(C.dim, '额度')}  ${rescaleContextBar(recolorAllPct(lines[i]))}${remainTurnsStr}`;
      } else if (/用量|usage|本周|weekly/i.test(s)) {
        lines[i] = `⏳ ${wrap(C.dim, '额度')}  ${recolorAllPct(lines[i])}`;
      }
    }

    // 抽出 tokens 行（带 cache），稍后插到末尾
    const tokIdx = lines.findIndex(l => /Tokens\s+[\d.]/.test(stripAnsi(l)));
    if (tokIdx >= 0) {
      const raw = stripAnsi(lines[tokIdx]);
      const N = '([\\d.]+[kKmMgG]?)';
      const m = raw.match(new RegExp(`Tokens\\s+${N}\\s*\\(in:\\s*${N},\\s*out:\\s*${N}(?:,\\s*cache:\\s*${N})?`));
      if (m) {
        const [, total, inTok, outTok, cacheTok] = m;
        tokensLine = `🪙 ${wrap(C.dim, 'Token')}  ${wrap(C.brightYellow + C.bold, total)} ${wrap(C.dim, '总')}  ${wrap(C.dim, 'in:')}${wrap(C.cyan, inTok)}  ${wrap(C.dim, 'out:')}${wrap(C.green, outTok)}${cacheTok ? `  ${wrap(C.dim, 'cache:')}${wrap(C.brightMagenta, cacheTok)}` : ''}`;
      }
      lines.splice(tokIdx, 1);
    }

    // 找 MCPs/钩子 行索引
    const envIdx = lines.findIndex(l => /钩子|MCPs|hooks/.test(stripAnsi(l)));
    // 找活动行索引（以 ✓/◐/× 等标记开头，或包含 ×N 字样）
    const activityIdxs = [];
    for (let i = 0; i < lines.length; i++) {
      const s = stripAnsi(lines[i]).trim();
      if (/^[✓◐✗×]/.test(s) || /[✓◐]\s+\w+\s+×\d+/.test(s)) activityIdxs.push(i);
    }

    // env 行：🛠 SubAgent | 工具计数 │ MCPs | 钩子 | 技能
    if (envIdx >= 0) {
      const usage = countToolUsage();
      const prefixParts = [];
      const renderTool = (name, running, total) => {
        const done = total - running;
        // 运行中→亮黄；全完成→灰；纯数字部分用亮青突出
        if (running > 0) {
          return `${wrap(C.brightYellow + C.bold, `${done}/${total}`)} ${wrap(C.yellow, name)}`;
        }
        return `${wrap(C.brightCyan, `${done}/${total}`)} ${wrap(C.dim, name)}`;
      };
      const { running: sRunning, total: sTotal } = usage.subagent;
      if (sTotal > 0) prefixParts.push(renderTool('SubAgent', sRunning, sTotal));
      const { running: bgRunning, total: bgTotal } = usage.bgShells;
      if (bgTotal > 0) prefixParts.push(renderTool('BgShell', bgRunning, bgTotal));
      // 所有 mcp__ 工具合并成单个 mcp 桶
      const merged = {};
      for (const [name, stats] of Object.entries(usage.tools)) {
        const key = /^mcp__/.test(name) ? 'mcp' : name;
        if (!merged[key]) merged[key] = { running: 0, total: 0 };
        merged[key].running += stats.running;
        merged[key].total += stats.total;
      }
      const toolEntries = Object.entries(merged).sort((a, b) => b[1].total - a[1].total);
      for (const [name, { running, total }] of toolEntries) {
        prefixParts.push(renderTool(name, running, total));
      }
      const sep = wrap(C.dim, ' | ');
      const bigSep = wrap(C.dim, ' │ ');
      const prefix = prefixParts.length > 0 ? prefixParts.join(sep) + bigSep : '';

      // 重新染色 claude-hud 自带的 MCPs/钩子 段
      const envRaw = stripAnsi(lines[envIdx]);
      const envParts = [];
      const mcpsM = envRaw.match(/(\d+)\s*MCPs/);
      const hooksM = envRaw.match(/(\d+)\s*钩子/);
      if (mcpsM) envParts.push(`${wrap(C.brightCyan, mcpsM[1])} ${wrap(C.dim, 'MCPs')}`);
      if (hooksM) envParts.push(`${wrap(C.brightCyan, hooksM[1])} ${wrap(C.dim, '钩子')}`);
      envParts.push(`${wrap(C.brightCyan, String(skills))} ${wrap(C.dim, '技能')}`);

      lines[envIdx] = `🛠  ${wrap(C.dim, '工具')}  ${prefix}${envParts.join(sep)}`;
      // 删除 claude-hud 自带的活动行
      for (const i of activityIdxs.slice().reverse()) lines.splice(i, 1);
    }

    // ⏰ 时钟不再追加到工具行（改到速度行右侧）

    // compact: 只留身份行，且把身份行削到只剩项目名（避免被截断成半个字）
    let finalLines = lines;
    if (tier === 'compact') {
      if (idIdx >= 0) {
        // 只留 📁 项目部分
        const s = stripAnsi(lines[idIdx]);
        const m = s.match(/📁\s*([^│]+)/);
        if (m) {
          finalLines = [`📁 ${wrap(C.brightCyan, m[1].trim())}`];
        } else {
          finalLines = [lines[idIdx]];
        }
      } else {
        finalLines = lines.slice(0, 1);
      }
    } else if (tier === 'medium') {
      // medium: 身份行（削短：项目 + 时长）+ env 行 + 上下文行
      if (idIdx >= 0) {
        const s = stripAnsi(lines[idIdx]);
        const proj = s.match(/📁\s*([^│]+)/)?.[1]?.trim() || '';
        const time = s.match(/⏱\s*([^│]+)/)?.[1]?.trim() || '';
        const parts = [];
        if (proj) parts.push(`📁 ${wrap(C.brightCyan, proj)}`);
        if (time) parts.push(`⏱  ${wrap(C.brightMagenta, time)}`);
        lines[idIdx] = parts.join(wrap(C.dim, ' │ '));
      }
      const keep = [0];
      // 上下文行（如果存在且不是身份行）
      const ctxIdx = lines.findIndex((l, i) => i !== idIdx && /上下文|context/i.test(stripAnsi(l)));
      if (ctxIdx > 0) keep.push(ctxIdx);
      if (envIdx >= 0 && !keep.includes(envIdx)) keep.push(envIdx);
      finalLines = [...new Set(keep)].sort((a, b) => a - b).map(i => lines[i]).filter(Boolean);
    }

    process.stdout.write(finalLines.join('\n') + '\n');
  }
}

function countSkills() {
  let n = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p, depth + 1);
        else if (name === 'SKILL.md') n++;
      } catch {}
    }
  };
  walk(join(claudeDir, 'skills'));
  walk(join(claudeDir, 'plugins/cache'));
  return n;
}

// 2) 解析单文件：只统计「人工创建的 session」+ 费用
//    判定：有至少一条 isSidechain=false + user + 真文本（非 tool_result）
function parseTranscript(file) {
  const prompts = [];
  const hours = [];
  let totalCost = 0;
  const costByDate = {};
  let model = null;
  if (!existsSync(file)) return { prompts, hours, userCreatedTs: null, cost: 0, costByDate };
  let userCreatedTs = null;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        // 检测模型
        if (!model && j.message?.model) model = detectModelKey(j.message.model);
        // 累计费用
        const u = j.message?.usage;
        if (u) {
          const c = calcEntryCost(u, model || 'opus-4.6');
          totalCost += c;
          const d = j.timestamp ? localDate(j.timestamp) : localDate(new Date());
          costByDate[d] = (costByDate[d] || 0) + c;
        }
        // 统计人工对话
        if (j.type !== 'user') continue;
        if (j.isSidechain === true) continue;  // 跳过 subagent 侧链
        const content = j.message?.content;
        const isText = typeof content === 'string'
          || (Array.isArray(content) && content.some(c => c?.type === 'text'));
        const isToolResult = Array.isArray(content) && content.some(c => c?.type === 'tool_result');
        if (isToolResult || !isText) continue;
        if (!userCreatedTs) userCreatedTs = j.timestamp;
        prompts.push(j.timestamp);
        if (j.timestamp) { try { hours.push(new Date(j.timestamp).getHours()); } catch {} }
      } catch {}
    }
  } catch {}
  return { prompts, hours, userCreatedTs, cost: totalCost, costByDate };
}

const currentSessionParsed = meta.transcript_path ? parseTranscript(meta.transcript_path) : { prompts: [], cost: 0 };
const sessionCount = currentSessionParsed.prompts.length;
const sessionCost = currentSessionParsed.cost;

// 3) 全局统计（缓存 24h，包含按日桶）
const cachePath = join(claudeDir, 'plugins/claude-hud/cache.json');
const DAY = 86400_000;
let cache = {};
try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}

// 新会话首次触发 → 强制刷新缓存；同一会话内走 24h 缓存
const currentSid = meta.session_id || '';
const sameSession = cache.lastSid === currentSid;
let stats;
if (cache.stats && cache.ts && sameSession && Date.now() - cache.ts < DAY) {
  stats = cache.stats;
} else {
  stats = { promptBuckets: {}, sessionBuckets: {}, costBuckets: {}, hourBuckets: new Array(24).fill(0), weekdayBuckets: new Array(7).fill(0), globalPrompts: 0, globalSessions: 0 };
  const projectsDir = join(claudeDir, 'projects');
  if (existsSync(projectsDir)) {
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        try {
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else if (name.endsWith('.jsonl')) {
            const { prompts, hours, userCreatedTs, costByDate } = parseTranscript(p);
            if (!userCreatedTs || prompts.length < 3) continue;
            stats.globalPrompts += prompts.length;
            stats.globalSessions++;
            for (const t of prompts) {
              if (!t) continue;
              const d = localDate(t);
              stats.promptBuckets[d] = (stats.promptBuckets[d] || 0) + 1;
            }
            const sd = localDate(userCreatedTs);
            stats.sessionBuckets[sd] = (stats.sessionBuckets[sd] || 0) + 1;
            for (const [d, c] of Object.entries(costByDate)) {
              stats.costBuckets[d] = (stats.costBuckets[d] || 0) + c;
            }
            for (const h of hours) {
              stats.hourBuckets[h] = (stats.hourBuckets[h] || 0) + 1;
            }
            for (const t of prompts) {
              if (!t) continue;
              const dow = new Date(t).getDay();
              stats.weekdayBuckets[dow] = (stats.weekdayBuckets[dow] || 0) + 1;
            }
          }
        } catch {}
      }
    };
    walk(projectsDir);
  }
  try { writeFileSync(cachePath, JSON.stringify({ stats, ts: Date.now(), lastSid: currentSid })); } catch {}
}

// 聚合桶 → 今日/7日均/30日均
function aggregate(buckets) {
  const now = new Date();
  const today = localDate(now);
  let t7 = 0, t30 = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = localDate(d);
    const v = buckets[key] || 0;
    if (i < 7) t7 += v;
    t30 += v;
  }
  return {
    today: buckets[today] || 0,
    avg7: Math.round(t7 / 7),
    avg30: Math.round(t30 / 30),
  };
}

const pAgg = aggregate(stats.promptBuckets);
const sAgg = aggregate(stats.sessionBuckets);
const globalCount = stats.globalPrompts;
const globalSessions = stats.globalSessions;

// 今日数据实时计算（只扫今天 mtime 的文件）
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
let todayPromptsLive = 0, todaySessionsLive = 0, todayCostLive = 0;
const projectsDirLive = join(claudeDir, 'projects');
if (existsSync(projectsDirLive)) {
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (name.endsWith('.jsonl') && s.mtime >= todayStart) {
          const { prompts, userCreatedTs, costByDate } = parseTranscript(p);
          if (!userCreatedTs || prompts.length < 3) continue;
          const todayStr = localDate(todayStart);
          for (const t of prompts) {
            if (t && localDate(t) === todayStr) todayPromptsLive++;
          }
          if (localDate(userCreatedTs) === todayStr) todaySessionsLive++;
          todayCostLive += costByDate[todayStr] || 0;
        }
      } catch {}
    }
  };
  walk(projectsDirLive);
}
pAgg.today = todayPromptsLive;
sAgg.today = todaySessionsLive;

// 月度费用聚合：缓存中非今日 + 今日实时
const todayStr = localDate(new Date());
const monthPrefix = todayStr.slice(0, 7); // "YYYY-MM"
let monthlyCost = 0;
for (const [d, c] of Object.entries(stats.costBuckets || {})) {
  if (d.startsWith(monthPrefix) && d !== todayStr) monthlyCost += c;
}
monthlyCost += todayCostLive;
const profitLoss = monthlyCost - SUBSCRIPTION_MONTHLY;

// 🔥 连续天数 (Streak)
function calcStreak() {
  const merged = { ...stats.sessionBuckets };
  const tk = localDate(new Date());
  if (todaySessionsLive > 0) merged[tk] = todaySessionsLive;
  const hasToday = (merged[tk] || 0) > 0;
  let streak = 0;
  const now = new Date();
  for (let i = hasToday ? 0 : 1; i < 365; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    if ((merged[localDate(d)] || 0) > 0) streak++; else break;
  }
  return streak;
}
function calcMaxStreak() {
  const merged = { ...stats.sessionBuckets };
  const tk = localDate(new Date());
  if (todaySessionsLive > 0) merged[tk] = todaySessionsLive;
  const dates = Object.keys(merged).filter(d => merged[d] > 0).sort();
  if (dates.length === 0) return 0;
  let max = 1, cur = 1;
  for (let i = 1; i < dates.length; i++) {
    const diff = Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
    if (diff === 1) { cur++; if (cur > max) max = cur; } else { cur = 1; }
  }
  return max;
}
const streak = calcStreak();
const maxStreak = calcMaxStreak();

// 📊 24h 时段热力图
function renderHeatmap() {
  const hb = stats.hourBuckets || new Array(24).fill(0);
  const maxH = Math.max(...hb, 1);
  const blocks = '▁▂▃▄▅▆▇█';
  // 找出峰值小时
  let peakHour = 0;
  for (let i = 1; i < 24; i++) { if (hb[i] > hb[peakHour]) peakHour = i; }
  const bar = hb.map(v => {
    if (v === 0) return wrap(C.dim, '░');
    const idx = Math.max(0, Math.min(blocks.length - 1, Math.ceil((v / maxH) * blocks.length) - 1));
    const color = v / maxH >= 0.7 ? C.brightYellow : v / maxH >= 0.3 ? C.brightCyan : C.blue;
    return wrap(color, blocks[idx]);
  }).join('');
  return `${wrap(C.dim, '0h')}${bar}${wrap(C.dim, '23h')} ${wrap(C.brightYellow, String(peakHour) + '点')}${wrap(C.dim, '最忙')}`;
}

// 📅 近14天活跃热力图（滚动）
function renderWeeklyHeatmap() {
  const now = new Date();
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const blocks = '▁▂▃▄▅▆▇█';
  const days = [];
  // 合并 promptBuckets 做每日总量
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = localDate(d);
    days.push({ count: (stats.promptBuckets || {})[key] || 0, dow: d.getDay() });
  }
  const maxD = Math.max(...days.map(d => d.count), 1);
  let peakIdx = 0;
  for (let i = 1; i < days.length; i++) { if (days[i].count > days[peakIdx].count) peakIdx = i; }
  const bar = days.map(({ count }) => {
    if (count === 0) return wrap(C.dim, '░');
    const idx = Math.max(0, Math.min(blocks.length - 1, Math.ceil((count / maxD) * blocks.length) - 1));
    const color = count / maxD >= 0.7 ? C.brightYellow : count / maxD >= 0.3 ? C.brightCyan : C.blue;
    return wrap(color, blocks[idx]);
  }).join('');
  const peakDay = new Date(now); peakDay.setDate(peakDay.getDate() - (13 - peakIdx));
  const peakLabel = `周${dayNames[peakDay.getDay()]}`;
  return `${bar} ${wrap(C.brightYellow, peakLabel)}${wrap(C.dim, '最忙')}`;
}

// ⏰ 当前时间 + 中美工作状态
// 浮动美国假日计算
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  let date = 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, date);
}
function lastMonday(year, month) {
  const last = new Date(year, month + 1, 0);
  return new Date(year, month, last.getDate() - ((last.getDay() + 6) % 7));
}
function buildUSHolidays(y) {
  const s = new Set();
  const add = d => s.add(localDate(d));
  add(new Date(y, 0, 1));  add(new Date(y, 5, 19)); add(new Date(y, 6, 4));
  add(new Date(y, 10, 11)); add(new Date(y, 11, 25));
  add(nthWeekday(y, 0, 1, 3));  // MLK
  add(nthWeekday(y, 1, 1, 3));  // Presidents
  add(lastMonday(y, 4));         // Memorial
  add(nthWeekday(y, 8, 1, 1));  // Labor
  add(nthWeekday(y, 9, 1, 2));  // Columbus
  add(nthWeekday(y, 10, 4, 4)); // Thanksgiving
  return s;
}
function buildCNHolidays(y) {
  const s = new Set();
  const addRange = (m, d1, d2) => { for (let d = d1; d <= d2; d++) s.add(localDate(new Date(y, m, d))); };
  // 每年固定
  s.add(localDate(new Date(y, 0, 1))); // 元旦
  // 按年份的具体假期（国务院公布）
  if (y === 2025) {
    addRange(0, 28, 31); addRange(1, 1, 4); // 春节 1/28-2/4
    addRange(3, 4, 6);   // 清明
    addRange(4, 1, 5);   // 劳动节
    addRange(4, 31, 31); addRange(5, 1, 2); // 端午
    addRange(9, 1, 8);   // 中秋+国庆
  } else if (y === 2026) {
    addRange(0, 1, 3);   // 元旦
    addRange(1, 17, 23); // 春节
    addRange(3, 5, 7);   // 清明
    addRange(4, 1, 5);   // 劳动节
    addRange(5, 19, 21); // 端午
    addRange(8, 25, 27); // 中秋
    addRange(9, 1, 7);   // 国庆
  } else {
    // 兜底：只标主要固定节日
    addRange(9, 1, 7); // 国庆
  }
  return s;
}
function renderClock() {
  const now = new Date();
  const h = now.getHours(), m = String(now.getMinutes()).padStart(2, '0');
  const time = `${h}:${m}`;
  const isLate = h >= 0 && h < 6;

  // 中国时间（UTC+8）
  const cnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const cnH = cnNow.getHours();
  const cnDay = cnNow.getDay();
  const cnDate = localDate(cnNow);
  const cnHoliday = CN_HOLIDAYS.has(cnDate);
  const cnWeekend = cnDay === 0 || cnDay === 6;
  const cnWork = !cnHoliday && !cnWeekend && cnH >= 9 && cnH < 18;
  const cnStatus = cnHoliday ? wrap(C.brightMagenta, '假期')
    : cnWeekend ? wrap(C.dim, '周末')
    : cnWork ? wrap(C.brightGreen, '上班')
    : wrap(C.dim, '下班');

  // 美国东部时间 → 反映 API 拥挤程度
  const usNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const usH = usNow.getHours();
  const usDay = usNow.getDay();
  const usDate = localDate(usNow);
  const usHoliday = US_HOLIDAYS.has(usDate);
  const usWeekend = usDay === 0 || usDay === 6;
  const usWork = !usHoliday && !usWeekend && usH >= 9 && usH < 18;
  // US 工作时段 = Claude 高峰期（用户多 → API 可能变慢）
  const usPeak = !usHoliday && !usWeekend && usH >= 9 && usH < 12;  // 美东上午最忙
  const usActive = usWork && !usPeak;

  let usLabel;
  if (usHoliday) {
    usLabel = wrap(C.brightGreen, '放假');
  } else if (usWeekend) {
    usLabel = wrap(C.brightGreen, '周末');
  } else if (usH >= 9 && usH < 10) {
    usLabel = wrap(C.red + C.bold, '刚上班');
  } else if (usH >= 10 && usH < 12) {
    usLabel = wrap(C.red, '上午忙');
  } else if (usH >= 12 && usH < 14) {
    usLabel = wrap(C.brightYellow, '午休');
  } else if (usH >= 14 && usH < 18) {
    usLabel = wrap(C.brightYellow, '下午忙');
  } else if (usH >= 18 && usH < 20) {
    usLabel = wrap(C.brightCyan, '刚下班');
  } else {
    usLabel = wrap(C.brightGreen, '没上班');
  }

  const clock = isLate
    ? `🌙 ${wrap(C.red + C.bold, time)} ${wrap(C.red, '夜深了，早点休息')}`
    : `⏰ ${wrap(C.white + C.bold, time)}`;

  return `${clock} ${wrap(C.dim, 'US')}${usLabel}`;
}

// 本项目会话数
let projectSessions = 0;
const cwd = meta.workspace?.current_dir || meta.cwd;
if (cwd) {
  const escaped = cwd.replace(/[\/\._]/g, '-');
  const projectDir = join(claudeDir, 'projects', escaped);
  if (existsSync(projectDir)) {
    try {
      for (const f of readdirSync(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const { prompts, userCreatedTs } = parseTranscript(join(projectDir, f));
        if (userCreatedTs && prompts.length >= 3) projectSessions++;
      }
    } catch {}
  }
}

const thinking = '';

// 5) token 速度 + sparkline（拆成两个返回值）+ 🌡️ API 体感温度
let sparkLine = '';
let apiTempStr = '';
function renderSpeedLine() {
  if (!meta.transcript_path || !existsSync(meta.transcript_path)) return '';
  // 从 transcript 取 token 总量
  let totalTokens = 0;
  try {
    for (const line of readFileSync(meta.transcript_path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const u = j.message?.usage;
        if (u) totalTokens += (u.output_tokens || 0);
      } catch {}
    }
  } catch {}

  const sid = meta.session_id || 'unknown';
  const statePath = join(claudeDir, 'plugins/claude-hud/speed-state.json');
  let state = { sessions: {}, globalPeak: 0 };
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  if (!state.sessions) state.sessions = {};
  if (!state.globalPeak) state.globalPeak = 0;

  const now = Date.now();
  const sess = state.sessions[sid] || { samples: [] };
  // 只在 token 数变化时记录新采样（避免空转稀释数据）
  const last = sess.samples[sess.samples.length - 1];
  if (!last || last[1] !== totalTokens) {
    sess.samples.push([now, totalTokens]);
  }
  if (sess.samples.length > 200) sess.samples = sess.samples.slice(-200);
  state.sessions[sid] = sess;

  // 清理：只保留最近 5 个 session 的数据
  const sids = Object.keys(state.sessions);
  if (sids.length > 5) {
    const keep = sids
      .map(k => ({ k, t: state.sessions[k].samples[state.sessions[k].samples.length - 1]?.[0] || 0 }))
      .sort((a, b) => b.t - a.t).slice(0, 5).map(x => x.k);
    state.sessions = Object.fromEntries(keep.map(k => [k, state.sessions[k]]));
  }

  // 计算速度序列（本会话完整历史）
  const speeds = [];
  for (let i = 1; i < sess.samples.length; i++) {
    const dt = (sess.samples[i][0] - sess.samples[i-1][0]) / 1000;
    const dTok = sess.samples[i][1] - sess.samples[i-1][1];
    if (dt > 0 && dTok > 0) speeds.push(dTok / dt);
  }

  // 当前速度：若最近 10 秒内有新 token，用最新值；否则视为 idle
  let current = 0;
  if (last && sess.samples.length >= 2) {
    const latest = sess.samples[sess.samples.length - 1];
    if (now - latest[0] < 10_000 && speeds.length > 0) {
      current = speeds[speeds.length - 1];
    }
  }

  const sessionMax = speeds.length ? Math.max(...speeds, 1) : 1;
  const sessionAvg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  if (current > state.globalPeak) state.globalPeak = current;
  try { writeFileSync(statePath, JSON.stringify(state)); } catch {}

  // 🌡️ TTFT 体感：最近 20 次中位数做基线，对比最新值
  if (meta.transcript_path && existsSync(meta.transcript_path)) {
    try {
      const tLines = readFileSync(meta.transcript_path, 'utf8').split('\n').filter(Boolean);
      const ttfts = [];
      let lastUserTs = null;
      for (const line of tLines) {
        try {
          const j = JSON.parse(line);
          if (j.type === 'user' && j.isSidechain !== true) {
            const c = j.message?.content;
            const isText = typeof c === 'string' || (Array.isArray(c) && c.some(x => x?.type === 'text'));
            const isTR = Array.isArray(c) && c.some(x => x?.type === 'tool_result');
            if (isText && !isTR && j.timestamp) lastUserTs = new Date(j.timestamp).getTime();
          }
          if (j.type === 'assistant' && lastUserTs && j.timestamp) {
            const aTs = new Date(j.timestamp).getTime();
            const delta = aTs - lastUserTs;
            if (delta > 0 && delta < 300_000) { ttfts.push(delta); lastUserTs = null; }
          }
        } catch {}
      }
      if (ttfts.length >= 5) {
        const window = ttfts.slice(-20);
        const sorted = [...window].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const latest = ttfts[ttfts.length - 1];
        const ratio = median > 0 ? latest / median : 1;
        const latestSec = (latest / 1000).toFixed(1);
        if (ratio <= 1.5)      apiTempStr = `🌡️ ${wrap(C.dim, '响应')} ${wrap(C.brightGreen, '畅通')}`;
        else if (ratio <= 2.0) apiTempStr = `🌡️ ${wrap(C.dim, '响应')} ${wrap(C.brightCyan, '正常')}`;
        else if (ratio <= 3.0) apiTempStr = `🌡️ ${wrap(C.dim, '响应')} ${wrap(C.brightYellow, '偏慢')}`;
        else                   apiTempStr = `🌡️ ${wrap(C.dim, '响应')} ${wrap(C.red + C.bold, '拥堵')}`;
      }
    } catch {}
  }

  // 混合刻度：本会话 max 不到全局 peak 的 30% 就降级用本会话自己的刻度
  const useGlobal = state.globalPeak > 0 && sessionMax >= state.globalPeak * 0.3;
  const scaleMax = useGlobal ? state.globalPeak : sessionMax;
  const marker = useGlobal ? '◉' : '○';

  // sparkline 宽度：最少 10，最多 50
  const prefixLen = 70;
  const WIDTH = Math.max(10, Math.min(50, termWidth - prefixLen));
  const blocks = '▁▂▃▄▅▆▇█';
  const recent = speeds.slice(-WIDTH);
  const padding = WIDTH - recent.length;
  let spark = '░'.repeat(padding);
  for (const v of recent) {
    if (v <= 0) {
      spark += '░';
    } else {
      const ratio = Math.min(1, v / scaleMax);
      const idx = Math.max(0, Math.min(blocks.length - 1, Math.ceil(ratio * blocks.length) - 1));
      spark += blocks[idx];
    }
  }

  const currentStr = speeds.length === 0 ? '--' : current.toFixed(0);
  const peak = state.globalPeak;
  const curColor = speeds.length === 0 ? C.dim : speedColor(current, peak);
  const avgColor = speedColor(sessionAvg, peak);
  const sessPeakColor = speedColor(sessionMax, peak);
  // sparkline 独立成行 = 当前速度 + sparkline
  if (tier === 'full' && speeds.length > 0) {
    sparkLine = `${dim('当前')} ${wrap(curColor + C.bold, currentStr)} ${dim('tok/s')}  ${dim(spark)} ${dim(marker)}`;
  }
  return `📈 ${wrap(C.dim, '速度')}  ${wrap(avgColor, sessionAvg.toFixed(0))}${dim('/avg')} ${dim('｜')} ${wrap(sessPeakColor, sessionMax.toFixed(0))}${dim('/会话峰值')} ${dim('｜')} ${wrap(C.brightMagenta, peak.toFixed(0))}${dim('/史峰')}`;
}

// 5) 输出指令统计行
const dim = s => wrap(C.dim, s);
const cyan = s => wrap(C.cyan, s);
const lbl = s => wrap(C.dim, s);
// 数值染色：基于与基线比例
function valColor(val, base) {
  if (!base) return C.brightCyan;
  const r = val / base;
  if (r >= 1.5) return C.red + C.bold;
  if (r >= 1.1) return C.brightYellow;
  if (r > 0.9)  return C.brightCyan;
  if (r > 0.5)  return C.green;
  return C.blue;
}
const num = (v, base) => wrap(valColor(v, base), String(v));
// 趋势箭头
function trend(val, base) {
  if (!base) return '';
  const r = val / base;
  if (r >= 1.5) return wrap(C.red + C.bold, ' ↑↑');
  if (r >= 1.1) return wrap(C.brightYellow, ' ↑');
  if (r > 0.9)  return '';
  if (r > 0.5)  return wrap(C.green, ' ↓');
  return wrap(C.blue, ' ↓↓');
}

if (tier === 'full') {
  // 4. ⚡ 速度 + 🌡️ 响应 + ⏰ 时钟/US
  const speedLine = renderSpeedLine();
  const clockStr = renderClock();
  const speedRight = [apiTempStr, clockStr].filter(Boolean).join(wrap(C.dim, ' │ '));
  if (speedLine) process.stdout.write(rightAppend(speedLine, speedRight) + '\n');

  // 5. 🪙 tokens + 💰 费用
  // (费用在 tokens 之后输出，先收集 tokens)
  if (tokensLine) process.stdout.write(tokensLine + '\n');

  // 5b. 💰 费用（紧跟 tokens 下方）
  {
    const plSign = profitLoss >= 0;
    const plColor = plSign ? C.brightGreen : C.red;
    const plLabel = plSign ? '赚' : '亏';
    const plAbs = Math.abs(profitLoss);
    const pctUsed = SUBSCRIPTION_MONTHLY > 0 ? Math.round((monthlyCost / SUBSCRIPTION_MONTHLY) * 100) : 0;
    const barLen = 10;
    const filled = Math.min(barLen, Math.round((pctUsed / 100) * barLen));
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const barColor = pctUsed >= 100 ? C.brightGreen : pctUsed >= 70 ? C.brightYellow : C.dim;
    const costParts = [
      `${lbl('本次')} ${wrap(C.brightYellow, fmtUSD(sessionCost))}`,
      `${lbl('今日')} ${wrap(C.brightYellow, fmtUSD(todayCostLive))}`,
      `${lbl('本月')} ${wrap(C.brightYellow, fmtUSD(monthlyCost))}/${wrap(C.dim, fmtUSD(SUBSCRIPTION_MONTHLY))} ${wrap(barColor, bar)} ${wrap(barColor, pctUsed + '%')}`,
      `${wrap(plColor, plLabel)} ${wrap(plColor, fmtUSD(plAbs))}`,
    ];
    process.stdout.write(`💰 ${wrap(C.dim, '费用')}  ${costParts.join(wrap(C.dim, ' · '))}\n`);
  }

  // 6. 📝 对话次数
  const promptParts = [
    `${lbl('本次')} ${wrap(C.brightCyan, sessionCount)}`,
    `${lbl('今日')} ${num(pAgg.today, pAgg.avg7)}${trend(pAgg.today, pAgg.avg7)}`,
    `${lbl('7日均')} ${num(pAgg.avg7, pAgg.avg30)}${trend(pAgg.avg7, pAgg.avg30)}`,
    `${lbl('30日均')} ${wrap(C.cyan, pAgg.avg30)}`,
    `${lbl('全部')} ${wrap(C.dim, globalCount)}`,
  ];
  const promptLine = `📝 ${wrap(C.dim, '对话次数')}  ${promptParts.join(wrap(C.dim, ' · '))}`;
  // 7. 💬 会话次数
  const sessParts = [
    `${lbl('本项目')} ${wrap(C.brightCyan, projectSessions)}`,
    `${lbl('今日')} ${num(sAgg.today, sAgg.avg7)}${trend(sAgg.today, sAgg.avg7)}`,
    `${lbl('7日均')} ${num(sAgg.avg7, sAgg.avg30)}${trend(sAgg.avg7, sAgg.avg30)}`,
    `${lbl('30日均')} ${wrap(C.cyan, sAgg.avg30)}`,
    `${lbl('全部')} ${wrap(C.dim, globalSessions)}`,
  ];
  const sessLine = `💬 ${wrap(C.dim, '会话次数')}  ${sessParts.join(wrap(C.dim, ' · '))}`;
  process.stdout.write(`${promptLine}\n`);
  process.stdout.write(`${sessLine}\n`);

  // 8. 🔥 连续工作 + 📊 日活跃 + 📅 周活跃
  const streakColor = streak >= 30 ? C.red + C.bold : streak >= 7 ? C.brightYellow : C.brightCyan;
  const streakStr = `🔥 ${dim('连续工作')} ${wrap(streakColor, String(streak))} ${dim('天')}`;
  const heatmap = `📊 ${dim('日活跃')} ${renderHeatmap()}`;
  const weeklyHeatmap = `📅 ${dim('周活跃')} ${renderWeeklyHeatmap()}`;
  process.stdout.write(`${streakStr} ${wrap(C.dim, '│')} ${heatmap} ${wrap(C.dim, '│')} ${weeklyHeatmap}\n`);

} else if (tier === 'medium') {
  process.stdout.write(`📝 ${num(sessionCount, pAgg.avg7)}${dim('/')}${num(pAgg.today, pAgg.avg7)}${trend(pAgg.today, pAgg.avg7)}${dim('/')}${num(pAgg.avg7, pAgg.avg30)}${dim('/')}${dim(globalCount)} ${dim('│')} 💬 ${num(projectSessions, 5)}${dim('/')}${num(sAgg.today, sAgg.avg7)}${trend(sAgg.today, sAgg.avg7)}${dim('/')}${num(sAgg.avg7, sAgg.avg30)}${dim('/')}${dim(globalSessions)}\n`);
  const speedLine = renderSpeedLine();
  if (speedLine) process.stdout.write(speedLine + '\n');
  if (tokensLine) process.stdout.write(tokensLine + '\n');
  // medium 模式下简化费用行
  {
    const plSign = profitLoss >= 0;
    const plColor = plSign ? C.brightGreen : C.red;
    const plLabel = plSign ? '赚' : '亏';
    process.stdout.write(`💰 ${wrap(C.brightYellow, fmtUSD(sessionCost))}${dim('/')}${wrap(C.brightYellow, fmtUSD(todayCostLive))}${dim('/')}${wrap(C.brightYellow + C.bold, fmtUSD(monthlyCost))} ${wrap(plColor + C.bold, plLabel + fmtUSD(Math.abs(profitLoss)))}\n`);
  }
}
// compact 不输出额外行（只保留 claude-hud 原生 + identity/env 行）
