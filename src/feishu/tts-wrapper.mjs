#!/usr/bin/env node
/**
 * Voice Engine TTS Wrapper - 平台自适应版
 * 自动检测 Linux / Windows，使用对应路径
 */

import https from 'node:https';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tts as edgeTts } from './edge-tts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

// ── 平台路径（环境变量可覆盖，默认值兼容本机）──
const PATHS = {
  tempDir: process.env.TTS_TEMP_DIR || (isWin
    ? join(process.env.TEMP || 'C:\\Users\\oadan\\AppData\\Local\\Temp', 'agents-to-im-tts')
    : '/tmp/agents-to-im-tts'),
  ffmpeg: process.env.TTS_FFMPEG_BIN || (isWin
    ? 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
    : (existsSync('/sherpa-onnx/bin/ffmpeg') ? '/sherpa-onnx/bin/ffmpeg' : '/usr/bin/ffmpeg')),
  sherpaBin: process.env.TTS_SHARPA_BIN || (isWin
    ? 'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline-tts.exe'
    : '/sherpa-onnx/bin/sherpa-onnx-offline-tts'),
  sherpaModels: process.env.TTS_MODEL_DIR || (isWin
    ? 'C:\\D\\opt\\sherpa-onnx\\models'
    : '/sherpa-onnx/models'),
};

// ── 读取 TTS 配置：优先环境变量（agents-to-im 独立部署），兼容 openclaw.json ──
function loadConfig() {
  const env = process.env;
  let fileProviders = {};
  try {
    // 兼容旧配置：若存在 openclaw.json 且未设置环境变量，读它（可选路径，不存在时忽略）
    const legacyPath = isWin
      ? 'C:\\Users\\oadan\\.openclaw\\openclaw.json'
      : '/root/.openclaw/openclaw.json';
    if (existsSync(legacyPath)) {
      const raw = readFileSync(legacyPath, 'utf8');
      const cfg = JSON.parse(raw);
      fileProviders = cfg.messages?.tts?.providers || {};
    }
  } catch { /* openclaw.json 不存在/不可读时忽略 */ }

  return {
    xiaomi: {
      apiKey: env.TTS_XIAOMI_KEY || fileProviders.openai?.apiKey || '',
      baseUrl: env.TTS_XIAOMI_BASE_URL || fileProviders.openai?.baseUrl || 'https://api.xiaomimimo.com/v1',
      model: env.TTS_XIAOMI_MODEL || fileProviders.openai?.model || 'mimo-v2.5-tts',
      voice: env.TTS_XIAOMI_VOICE || fileProviders.openai?.voice || 'default_zh',
      speed: 1.2,
    },
    microsoft: {
      enabled: env.TTS_EDGE_ENABLED !== 'false' && fileProviders.microsoft?.enabled !== false,
      voice: env.TTS_EDGE_VOICE || fileProviders.microsoft?.voice || 'zh-CN-XiaoxiaoNeural',
    },
    wangwang: {
      enabled: env.TTS_WANGWANG_ENABLED !== 'false' && fileProviders.wangwang?.enabled !== false,
      url: env.TTS_WANGWANG_URL || fileProviders.wangwang?.url || 'https://tts.wangwangit.com/v1/audio/speech',
      voice: env.TTS_WANGWANG_VOICE || fileProviders.wangwang?.voice || 'zh-CN-XiaoxiaoNeural',
      speed: Number(env.TTS_WANGWANG_SPEED || 1.2),
    },
    ali: {
      enabled: env.TTS_ALI_ENABLED !== 'false' && fileProviders.ali?.enabled !== false,
      apiKey: env.TTS_ALI_KEY || fileProviders.ali?.apiKey || '',
      baseUrl: env.TTS_ALI_BASE_URL || fileProviders.ali?.baseUrl || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      voice: env.TTS_ALI_VOICE || fileProviders.ali?.voice || 'Cherry',
    },
    melo: {
      enabled: env.TTS_MELO_ENABLED !== 'false',
      binary: PATHS.sherpaBin,
      modelDir: join(PATHS.sherpaModels, 'melo'),
    },
  };
}

const CONFIG = loadConfig();
const TEMP_DIR = PATHS.tempDir;
const FFMPEG = PATHS.ffmpeg;

mkdirSync(TEMP_DIR, { recursive: true });

