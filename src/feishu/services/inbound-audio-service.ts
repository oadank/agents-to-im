import { Buffer } from 'node:buffer';
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
    const startTime = Date.now();

    // 统一走 agents-to-im 内建 ASR（不依赖 voice-engine 技能目录）
    // 1. ffmpeg 转 wav（16k 单声道，sherpa-onnx 输入要求）
    // 2. HTTP 调内建 asr-service (127.0.0.1:18790/transcribe)
    // 3. 标点恢复（add-punctuation.mjs，纯正则无依赖）

    const wavPath = audioPath.replace(/\.[^.]+$/, '') + '.wav';

    try {
      // 1. ffmpeg 转换
      const { spawnSync } = await import('node:child_process');
      const ffmpeg = process.env.ASR_FFMPEG_BIN
        || (isWin ? 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe' : 'ffmpeg');
      const ffmpegResult = spawnSync(ffmpeg, ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], {
        windowsHide: true,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (ffmpegResult.error || ffmpegResult.status !== 0) {
        const errorMsg = ffmpegResult.error?.message || ffmpegResult.stderr?.toString() || 'Unknown ffmpeg error';
        throw new Error(`ffmpeg 音频转换失败: ${errorMsg.slice(0, 300)}`);
      }

      // 2. HTTP 调内建 asr-service（端口 18790）
      const { request } = await import('node:http');
      const postData = JSON.stringify({ audioPath: wavPath });
      const text = await new Promise<string>((resolve, reject) => {
        const req = request({
          hostname: '127.0.0.1',
          port: Number(process.env.ASR_SERVICE_PORT || 18790),
          path: '/transcribe',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 60000,
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.error) reject(new Error(result.error));
              else resolve(result.text || '');
            } catch (e) {
              reject(new Error(`解析 ASR 响应失败: ${e instanceof Error ? e.message : String(e)}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('ASR 服务请求超时'));
        });
        req.write(postData);
        req.end();
      });

      if (!text) throw new Error('ASR 无输出');

      // 3. 标点恢复（内置 add-punctuation，纯正则无外部依赖，import 打包进 dist）
      let finalText = text;
      try {
        const { default: addPunct } = await import('../add-punctuation.mjs');
        if (typeof addPunct === 'function') {
          const punctOut = addPunct(text);
          if (punctOut) finalText = String(punctOut).trim();
        } else if (addPunct && typeof (addPunct as any).default === 'function') {
          const punctOut = (addPunct as any).default(text);
          if (punctOut) finalText = String(punctOut).trim();
        }
      } catch {
        // 标点恢复失败不影响主流程
      }

      return { text: finalText, duration_ms: Date.now() - startTime };
    } finally {
      // 清理临时 wav
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(wavPath);
      } catch { /* ignore */ }
    }
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
