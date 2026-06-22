import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type * as lark from '@larksuiteoapi/node-sdk';

import type { FileAttachment } from '../../bridge/types.js';

const TMP_DIR = '/tmp/agents-to-im-audio';

export interface TranscribeResult {
  text: string;
  duration_ms?: number;
}

export class InboundAudioService {
  constructor(
    private readonly getClient: () => lark.Client | null,
  ) {
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true });
    }
  }

  async downloadInboundAudioAttachment(messageId: string, fileKey: string): Promise<FileAttachment> {
    const client = this.getClient();
    if (!client?.im?.messageResource?.get) {
      throw new Error('Feishu 音频资源下载能力不可用');
    }
    const response = await client.im.messageResource.get({
      params: { type: 'file' }, // 飞书语音用 file 类型
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
    });
    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const contentType = typeof response.headers?.['content-type'] === 'string'
      ? response.headers['content-type']
      : 'audio/opus';
    const extension = contentType.includes('opus') ? 'opus'
      : contentType.includes('ogg') ? 'ogg'
      : contentType.includes('mp3') ? 'mp3'
      : contentType.includes('wav') ? 'wav'
      : 'opus';
    return {
      id: `feishu-audio:${messageId}`,
      name: `feishu-audio-${messageId}.${extension}`,
      type: contentType,
      size: buffer.length,
      data: buffer.toString('base64'),
    };
  }

  async transcribeAudio(audioPath: string): Promise<TranscribeResult> {
    const transcribeScript = '/opt/.codex/skills/voice-engine/transcribe.sh';
    
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', [transcribeScript, audioPath], {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: '/sherpa-onnx/lib:' + (process.env.LD_LIBRARY_PATH || ''),
        },
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
        const duration_ms = Date.now() - startTime;
        
        if (code !== 0) {
          reject(new Error(`ASR 失败 (code=${code}): ${stderr || stdout}`));
          return;
        }
        
        const text = stdout.trim();
        if (!text || text.startsWith('[转码失败]') || text.startsWith('[ASR 无结果]')) {
          reject(new Error(`ASR 无结果: ${text}`));
          return;
        }
        
        resolve({ text, duration_ms });
      });
      
      proc.on('error', (err) => {
        reject(new Error(`ASR 进程启动失败: ${err.message}`));
      });
    });
  }

  async downloadAndTranscribe(messageId: string, fileKey: string): Promise<TranscribeResult> {
    const attachment = await this.downloadInboundAudioAttachment(messageId, fileKey);
    const audioPath = join(TMP_DIR, attachment.name);
    
    // 写入临时文件
    writeFileSync(audioPath, Buffer.from(attachment.data, 'base64'));
    
    try {
      const result = await this.transcribeAudio(audioPath);
      return result;
    } finally {
      // 清理临时文件
      try {
        unlinkSync(audioPath);
      } catch {
        // 忽略删除失败
      }
    }
  }
}
