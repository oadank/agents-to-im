import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type * as lark from '@larksuiteoapi/node-sdk';

import type { FileAttachment } from '../../bridge/types.js';

const isWin = process.platform === 'win32';
const TMP_DIR = isWin
  ? join(tmpdir(), 'agents-to-im-audio')
  : '/tmp/agents-to-im-audio';

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
    const isWin = process.platform === 'win32';
    const transcribeScript = isWin
      ? 'C:\\Users\\oadan\\.openclaw\\workspace\\main\\skills\\voice-engine\\transcribe.ps1'
      : '/opt/.openclaw/workspace/main/skills/voice-engine/transcribe.sh';

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const proc = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-WindowStyle Hidden', '-ExecutionPolicy Bypass', '-File', transcribeScript, audioPath], {
            windowsHide: true,
          })
        : spawn('bash', [transcribeScript, audioPath], {
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

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`ASR 进程退出 (code=${code}): ${stderr.slice(0, 500)}`));
          return;
        }

        const text = stdout.trim();
        if (!text) {
          reject(new Error(`ASR 无输出`));
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

    // 写入临时文件（保留文件用于调试）
    writeFileSync(audioPath, Buffer.from(attachment.data, 'base64'));
    console.log(`[voice-debug] 下载完成: ${audioPath}, size=${Buffer.from(attachment.data, 'base64').length} bytes`);

    try {
      const result = await this.transcribeAudio(audioPath);
      console.log(`[voice-debug] 转写成功: "${result.text}"`);
      return result;
    } catch (error) {
      console.error(`[voice-debug] 转写失败: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      // 保留文件用于调试（不删除）
      console.log(`[voice-debug] 文件保留在: ${audioPath}`);
    }
  }
}
