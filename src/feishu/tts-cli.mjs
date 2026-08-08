#!/usr/bin/env node
/**
 * TTS CLI 入口：node tts-cli.mjs "要说的话" [--provider auto]
 * 供手动测试/脚本调用。agents-to-im 运行时走 import（见 tts-wrapper.mjs synthesize）。
 */
import { synthesize } from './tts-wrapper.mjs';

const text = process.argv[2];
if (!text) {
  console.error('用法: node tts-cli.mjs "要说的话" [--provider auto|edge|melo|matcha|xiaomi|wangwang|ali]');
  process.exit(1);
}

const providerIdx = process.argv.indexOf('--provider');
const provider = providerIdx >= 0 ? process.argv[providerIdx + 1] : 'auto';

const result = await synthesize(text, { channel: 'feishu', provider });
if (result) {
  process.stdout.write(result.path + '\n');
  process.exit(0);
}
process.exit(1);
