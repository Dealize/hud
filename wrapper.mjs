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

// 检测终端宽度：优先用 Claude Code 给的 stdout/stderr/env，退回父进程 tty
function detectTerminalWidth() {
  if (process.stdout?.columns) return process.stdout.columns;
  if (process.stderr?.columns) return process.stderr.columns;
  if (process.env.COLUMNS && +process.env.COLUMNS > 0) return +process.env.COLUMNS;
  try {
    let pid = process.ppid;
    for (let i = 0; i < 5; i++) {
      const tty = execSync(`ps -o tty= -p ${pid} 2>/dev/null || true`).toString().trim();
      if (tty && tty !== '??' && tty !== '?') {
        const size = execSync(`stty size < /dev/${tty} 2>/dev/null || true`).toString().trim();
        const cols = parseInt(size.split(/\s+/)[1], 10);
        if (cols > 0) return cols;
      }
      const parent = execSync(`ps -o ppid= -p ${pid} 2>/dev/null || true`).toString().trim();
      const nextPid = parseInt(parent, 10);
      if (!nextPid || nextPid === pid) break;
      pid = nextPid;
    }
  } catch {}
  return 0;
}
// 预留 4 字符安全边距，避免 Claude Code 再截一次时误伤
const rawWidth = detectTerminalWidth() || 100;
const termWidth = Math.max(40, rawWidth - 4);
// 自适应分层：full ≥160，medium 120-159，compact <120
const tier = rawWidth >= 160 ? 'full' : rawWidth >= 120 ? 'medium' : 'compact';

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
  const result = { subagent: { running: 0, total: 0 }, tools: {} };
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

  for (const [id, name] of idToName) {
    const isDone = finished.has(id);
    if (name === 'Task' || name === 'Agent') {
      result.subagent.total++;
      if (!isDone) result.subagent.running++;
    } else {
      if (!result.tools[name]) result.tools[name] = { running: 0, total: 0 };
      result.tools[name].total++;
      if (!isDone) result.tools[name].running++;
    }
  }
  return result;
}

let tokensLine = '';