// ── HTTP 请求 ──
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeout || 60000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpRequest(res.headers.location, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── ffmpeg 转码（含音量标准化）──
function transcode(inputFile, outputFormat, outputFile, volume = 3.0) {
  const volFilter = '-af';
  const volValue = `volume=${volume}`;
  const args = outputFormat === 'opus'
    ? [FFMPEG, '-i', inputFile, volFilter, volValue, '-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-y', outputFile]
    : [FFMPEG, '-i', inputFile, volFilter, volValue, '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', '-y', outputFile];
  try {
    const cmd = args.map(a => `"${a}"`).join(' ');
    execSync(cmd, { stdio: 'pipe', timeout: 30000, shell: isWin, windowsHide: true });
    return true;
  } catch (e) {
    console.error(`[转码] ${outputFormat} 失败: ${e.message}`);
    return false;
  }
}

// ── 小米 TTS（OpenAI 兼容 API）──
async function synthesizeXiaomi(text, outputFormat) {
  const cfg = CONFIG?.xiaomi;
  if (!cfg?.apiKey) { console.error('[TTS-小米] 无 API Key'); return null; }
  console.error('[TTS-小米] 开始合成');
  const payload = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'user', content: '把下面的文字转成语音' },
      { role: 'assistant', content: text }
    ],
    max_tokens: 8192,
    speed: cfg.speed,
    voice: cfg.voice,
  });
  const res = await httpRequest(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: payload,
  });
  const result = JSON.parse(res.body.toString());
  const audioData = result.choices?.[0]?.message?.audio?.data;
  if (!audioData || audioData.length < 100) { console.error('[TTS-小米] 无法解析响应'); return null; }
  const rawFile = join(TEMP_DIR, 'tts_xiaomi_raw.wav');
  writeFileSync(rawFile, Buffer.from(audioData, 'base64'));
  console.error(`[TTS-小米] WAV ${readFileSync(rawFile).length}b`);
  return finalizeOutput(rawFile, 'xiaomi', outputFormat);
}

// ── 微软 Edge TTS ──
async function synthesizeMicrosoft(text, outputFormat) {
  const cfg = CONFIG?.microsoft;
  if (!cfg?.enabled) { console.error('[TTS-微软] 未启用'); return null; }
  console.error('[TTS-微软] 开始合成');
  try {
    const audioBuffer = await edgeTts(text, cfg.voice);
    if (!audioBuffer || audioBuffer.length === 0) { console.error('[TTS-微软] 返回空音频'); return null; }
    const rawFile = join(TEMP_DIR, 'tts_microsoft_raw.mp3');
    writeFileSync(rawFile, audioBuffer);
    console.error(`[TTS-微软] MP3 ${audioBuffer.length}b`);
    if (outputFormat === 'mp3') {
      const outFile = join(TEMP_DIR, 'tts_microsoft.mp3');
      renameSync(rawFile, outFile);
      return { path: outFile, format: 'mp3' };
    }
    return finalizeOutput(rawFile, 'microsoft', outputFormat);
  } catch (e) { console.error(`[TTS-微软] 失败: ${e.message}`); return null; }
}

// ── 万旺 TTS ──
async function synthesizeWangwang(text, outputFormat) {
  const cfg = CONFIG?.wangwang;
  if (!cfg?.enabled || !cfg?.url) { console.error('[TTS-万旺] 未启用'); return null; }
  console.error('[TTS-万旺] 开始合成');
  const res = await httpRequest(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice: cfg.voice, speed: cfg.speed, pitch: '0', style: 'general' }),
    timeout: 30000,
  });
  if (res.status !== 200 || res.body.length === 0) { console.error(`[TTS-万旺] HTTP ${res.status}`); return null; }
  const rawFile = join(TEMP_DIR, 'tts_wangwang_raw.mp3');
  writeFileSync(rawFile, res.body);
  console.error(`[TTS-万旺] MP3 ${res.body.length}b`);
  if (outputFormat === 'mp3') {
    const outFile = join(TEMP_DIR, 'tts_wangwang.mp3');
    renameSync(rawFile, outFile);
    return { path: outFile, format: 'mp3' };
  }
  return finalizeOutput(rawFile, 'wangwang', outputFormat);
}

// ── 阿里 TTS ──
async function synthesizeAli(text, outputFormat) {
  const cfg = CONFIG?.ali;
  if (!cfg?.enabled || !cfg?.apiKey) { console.error('[TTS-阿里] 未启用'); return null; }
  console.error('[TTS-阿里] 开始合成');
  const res = await httpRequest(cfg.baseUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text }, parameters: { voice: cfg.voice, format: 'wav', language_type: 'zh' } }),
    timeout: 60000,
  });
  if (res.status !== 200) { console.error(`[TTS-阿里] HTTP ${res.status}`); return null; }
  const result = JSON.parse(res.body.toString());
  const audioUrl = result.output?.audio?.url;
  if (!audioUrl) { console.error('[TTS-阿里] 无音频 URL'); return null; }
  const audioRes = await httpRequest(audioUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 120000 });
  const rawFile = join(TEMP_DIR, 'tts_ali_raw.wav');
  writeFileSync(rawFile, audioRes.body);
  console.error(`[TTS-阿里] WAV ${audioRes.body.length}b`);
  return finalizeOutput(rawFile, 'ali', outputFormat);
}

