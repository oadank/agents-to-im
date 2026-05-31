/**
 * Conversation Compaction — uses a separate LLM call to summarize conversation history.
 * Supports partial compaction: summarizes older messages, keeps recent messages intact.
 * Based on cc-haha's built-in compact mechanism.
 */

import type { BridgeMessage, BridgeStore } from './host.js';
import type { CompactConfig } from '../config/config.js';

/** Per-session compact lock to prevent concurrent compaction */
const compactLocks = new Map<string, boolean>();

/** How many recent messages to preserve verbatim after compaction */
const PRESERVE_RECENT_COUNT = 6;

const COMPACT_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

export interface CompactResult {
  success: boolean;
  summary?: string;
  /** Recent messages preserved verbatim (empty for full compact) */
  preservedMessages?: BridgeMessage[];
  originalCount: number;
  error?: string;
}

async function callCompactApi(
  prompt: string,
  compactConfig: CompactConfig,
): Promise<{ text?: string; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = compactConfig.model || 'codex-model';

  if (!apiKey) return { error: 'ANTHROPIC_API_KEY 未设置' };

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: compactConfig.maxTokens || 3000,
        temperature: compactConfig.temperature || 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { error: `API 错误 ${response.status}: ${errorText}` };
    }

    const data = await response.json() as any;
    const text = data?.content?.[0]?.text;
    if (!text) return { error: 'API 返回空摘要' };
    return { text };
  } catch (err: any) {
    return { error: `请求失败: ${err.message}` };
  }
}

/**
 * Partial compact: summarize older messages, preserve recent messages verbatim.
 * This is the primary mode — like cc-haha's autoCompact.
 */
export async function compactConversation(
  store: BridgeStore,
  sessionId: string,
  compactConfig: CompactConfig,
): Promise<CompactResult> {
  // Prevent concurrent compaction on the same session
  if (compactLocks.get(sessionId)) {
    return { success: false, originalCount: 0, error: '该会话正在压缩中，请稍后再试' };
  }
  compactLocks.set(sessionId, true);

  try {
  const { messages } = store.getMessages(sessionId, { limit: 9999 });
  if (messages.length < 4) {
    return { success: false, originalCount: messages.length, error: '消息太少，无需压缩' };
  }

  // Split: summarize older messages, preserve recent ones
  const preserveCount = Math.min(PRESERVE_RECENT_COUNT, Math.floor(messages.length / 2));
  const messagesToSummarize = messages.slice(0, -preserveCount);
  const messagesToKeep = messages.slice(-preserveCount);

  if (messagesToSummarize.length < 2) {
    return { success: false, originalCount: messages.length, error: '需要压缩的消息太少' };
  }

  // Build conversation text for the summarization part
  const conversationText = messagesToSummarize
    .map((m: BridgeMessage) => {
      const role = m.role === 'user' ? 'Human' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `<${role}>\n${content}\n</${role}>`;
    })
    .join('\n\n');

  const fullPrompt = `${COMPACT_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`;

  const result = await callCompactApi(fullPrompt, compactConfig);
  if (result.error) {
    return { success: false, originalCount: messages.length, error: result.error };
  }

  return {
    success: true,
    summary: result.text!,
    preservedMessages: messagesToKeep,
    originalCount: messages.length,
  };
  } finally {
    compactLocks.set(sessionId, false);
  }
}

/**
 * Apply compact result: replace messages with summary + preserved messages.
 */
export function applyCompactResult(
  store: BridgeStore,
  sessionId: string,
  result: CompactResult,
): void {
  if (!result.success || !result.summary) return;

  store.clearSessionMessages(sessionId);

  // Add summary
  store.addMessage(sessionId, 'user', `[会话已压缩]\n\n${result.summary}`);

  // Re-add preserved recent messages (if any)
  if (result.preservedMessages && result.preservedMessages.length > 0) {
    for (const msg of result.preservedMessages) {
      store.addMessage(sessionId, msg.role, msg.content);
    }
  }
}