if (pluginDir) {
  // 给 claude-hud 足够宽度拿完整输出，外层再按 termWidth 截断
  const r = spawnSync('/opt/homebrew/bin/bun', ['--env-file', '/dev/null', join(pluginDir, 'src/index.ts')], {
    input,
    env: { ...process.env, COLUMNS: '500' },
    encoding: 'utf8',
  });
  if (r.stdout) {
    const skills = countSkills();
    const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = r.stdout.replace(/\n$/, '').split('\n');

    // 重排身份行：模型 │ 项目 │ session │ 时长  →  项目 │ session │ 时长 │ 模型 │ tokens
    const idIdx = lines.findIndex(l => /\[.+\].*│/.test(stripAnsi(l)));
    if (idIdx >= 0) {
      const rawParts = lines[idIdx].split(/\s*│\s*/);
      // 找模型片段（带 [] 的那个）
      const modelPartIdx = rawParts.findIndex(p => /\[.+\]/.test(stripAnsi(p)));
      if (modelPartIdx >= 0) {
        const modelPart = rawParts.splice(modelPartIdx, 1)[0].trim();
        rawParts.push(modelPart);
      }
      lines[idIdx] = rawParts.map(p => p.trim()).join(' │ ');
    }

    // 把"(重置剩余 3h 36m)"或"(resets in 3h 36m)" → "(3h 36m)"
    for (let i = 0; i < lines.length; i++) {
      lines[i] = lines[i]
        .replace(/重置剩余\s*/g, '')
        .replace(/resets?\s+in\s+/gi, '');
    }

    // 抽出 tokens 行（带 cache），稍后插到末尾
    const tokIdx = lines.findIndex(l => /Tokens\s+[\d.]/.test(stripAnsi(l)));
    if (tokIdx >= 0) {
      const raw = stripAnsi(lines[tokIdx]);
      const N = '([\\d.]+[kKmMgG]?)';
      const m = raw.match(new RegExp(`Tokens\\s+${N}\\s*\\(in:\\s*${N},\\s*out:\\s*${N}(?:,\\s*cache:\\s*${N})?`));
      if (m) {
        const [, total, inTok, outTok, cacheTok] = m;
        tokensLine = `\x1b[2mTokens: ${total}  in:${inTok}  out:${outTok}${cacheTok ? `  cache:${cacheTok}` : ''}\x1b[0m`;
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

    // 顺序：SubAgent | 工具计数 │ 5 MCPs | 7 钩子 | 46 技能
    // 显示语义：已完成/总数，运行中橙色
    if (envIdx >= 0) {
      const usage = countToolUsage();
      const prefixParts = [];
      const { running: sRunning, total: sTotal } = usage.subagent;
      if (sTotal > 0) {
        const done = sTotal - sRunning;
        const col = sRunning > 0 ? '\x1b[33m' : '\x1b[2m';
        prefixParts.push(`${col}${done}/${sTotal} SubAgent\x1b[0m`);
      }
      const toolEntries = Object.entries(usage.tools).sort((a, b) => b[1].total - a[1].total);
      for (const [name, { running, total }] of toolEntries) {
        const done = total - running;
        const col = running > 0 ? '\x1b[33m' : '\x1b[2m';
        prefixParts.push(`${col}${done}/${total} ${name}\x1b[0m`);
      }
      const prefix = prefixParts.length > 0
        ? prefixParts.join('\x1b[2m | \x1b[0m') + '\x1b[2m │ \x1b[0m'
        : '';
      const suffix = `\x1b[2m | ${skills} 技能\x1b[0m`;
      lines[envIdx] = prefix + lines[envIdx] + suffix;
      // 删除 claude-hud 自带的活动行
      for (const i of activityIdxs.slice().reverse()) lines.splice(i, 1);
    }

    // compact: 只留身份行
    let finalLines = lines;
    if (tier === 'compact') {
      finalLines = lines.slice(0, 1);
    } else if (tier === 'medium') {
      // medium: 身份行 + env 合并行（如果存在）
      const keep = [0];
      if (envIdx >= 0 && envIdx !== 0) keep.push(envIdx - activityIdxs.filter(i => i < envIdx).length);
      finalLines = keep.map(i => lines[i]).filter(Boolean);
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

// 2) 解析单文件：只统计「人工创建的 session」
//    判定：有至少一条 isSidechain=false + user + 真文本（非 tool_result）
function parseTranscript(file) {
  const prompts = [];
  if (!existsSync(file)) return { prompts, userCreatedTs: null };
  let userCreatedTs = null;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.type !== 'user') continue;
        if (j.isSidechain === true) continue;  // 跳过 subagent 侧链
        const content = j.message?.content;
        const isText = typeof content === 'string'
          || (Array.isArray(content) && content.some(c => c?.type === 'text'));
        const isToolResult = Array.isArray(content) && content.some(c => c?.type === 'tool_result');
        if (isToolResult || !isText) continue;
        if (!userCreatedTs) userCreatedTs = j.timestamp;
        prompts.push(j.timestamp);
      } catch {}
    }
  } catch {}
  return { prompts, userCreatedTs };
}

const sessionCount = meta.transcript_path ? parseTranscript(meta.transcript_path).prompts.length : 0;

// 3) 全局统计（缓存 24h，包含按日桶）
const cachePath = join(claudeDir, 'plugins/claude-hud/cache.json');
const DAY = 86400_000;
let cache = {};
try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}

