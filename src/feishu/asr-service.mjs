/**
 * 常驻 ASR 服务 - sherpa-onnx HTTP 接口
 * 模型只加载一次，通过 HTTP 接收识别请求
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = 18790;
const SHERPA_BIN = 'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe';
const MODEL_DIR = 'C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8';

console.log(`[ASR-Service] 启动常驻 ASR 服务，端口 ${PORT}`);
console.log(`[ASR-Service] sherpa-onnx: ${SHERPA_BIN}`);
console.log(`[ASR-Service] 模型目录: ${MODEL_DIR}`);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/transcribe') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { audioPath } = JSON.parse(body);
        
        if (!audioPath || !existsSync(audioPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无效的音频文件路径' }));
          return;
        }

        console.log(`[ASR-Service] 收到识别请求: ${audioPath}`);
        const startTime = Date.now();

        // 调用 sherpa-onnx - 注意：输出在 stderr！
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(SHERPA_BIN, [
          `--tokens=${MODEL_DIR}\\tokens.txt`,
          `--sense-voice-model=${MODEL_DIR}\\model.int8.onnx`,
          '--num-threads=4',
          audioPath,
        ], {
          windowsHide: true,
          timeout: 30000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],  // 捕获 stdout 和 stderr
        });
        
        // sherpa-onnx 把结果输出到 stderr
        const fullOutput = (result.stdout || '') + '\n' + (result.stderr || '');
        
        // 检查执行是否失败
        if (result.error) {
          throw new Error(`sherpa-onnx 执行失败: ${result.error.message}`);
        }
        if (result.status !== 0) {
          throw new Error(`sherpa-onnx 退出码 ${result.status}: ${fullOutput.substring(0, 200)}`);
        }
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[ASR-Service] 识别完成 (${elapsed}s): ${fullOutput.substring(0, 100)}`);
        
        // 解析 JSON 输出
        const lines = fullOutput.split('\n');
        let text = '';
        for (const line of lines) {
          if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
            try {
              const jsonOutput = JSON.parse(line.trim());
              text = jsonOutput.text || '';
              break;
            } catch {
              const match = line.match(/"text":\s*"([^"]+)"/);
              if (match) {
                text = match[1];
                break;
              }
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text, elapsed }));
      } catch (err) {
        console.error(`[ASR-Service] 识别错误: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: 'sensevoice-int8' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[ASR-Service] 服务已启动，监听 http://localhost:${PORT}`);
});
