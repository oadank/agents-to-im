/**
 * Gemini Provider 工具定义 — OpenAI function calling schema
 *
 * 7 个工具：
 *   - read_file / write_file / list_files / run_bash / send_feishu_message
 *   - memory_recall / memory_save
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const GEMINI_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容。可读任意路径的文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径，如 /opt/agents-memory/claude/IDENTITY.md' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件（覆盖）。仅在 cwd (/opt) 范围内允许写入。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（建议绝对路径，须在 /opt 下）' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description: '执行 bash 命令（cwd=/opt，30 秒超时）。禁止 sudo、rm -rf /、curl|sh 等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'bash 命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_feishu_message',
      description: '通过飞书发送消息到指定 chat_id。用阿丹 OAuth token，发送者显示为阿丹。',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: '飞书 chat_id（如 oc_xxx）' },
          text: { type: 'string', description: '消息文本' },
        },
        required: ['chat_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: '查询 agentmemory 长期记忆。用于回忆之前的对话/决策/教训。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回结果数（默认 5）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: '保存重要信息到 agentmemory 长期记忆。',
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