let stats;
if (cache.stats && cache.ts && Date.now() - cache.ts < DAY) {
  stats = cache.stats;
} else {
  stats = { promptBuckets: {}, sessionBuckets: {}, globalPrompts: 0, globalSessions: 0 };
  const projectsDir = join(claudeDir, 'projects');
  if (existsSync(projectsDir)) {
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        try {
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else if (name.endsWith('.jsonl')) {
            const { prompts, userCreatedTs } = parseTranscript(p);
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
          }
        } catch {}
      }
    };
    walk(projectsDir);
  }
  try { writeFileSync(cachePath, JSON.stringify({ stats, ts: Date.now() })); } catch {}
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
let todayPromptsLive = 0, todaySessionsLive = 0;
const projectsDirLive = join(claudeDir, 'projects');
if (existsSync(projectsDirLive)) {
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (name.endsWith('.jsonl') && s.mtime >= todayStart) {
          const { prompts, userCreatedTs } = parseTranscript(p);
          if (!userCreatedTs || prompts.length < 3) continue;
          const todayStr = localDate(todayStart);
          for (const t of prompts) {
            if (t && localDate(t) === todayStr) todayPromptsLive++;
          }
          if (localDate(userCreatedTs) === todayStr) todaySessionsLive++;
        }
      } catch {}
    }
  };
  walk(projectsDirLive);
}
pAgg.today = todayPromptsLive;
sAgg.today = todaySessionsLive;

// 本项目会话数
let projectSessions = 0;
const cwd = meta.workspace?.current_dir || meta.cwd;
if (cwd) {
  const escaped = cwd.replace(/[\/\.]/g, '-');
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

// 5) token 速度 + sparkline
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
  return `${dim('⚡')} ${sessionAvg.toFixed(0)}${dim('/avg')} ｜ ${sessionMax.toFixed(0)}${dim('/本峰')} ｜ ${state.globalPeak.toFixed(0)}${dim('/史峰')} ${dim('----')} ${dim('当前')}${cyan(currentStr)} ${dim('tok/s')}   ${dim(spark)} ${dim(marker)}`;
}

// 5) 输出指令统计行
const dim = s => `\x1b[2m${s}\x1b[0m`;
const cyan = s => `\x1b[36m${s}\x1b[0m`;
// 趋势：与基线比较 → 箭头+颜色
function trend(val, base) {
  if (!base) return '';
  const r = val / base;
  if (r >= 1.5) return ' \x1b[31m↑↑\x1b[0m';   // 红
  if (r >= 1.1) return ' \x1b[33m↑\x1b[0m';     // 橙
  if (r > 0.9)  return '';                     // 持平不显示
  if (r > 0.5)  return ' \x1b[32m↓\x1b[0m';     // 绿
  return ' \x1b[34m↓↓\x1b[0m';                 // 蓝
}
const pT = trend(pAgg.today, pAgg.avg7);
const pW = trend(pAgg.avg7, pAgg.avg30);
const sT = trend(sAgg.today, sAgg.avg7);
const sW = trend(sAgg.avg7, sAgg.avg30);

if (tier === 'full') {
  process.stdout.write(`${dim('📝 指令')} ${cyan('本次')} ${sessionCount} · ${cyan('今日')} ${pAgg.today}${pT} · ${cyan('7日均')} ${pAgg.avg7}${pW} · ${cyan('30日均')} ${pAgg.avg30} · ${cyan('全部')} ${globalCount}\n`);
  process.stdout.write(`${dim('💬 会话')} ${cyan('本项目')} ${projectSessions} · ${cyan('今日')} ${sAgg.today}${sT} · ${cyan('7日均')} ${sAgg.avg7}${sW} · ${cyan('30日均')} ${sAgg.avg30} · ${cyan('全部')} ${globalSessions}${thinking}\n`);
  const speedLine = renderSpeedLine();
  if (speedLine) process.stdout.write(speedLine + '\n');
  if (tokensLine) process.stdout.write(tokensLine + '\n');
} else if (tier === 'medium') {
  // 压缩：指令 + 会话 合并一行，去掉 30日均；速度一行保留 sparkline
  process.stdout.write(`${dim('📝')} ${sessionCount}${dim('/')}${pAgg.today}${pT}${dim('/')}${pAgg.avg7}${pW}${dim('/')}${globalCount} ${dim('│ 💬')} ${projectSessions}${dim('/')}${sAgg.today}${sT}${dim('/')}${sAgg.avg7}${sW}${dim('/')}${globalSessions}\n`);
  const speedLine = renderSpeedLine();
  if (speedLine) process.stdout.write(speedLine + '\n');
  if (tokensLine) process.stdout.write(tokensLine + '\n');
}
// compact 不输出额外行（只保留 claude-hud 原生 + identity/env 行）
