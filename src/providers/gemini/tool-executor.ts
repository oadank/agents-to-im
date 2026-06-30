/**
 * Gemini Provider 工具执行器
 *
 * 执行 LLM 请求的工具调用，返回结果字符串。
 * 安全限制：
 *   - write_file/run_bash 限定 cwd (/opt) 内
 *   - run_bash 黑名单 + 30s 超时
 *   - 其他工具各自超时
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CWD = '/opt';
const AGENTMEMORY_URL = 'http://127.0.0.1:3111';
const TOKEN_FILE = '/opt/.agents-to-im/user-token.json';

/** run_bash 黑名单（命中即拒绝） */
const BASH_BLACKLIST = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,            // fork bomb
  /\bcurl\b[^|]*\|\s*(?:sh|bash)/,
  /\bwget\b[^|]*\|\s*(?:sh|bash)/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
];

/** 解析后的工具调用 */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 把路径解析为绝对路径，并校验是否在 CWD 内 */
function resolveInCwd(p: string): { ok: boolean; abs: string; reason?: string } {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(CWD, p));
  if (abs !== CWD && !abs.startsWith(CWD + path.sep)) {
    return { ok: false, abs, reason: `路径 ${abs} 不在允许的工作目录 ${CWD} 内` };
  }
  return { ok: true, abs };
}

async function execReadFile(args: Record<string, unknown>): Promise<string> {
  const p = String(args.path || '');
  if (!p) return 'Error: 缺少 path 参数';
  try {
    const abs = path.isAbsolute(p) ? p : path.join(CWD, p);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `Error: ${abs} 是目录，请用 list_files`;
    if (stat.size > 256 * 1024) return `Error: 文件过大（${stat.size} bytes），超过 256KB 限制`;
    return fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    return `Error: 读取失败 - ${(e as Error).message}`;
  }
}

async function execWriteFile(args: Record<string, unknown>): Promise<string> {
  const p = String(args.path || '');
  const content = String(args.content ?? '');
  if (!p) return 'Error: 缺少 path 参数';
  const chk = resolveInCwd(p);
  if (!chk.ok) return `Error: ${chk.reason}`;
  try {
    fs.mkdirSync(path.dirname(chk.abs), { recursive: true });
    fs.writeFileSync(chk.abs, content, 'utf-8');
    return `OK: 已写入 ${chk.abs} (${content.length} 字符)`;
  } catch (e) {
    return `Error: 写入失败 - ${(e as Error).message}`;
  }
}

async function execListFiles(args: Record<string, unknown>): Promise<string> {
  const p = String(args.path || '');
  if (!p) return 'Error: 缺少 path 参数';
  try {
    const abs = path.isAbsolute(p) ? p : path.join(CWD, p);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const lines = entries.map(e => `${e.isDirectory() ? 'd' : '-'} ${e.name}`);
    return lines.length ? lines.join('\n') : '(空目录)';
  } catch (e) {
    return `Error: 列目录失败 - ${(e as Error).message}`;
  }
}

async function execRunBash(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command || '');
  if (!command) return 'Error: 缺少 command 参数';
  for (const re of BASH_BLACKLIST) {
    if (re.test(command)) return `Error: 命令被安全黑名单拦截（匹配 ${re}）`;
  }
  return new Promise<string>((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (s: string) => { if (!settled) { settled = true; resolve(s); } };
    child.stdout.on('data', (c) => { stdout += c.toString(); if (stdout.length > 64 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(`Error: 命令超时（30s）\nstdout:\n${stdout.slice(0, 4000)}`); }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.slice(0, 8000);
      const err = stderr.slice(0, 2000);
      finish(`exit=${code}\nstdout:\n${out}${err ? `\nstderr:\n${err}` : ''}`);
    });
    child.on('error', (e) => { clearTimeout(timer); finish(`Error: 执行失败 - ${e.message}`); });
  });
}

async function execSendFeishu(args: Record<string, unknown>): Promise<string> {
  const chatId = String(args.chat_id || '');
  const text = String(args.text || '');
  if (!chatId || !text) return 'Error: 缺少 chat_id 或 text 参数';
  let token = '';
  try {
    token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')).accessToken || '';
  } catch (e) {
    return `Error: 读取飞书 token 失败 - ${(e as Error).message}`;
  }
  if (!token) return 'Error: 飞书 token 为空';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json() as { code?: number; msg?: string };
    return data.code === 0 ? `OK: 消息已发送到 ${chatId}` : `Error: 飞书返回 code=${data.code} msg=${data.msg}`;
  } catch (e) {
    return `Error: 发送失败 - ${(e as Error).message}`;
  }
}

async function execMemoryRecall(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || '');
  const limit = Number(args.limit) || 5;
  if (!query) return 'Error: 缺少 query 参数';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${AGENTMEMORY_URL}/agentmemory/smart-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json() as { results?: Array<{ title?: string; type?: string }> };
    const results = data.results || [];
    if (!results.length) return '(无匹配记忆)';
    return results.map((r, i) => `${i + 1}. [${r.type || '?'}] ${(r.title || '').slice(0, 200)}`).join('\n');
  } catch (e) {
    return `Error: 记忆查询失败 - ${(e as Error).message}`;
  }
}

async function execMemorySave(args: Record<string, unknown>): Promise<string> {
  const content = String(args.content || '');
  const type = String(args.type || 'fact');
  if (!content) return 'Error: 缺少 content 参数';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${AGENTMEMORY_URL}/agentmemory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, type }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok ? 'OK: 已保存到长期记忆' : `Error: 保存失败 HTTP ${res.status}`;
  } catch (e) {
    return `Error: 记忆保存失败 - ${(e as Error).message}`;
  }
}

/** 执行单个工具调用，返回结果字符串 */
export async function executeTool(call: ParsedToolCall): Promise<string> {
  switch (call.name) {
    case 'read_file': return execReadFile(call.args);
    case 'write_file': return execWriteFile(call.args);
    case 'list_files': return execListFiles(call.args);
    case 'run_bash': return execRunBash(call.args);
    case 'send_feishu_message': return execSendFeishu(call.args);
    case 'memory_recall': return execMemoryRecall(call.args);
    case 'memory_save': return execMemorySave(call.args);
    default: return `Error: 未知工具 ${call.name}`;
  }
}
