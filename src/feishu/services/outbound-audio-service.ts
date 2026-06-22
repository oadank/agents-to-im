import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';

import type { ChannelAddress } from '../../bridge/types.js';

const TMP_DIR = '/tmp/agents-to-im-audio';
const TTS_WRAPPER = '/opt/.claude/skills/voice-engine/tts-wrapper.mjs';

export interface AudioReplyResult {
  success: boolean;
  fileKey?: string;
  error?: string;
}

export class OutboundAudioService {
  constructor(
    private readonly getClient: () => lark.Client | null,
  ) {}

  /**
   * Generate audio from text using TTS wrapper
   * Returns the path to the generated audio file (OPUS format for Feishu)
   */
  async generateAudio(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [TTS_WRAPPER, text], {
        env: {
          ...process.env,
          TTS_CHANNEL: 'feishu', // OPUS format for Feishu
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
        if (code !== 0) {
          reject(new Error(`TTS failed (code=${code}): ${stderr || stdout}`));
          return;
        }

        // TTS wrapper outputs file path to stderr with [TTS_OUTPUT] marker
        // Format: [TTS_OUTPUT] /tmp/openclaw/小米TTS.opus
        const pathMatch = stderr.match(/\[TTS_OUTPUT\]\s*(\/tmp\/[^\s\n]+\.(opus|mp3))/);
        const audioPath = pathMatch ? pathMatch[1] : null;

        if (!audioPath || !existsSync(audioPath)) {
          reject(new Error(`TTS output invalid: ${audioPath || 'no path found in stderr'}`));
          return;
        }

        resolve(audioPath);
      });

      proc.on('error', (err) => {
        reject(new Error(`TTS process error: ${err.message}`));
      });
    });
  }

  /**
   * Upload audio file to Feishu and get file_key
   */
  async uploadAudioFile(filePath: string): Promise<string> {
    const client = this.getClient();
    if (!client) {
      throw new Error('Feishu client not initialized');
    }

    // Use im.file.create for audio upload (similar to image upload)
    const audioBuffer = readFileSync(filePath);

    // Feishu file upload API
    const response = await client.im.file.create({
      data: {
        file_type: 'opus', // Voice message uses opus format
        file: audioBuffer,
      },
    });

    const fileKey = response?.file_key;
    if (!fileKey) {
      throw new Error('Feishu audio upload succeeded without file_key');
    }

    return fileKey;
  }

  /**
   * Send audio message to Feishu chat
   */
  async sendAudioMessage(
    address: ChannelAddress,
    fileKey: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      throw new Error('Feishu client not initialized');
    }

    const chatId = address.chatId;

    // Send audio message
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'audio',
        content: JSON.stringify({
          file_key: fileKey,
        }),
      },
    });

    console.log(`[feishu-adapter] Audio message sent to chat ${chatId}`);
  }

  /**
   * Full pipeline: TTS + Upload + Send
   */
  async sendAudioReply(
    address: ChannelAddress,
    text: string,
    replyToMessageId?: string,
  ): Promise<AudioReplyResult> {
    try {
      console.log(`[feishu-adapter] Generating audio reply for: "${text.slice(0, 50)}..."`);

      // 1. Generate audio via TTS
      const audioPath = await this.generateAudio(text);
      console.log(`[feishu-adapter] TTS generated: ${audioPath}`);

      // 2. Upload to Feishu
      const fileKey = await this.uploadAudioFile(audioPath);
      console.log(`[feishu-adapter] Audio uploaded: file_key=${fileKey}`);

      // 3. Send audio message
      await this.sendAudioMessage(address, fileKey, replyToMessageId);

      // 4. Clean up temp file
      try {
        unlinkSync(audioPath);
      } catch {
        // Ignore cleanup errors
      }

      return { success: true, fileKey };
    } catch (error) {
      console.error('[feishu-adapter] Audio reply failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}