// ── sherpa-onnx 本地 TTS 通用函数 ──
function runLocalTts(binary, modelDir, text, voiceId, outputFile, modelFile) {
  const args = [
    `--vits-model=${join(modelDir, modelFile || 'model.onnx')}`,
    `--vits-tokens=${join(modelDir, 'tokens.txt')}`,
    `--vits-lexicon=${join(modelDir, 'lexicon.txt')}`,
    `--output-filename=${outputFile}`,
    `--num-threads=4`,
    `--sid=${voiceId || '0'}`,
  ];
  const fsts = ['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst']
    .filter(f => existsSync(join(modelDir, f)));
  if (fsts.length) args.push(`--tts-rule-fsts=${fsts.map(f => join(modelDir, f)).join(',')}`);
  if (existsSync(join(modelDir, 'dict'))) args.push(`--vits-dict-dir=${join(modelDir, 'dict')}`);
  const cmd = `${binary} ${args.map(a => `"${a}"`).join(' ')} "${text}"`;
  execSync(cmd, { stdio: 'pipe', timeout: 120000, shell: isWin, windowsHide: true });
}

// ── MeloTTS ──
async function synthesizeMelo(text, outputFormat) {
  const cfg = CONFIG?.melo;
  if (!cfg?.enabled) { console.error('[TTS-Melo] 未启用'); return null; }
  console.error('[TTS-Melo] 开始合成');
  const rawFile = join(TEMP_DIR, 'tts_melo_raw.wav');
  try {
    runLocalTts(cfg.binary, cfg.modelDir, text, null, rawFile);
  } catch (e) { console.error(`[TTS-Melo] 失败: ${e.message}`); return null; }
  if (!existsSync(rawFile) || readFileSync(rawFile).length === 0) { console.error('[TTS-Melo] 输出为空'); return null; }
  console.error(`[TTS-Melo] WAV ${readFileSync(rawFile).length}b`);
  return finalizeOutput(rawFile, 'melo', outputFormat, 5.0);
}

// ── 统一输出处理 ──
function finalizeOutput(rawFile, provider, outputFormat, volume) {
  if (!existsSync(rawFile) || readFileSync(rawFile).length === 0) return null;
  const names = { xiaomi: '小米TTS', microsoft: '微软TTS', wangwang: '万旺TTS', ali: '阿里TTS', melo: 'MeloTTS' };
  const outFile = join(TEMP_DIR, `${names[provider] || provider}.${outputFormat}`);
  if (transcode(rawFile, outputFormat, outFile, volume)) {
    console.error(`[TTS] ${provider} -> ${outputFormat.toUpperCase()} ${readFileSync(outFile).length}b`);
    return { path: outFile, format: outputFormat };
  }
  return null;
}

// ── 主逻辑 ──
// 模块导出：供 agents-to-im import 调用（不 spawn 子进程）
export async function synthesize(text, opts = {}) {
  const channel = opts.channel || process.env.TTS_CHANNEL || 'feishu';
  const provider = (opts.provider || process.env.TTS_PROVIDER || 'auto').toLowerCase();
  const channelFormats = {
    feishu: 'opus', telegram: 'opus', whatsapp: 'opus',
    weixin: 'mp3', wx: 'mp3',
    qq: 'opus', discord: 'opus', signal: 'opus',
    line: 'opus', bluebubbles: 'mp3', msteams: 'opus',
    slack: 'opus', matrix: 'opus', mattermost: 'opus',
    nextcloud: 'opus', nostr: 'opus', irc: 'opus',
  };
  const outputFormat = channelFormats[channel] || 'opus';
  const providerMap = {
    xiaomi: 'xiaomi', xiaomimimo: 'xiaomi', mimo: 'xiaomi',
    microsoft: 'microsoft', edge: 'microsoft', edgetts: 'microsoft',
    wangwang: 'wangwang', wangwangit: 'wangwang',
    ali: 'ali', aliyun: 'ali', alibaba: 'ali', dashscope: 'ali',
    melo: 'melo', melotts: 'melo', local: 'melo',
  };
  const providers = provider === 'auto'
    ? ['xiaomi', 'microsoft', 'melo', 'wangwang', 'ali']
    : [providerMap[provider] || provider];
  const fns = { xiaomi: synthesizeXiaomi, microsoft: synthesizeMicrosoft, wangwang: synthesizeWangwang, ali: synthesizeAli, melo: synthesizeMelo };
  console.error(`[TTS] channel=${channel}, provider=${provider}, format=${outputFormat}, platform=${process.platform}`);
  for (const p of providers) {
    const fn = fns[p];
    if (!fn) continue;
    try {
      const result = await fn(text, outputFormat);
      if (result) {
        console.error(`[TTS] 成功: ${p}`);
        return { path: result.path, format: outputFormat, provider: p };
      }
    } catch (e) { console.error(`[TTS] ${p} 失败: ${e.message}`); }
  }
  console.error('[TTS] 全部失败');
  return null;
}

async function main() {
  const text = process.argv[2];
  if (!text) { console.error('用法: node tts-wrapper.mjs "要说的话"'); process.exit(1); }
  const result = await synthesize(text);
  if (result) {
    process.stdout.write(result.path);
    process.exit(0);
  }
  process.exit(1);
}

// 本模块只导出 synthesize，不执行任何 CLI 逻辑。
// CLI 入口见 tts-cli.mjs（单独文件，避免 bundle 后 import 误执行）。
// 说明：esbuild 打包后 import.meta.url 指向 daemon.mjs，任何 isCli 检测都会失效，
// 因此 CLI 自执行代码不能放在本文件内。
