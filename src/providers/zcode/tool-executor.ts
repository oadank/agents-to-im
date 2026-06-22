/**
 * Tool Executor — 本地执行 ZCode agents 的工具
 * 替代 ZCode desktop 的工具执行，直接在 agents-to-im 进程中运行
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { MiMoTool } from './mimo-client.js';

export interface ToolResult {
  content: string;
  isError: boolean;
}

// ─── 工具定义（MiMo API 格式）───────────────────────────────

export const ZCODE_TOOLS: MiMoTool[] = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取文件内容。返回文件的完整文本。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要读取的文件绝对路径' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '写入文件内容。如果文件已存在会覆盖。写入前会自动备份原文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要写入的文件绝对路径' },
          content: { type: 'string', description: '要写入的内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: '执行终端命令。返回命令的 stdout 和 stderr。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 bash 命令' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ListFiles',
      description: '列出目录中的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: '要列出的目录绝对路径' },
        },
        required: ['dir_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: '搜索过去的对话记忆和观察记录。用于回忆之前讨论过的内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: '将重要信息保存到长期记忆中。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要保存的内容' },
          type: { type: 'string', description: '记忆类型：pattern/preference/architecture/bug/workflow/fact' },
        },
        required: ['content'],
      },
    },
  },
];

// ─── 工具执行──────────────────────────────────────────────

/**
 * 执行单个工具调用
 * @param name 工具名称
 * @param input 工具参数（JSON 字符串或已解析的对象）
 * @param cwd 当前工作目录
 */
export async function executeTool(
  name: string,
  input: string | Record<string, unknown>,
  cwd?: string,
): Promise<ToolResult> {
  const args = typeof input === 'string' ? JSON.parse(input) : input;

  try {
    switch (name) {
      case 'Read':
        return execRead(args.file_path as string);
      case 'Write':
        return execWrite(args.file_path as string, args.content as string);
      case 'Bash':
        return execBash(args.command as string, args.timeout as number | undefined, cwd);
      case 'ListFiles':
        return execListFiles(args.dir_path as string);
      case 'memory_recall':
        return execMemoryRecall(args.query as string);
      case 'memory_save':
        return execMemorySave(args.content as string, args.type as string | undefined);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Tool error (${name}): ${msg}`, isError: true };
  }
}

// ─── 各工具实现────────────────────────────────────────────

function execRead(filePath: string): ToolResult {
  if (!fs.existsSync(filePath)) {
    return { content: `File not found: ${filePath}`, isError: true };
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return { content: `Is a directory: ${filePath}. Use ListFiles instead.`, isError: true };
  }
  // 限制文件大小 1MB
  if (stat.size > 1_000_000) {
    return { content: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`, isError: true };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return { content, isError: false };
}

function execWrite(filePath: string, content: string): ToolResult {
  // 写入前备份
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  // 确保父目录存在
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return { content: `Written ${content.length} bytes to ${filePath}`, isError: false };
}

function execBash(command: string, timeoutMs?: number, cwd?: string): ToolResult {
  const timeout = timeoutMs ?? 30_000;
  try {
    const stdout = execSync(command, {
      cwd: cwd || process.cwd(),
      timeout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { content: stdout || '(no output)', isError: false };
  } catch (err: unknown) {
    // execSync throws on non-zero exit code
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const parts: string[] = [];
    if (e.stdout) parts.push(`stdout:\n${e.stdout}`);
    if (e.stderr) parts.push(`stderr:\n${e.stderr}`);
    if (parts.length === 0) parts.push(e.message || 'Unknown error');
    return { content: parts.join('\n'), isError: true };
  }
}

function execListFiles(dirPath: string): ToolResult {
  if (!fs.existsSync(dirPath)) {
    return { content: `Directory not found: ${dirPath}`, isError: true };
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return { content: `Not a directory: ${dirPath}`, isError: true };
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = entries.map(e => {
    const suffix = e.isDirectory() ? '/' : '';
    return `${e.name}${suffix}`;
  });
  return { content: lines.join('\n') || '(empty directory)', isError: false };
}

const AGENTMEMORY_URL = 'http://127.0.0.1:3111';

async function execMemoryRecall(query: string): Promise<ToolResult> {
  try {
    const resp = await fetch(`${AGENTMEMORY_URL}/api/memory/smart-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 5 }),
    });
    if (!resp.ok) return { content: `agentmemory error: ${resp.status}`, isError: true };
    const data = await resp.json() as { results?: Array<{ content: string; score?: number }> };
    const results = data.results || [];
    if (results.length === 0) return { content: 'No matching memories found.', isError: false };
    const text = results.map((r, i) => `[${i + 1}] (score: ${r.score?.toFixed(2) ?? '?'}) ${r.content}`).join('\n\n');
    return { content: text, isError: false };
  } catch (err) {
    return { content: `agentmemory connection error: ${err instanceof Error ? err.message : err}`, isError: true };
  }
}

async function execMemorySave(content: string, type?: string): Promise<ToolResult> {
  try {
    const resp = await fetch(`${AGENTMEMORY_URL}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, type: type || 'fact' }),
    });
    if (!resp.ok) return { content: `agentmemory save error: ${resp.status}`, isError: true };
    return { content: 'Memory saved successfully.', isError: false };
  } catch (err) {
    return { content: `agentmemory connection error: ${err instanceof Error ? err.message : err}`, isError: true };
  }
}

// ─── 工具分类：哪些需要权限审批─────────────────────────────

/** 需要用户审批的工具 */
export const TOOLS_REQUIRING_PERMISSION = new Set(['Write', 'Bash']);

/** 自动批准的工具 */
export function isAutoApprove(toolName: string): boolean {
  return !TOOLS_REQUIRING_PERMISSION.has(toolName);
}
