/**
 * OpenAI Whisper API 兼容适配层
 * 转发到本地 asr-service (端口 18790)
 * 端口 18791
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PORT = 18791;
const ASR_BACKEND = 'http://localhost:18790';

const server = http.createServer(async (req, res) => {
  // 请求日志
  console.log(`[ASR-Compat] ${req.method} ${req.url} headers: ${JSON.stringify(req.headers)}`);
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /v1/models - 返回模型列表
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'sensevoice-int8', object: 'model', owned_by: 'local' }]
    }));
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // POST /v1/audio/transcriptions - 接收 multipart 音频，转发到 asr-service
  if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing boundary in Content-Type' }));
      return;
    }
    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const tmpFile = path.join(os.tmpdir(), `asr-${crypto.randomUUID()}.wav`);

        // 提取 multipart 中的音频二进制
        const audioData = extractMultipartFile(buf, boundary);
        if (!audioData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No file found in multipart' }));
          return;
        }

        // 写临时文件
        fs.writeFileSync(tmpFile, audioData.data);
        const ext = audioData.filename.match(/\.(wav|mp3|ogg|flac|m4a|webm)$/i);
        const finalFile = ext ? tmpFile.replace('.wav', ext[0]) : tmpFile;
        if (finalFile !== tmpFile) fs.renameSync(tmpFile, finalFile);

        // 转发到 asr-service
        const result = await postJSON(`${ASR_BACKEND}/transcribe`, { audioPath: finalFile });

        // 清理临时文件
        try { fs.unlinkSync(finalFile); } catch {}

        // 返回 OpenAI Whisper 格式
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: result.text || '' }));
      } catch (err) {
        console.error('[ASR-Compat] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// 从 multipart body 中提取文件二进制
function extractMultipartFile(buf, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  let start = 0;
  const parts = [];
  while (true) {
    const idx = buf.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buf.subarray(start, idx));
    start = idx + sep.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // --
    start += 2; // skip \r\n
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString();
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (!filenameMatch) continue;
    const data = part.subarray(headerEnd + 4, part.length - 2); // trim trailing \r\n
    return { filename: filenameMatch[1], data };
  }
  return null;
}

// POST JSON helper
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON: ${body.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

server.listen(PORT, () => {
  console.log(`[ASR-Compat] OpenAI Whisper 兼容层启动，端口 ${PORT}`);
  console.log(`[ASR-Compat] 转发到 ${ASR_BACKEND}`);
});
