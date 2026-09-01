// Provider-level e2e: drive DshProvider.streamChat exactly as the daemon would.
import { DshProvider } from './src/providers/dsh/dsh-provider.js';

const p = new DshProvider();
const t0 = Date.now();
await p.prepare();
console.log('[prepare] OK (' + (Date.now() - t0) + 'ms)');

const stream = p.streamChat({
  prompt: 'Reply with exactly: HELLO_DSH_OK',
  sessionId: 'provider-test',
  sdkSessionId: 'provider-test',
  workingDirectory: process.env.CTI_DSH_ACP_CWD || 'C:\\D\\opt',
});
const reader = stream.getReader();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += value;
}
console.log('[stream] first 600 chars:\n' + buf.slice(0, 600));
console.log('[stream] total length: ' + buf.length);
const hasText = buf.includes('HELLO_DSH_OK');
console.log('[assert] contains HELLO_DSH_OK: ' + hasText);
process.exit(hasText ? 0 : 1);
