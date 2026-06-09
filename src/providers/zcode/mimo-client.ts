/**
 * MiMo API Client — 直接调用 LiteLLM 代理的 MiMo 模型
 * 替代 zcode-acp / gemini.js / opencode CLI，实现 OpenAI 兼容的 tool calling
 */

export interface MiMoMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: MiMoToolCall[];
  tool_call_id?: string;
}

export interface MiMoToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface MiMoTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface MiMoChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: MiMoToolCall[];
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface MiMoResponse {
  id: string;
  choices: MiMoChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const MIMO_API_BASE = process.env.CTI_ZCODE_OPENAI_BASE_URL
  || process.env.OPENAI_BASE_URL
  || 'http://debian.tailb5f10f.ts.net:4000/v1';

const MIMO_API_KEY = process.env.CTI_ZCODE_OPENAI_API_KEY
  || process.env.OPENAI_API_KEY
  || '';

const MIMO_MODEL = 'MiMo-OpenAI';

/**
 * 调用 MiMo API（OpenAI 兼容格式）
 * 支持 tool calling，返回 choices[0] 的文本和工具调用
 */
export async function callMiMoApi(
  messages: MiMoMessage[],
  tools?: MiMoTool[],
  options?: { timeoutMs?: number; model?: string },
): Promise<MiMoChoice> {
  const timeout = options?.timeoutMs ?? 120_000;
  const model = options?.model ?? MIMO_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: 4096,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(`${MIMO_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(MIMO_API_KEY ? { 'Authorization': `Bearer ${MIMO_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`MiMo API error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json() as MiMoResponse;
    if (!data.choices || data.choices.length === 0) {
      throw new Error('MiMo API returned no choices');
    }

    return data.choices[0];
  } finally {
    clearTimeout(timer);
  }
}
