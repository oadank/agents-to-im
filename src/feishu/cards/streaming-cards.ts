import {
  STREAM_ELEMENT_ID,
  STREAM_PLACEHOLDER_TEXT,
} from '../constants.js';
import type { AgentDividerInfo } from '../../bridge/markdown/feishu.js';

export function buildStreamingCardSkeleton(dividerInfo?: AgentDividerInfo): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: '',
      element_id: STREAM_ELEMENT_ID,
    },
  ];

  // Add agent info if provided (use markdown separator — divider tag not supported by all Feishu app types)
  if (dividerInfo) {
    const parts: string[] = [];
    if (dividerInfo.agent) parts.push(`Agent: ${dividerInfo.agent}`);
    if (dividerInfo.model) parts.push(`Model: ${dividerInfo.model}`);
    if (dividerInfo.provider) parts.push(`Provider: ${dividerInfo.provider}`);
    
    const infoText = parts.join(' | ') || 'Agent: N/A';
    elements.push({
      tag: 'markdown',
      content: `---\n${infoText}`,
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}
