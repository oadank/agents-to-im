/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Strip <think>...</think> tags from text, returning cleaned text and extracted thinking.
 * Used by mimo provider to separate thinking from response content.
 */
export function extractThinkingFromText(text: string): { cleanText: string; thinking: string } {
  let thinking = '';
  const openTag = '<' + 'think>';
  const closeTag = '<' + '/think>';
  const thinkRegex = new RegExp(openTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)' + closeTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1].trim() + '\n';
  }
  const cleanText = text.replace(thinkRegex, '').trim();
  return { cleanText, thinking: thinking.trim() };
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Agent divider info for the footer separator.
 */
export interface AgentDividerInfo {
  /** Agent name (e.g., feishu-mimo) */
  agent?: string;
  /** Runtime name (e.g., claude, codex) */
  runtime?: string;
  /** Model name (e.g., codex-model) */
  model?: string;
  /** Provider name (e.g., LiteLLM) */
  provider?: string;
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string, dividerInfo?: AgentDividerInfo): string {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: text,
    },
  ];

  // Add divider and agent info if provided
  if (dividerInfo) {
    // Add divider element
    elements.push({ tag: 'divider' });

    // Build info text (Agent / Model / Provider only — no Runtime)
    const parts: string[] = [];
    if (dividerInfo.agent) parts.push(`Agent: ${dividerInfo.agent}`);
    if (dividerInfo.model) parts.push(`Model: ${dividerInfo.model}`);
    if (dividerInfo.provider) parts.push(`Provider: ${dividerInfo.provider}`);

    const infoText = parts.join(' | ') || 'Agent: N/A';
    elements.push({
      tag: 'markdown',
      content: infoText,
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements,
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string, dividerInfo?: AgentDividerInfo): string {
  let finalText = text;

  // Add divider info if provided
  if (dividerInfo) {
    const parts: string[] = [];
    if (dividerInfo.agent) parts.push(`Agent: ${dividerInfo.agent}`);
    if (dividerInfo.model) parts.push(`Model: ${dividerInfo.model}`);
    if (dividerInfo.provider) parts.push(`Provider: ${dividerInfo.provider}`);

    const infoText = parts.join(' | ') || 'Agent: N/A';
    finalText = `${text}\n\n---\n${infoText}`;
  }

  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: finalText }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
