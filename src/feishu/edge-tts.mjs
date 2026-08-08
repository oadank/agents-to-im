/**
 * Microsoft Edge TTS - Node.js 原生客户端
 * 
 * 对齐 Python edge-tts v7.2.8 的 DRM + Headers
 * 关键: Sec-MS-GEC 令牌必须放在 URL 参数里（不是 headers）
 */

import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;

function generateSecMsGec() {
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function generateMuid() {
  return randomBytes(16).toString('hex').toUpperCase();
}

function uuid() {
  return crypto.randomUUID().replaceAll('-', '');
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getWssUrl() {
  return `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

function getWssHeaders() {
  return {
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `muid=${generateMuid()};`,
  };
}

export function tts(text, voice = 'zh-CN-XiaoxiaoNeural') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWssUrl(), { headers: getWssHeaders() });
    const audioData = [];
    let messageTimeout;

    // 连接超时（10秒）
    const connectTimeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket 连接超时（10秒）'));
    }, 10000);

    ws.on('message', (rawData, isBinary) => {
      if (!isBinary) {
        const str = rawData.toString('utf8');
        if (str.includes('turn.end')) {
          clearTimeout(messageTimeout);
          resolve(Buffer.concat(audioData));
          ws.close();
        }
        return;
      }
      const separator = 'Path:audio\r\n';
      const idx = rawData.indexOf(separator);
      if (idx !== -1) audioData.push(rawData.subarray(idx + separator.length));
    });

    ws.on('error', (err) => {
      clearTimeout(connectTimeout);
      reject(err);
    });

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      
      // 消息处理超时（30秒）
      messageTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('消息处理超时（30秒）'));
      }, 30000);
      
      const speechConfig = JSON.stringify({
        context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        } } },
      });
      
      const configMsg = `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`;
      ws.send(configMsg, { compress: true });
      
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      const ssmlMsg = `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${Date()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg, { compress: true });
    });
  });
}

// 本模块只导出 tts()，不执行 CLI 逻辑（CLI 入口在 tts-cli.mjs，避免 bundle 后误执行）。
