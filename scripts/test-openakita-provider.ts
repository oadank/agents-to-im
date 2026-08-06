// 端到端测试 OpenAkitaProvider（ACP 模式）
// 运行: npx tsx scripts/test-openakita-provider.ts
import { OpenAkitaProvider } from '../src/providers/openakita/openakita-provider.js';

async function main() {
  console.log('[test] creating provider...');
  const p = new OpenAkitaProvider();

  const params = {
    prompt: '只回复两个字：收到',
    workingDirectory: 'C:\\Users\\oadan\\.openakita\\workspaces\\default',
  } as any;

  const stream = p.streamChat(params);
  const reader = stream.getReader();
  let buf = '';
  const types: Record<string, number> = {};
  let textOut = '';
  const t0 = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value as unknown as string;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        types[ev.type] = (types[ev.type] || 0) + 1;
        if (ev.type === 'text') textOut += ev.data;
        if (ev.type === 'activity_event' && ev.data?.kind === 'reasoning_activity') {
          // 思考流
        }
        console.log('[evt]', ev.type, String(ev.data ?? '').slice(0, 80));
      } catch {}
    }
    if (Date.now() - t0 > 150000) { console.log('[test] TIMEOUT'); break; }
  }

  console.log('[test] types:', JSON.stringify(types));
  console.log('[test] text:', JSON.stringify(textOut));
  console.log('[test] DONE in', Date.now() - t0, 'ms');
  process.exit(0);
}

main().catch((e) => { console.error('[test] FAIL', e); process.exit(1); });
