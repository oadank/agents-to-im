#!/usr/bin/env node
/**
 * send-reasonix.cjs — 用 reasonix 应用身份直连飞书 API 发消息
 * 绕过 lark-cli profile 的 keychain 存储 bug（config init 后 invalid_client 20002）。
 * 每次调用现取 tenant_access_token（app_id+secret → token），再发消息。
 *
 * 用法:
 *   node send-reasonix.cjs <chatId> <text> [target1,target2...|all]   # post 格式 @ 目标 + 文本
 *   node send-reasonix.cjs <chatId> --text <text>                     # 纯 text 消息
 *
 * 目标名映射见 OPEN_IDS（团队群通讯录）。target 用 'all' 全体 @。
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// 通讯录/默认群聊从本地 contacts.json 读取（勿提交真实 open_id；模板见 contacts.example.json）
const contactsPath = path.join(__dirname, 'contacts.json');
let CONTACTS = { chatIdDefault: '', appId: '', openIds: {} };
if (fs.existsSync(contactsPath)) {
  try { CONTACTS = JSON.parse(fs.readFileSync(contactsPath, 'utf8')); } catch {}
}

const APP_ID = process.env.REASONIX_APP_ID || process.env.CTI_BOT_REASONIX_APP_ID || CONTACTS.appId;
// APP_SECRET 必须走环境变量，禁止硬编码/写入仓库。
// 兼容两种命名：独立脚本环境 REASONIX_APP_SECRET；PM2 bot 环境 CTI_BOT_REASONIX_APP_SECRET。
const APP_SECRET = process.env.REASONIX_APP_SECRET || process.env.CTI_BOT_REASONIX_APP_SECRET;
if (!APP_SECRET) {
  console.error('ERR: 缺少环境变量 REASONIX_APP_SECRET（或 CTI_BOT_REASONIX_APP_SECRET），勿写入仓库');
  process.exit(1);
}
const CHAT_ID_DEFAULT = CONTACTS.chatIdDefault;
const OPEN_IDS = CONTACTS.openIds || {};

function httpsReq(path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'open.feishu.cn', path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
  const r = await httpsReq(
    '/open-apis/auth/v3/tenant_access_token/internal',
    'POST',
    { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    body
  );
  const j = JSON.parse(r.body);
  if (j.code !== 0) throw new Error('get tenant_access_token failed: ' + r.body);
  return j.tenant_access_token;
}

async function send(chatId, msgType, contentJson) {
  const token = await getToken();
  const body = JSON.stringify({
    receive_id: chatId,
    receive_id_type: 'chat_id',
    msg_type: msgType,
    content: contentJson,
  });
  const r = await httpsReq(
    '/open-apis/im/v1/messages?receive_id_type=chat_id',
    'POST',
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': 'Bearer ' + token,
      'Content-Length': Buffer.byteLength(body),
    },
    body
  );
  console.log('HTTP', r.status);
  console.log(r.body);
  return r;
}

async function main() {
  const [, , chatIdArg, arg2, arg3] = process.argv;
  const chatId = chatIdArg || CHAT_ID_DEFAULT;

  // 模式1: node send-reasonix.cjs <chatId> --text <text>
  if (arg2 === '--text') {
    const text = arg3 || '';
    await send(chatId, 'text', JSON.stringify({ text }));
    return;
  }

  // 模式2: node send-reasonix.cjs <chatId> <text> [target1,target2|all]
  const text = arg2 || '';
  const targets = arg3 === 'all'
    ? Object.keys(OPEN_IDS)
    : (arg3 || '').split(',').filter(Boolean);

  const atElements = targets
    .map((t) => ({ name: t, id: OPEN_IDS[t] }))
    .filter((x) => x.id)
    .map((x) => ({ tag: 'at', user_id: x.id, user_name: x.name }));

  const contentLines = [];
  if (atElements.length > 0) contentLines.push(atElements);
  contentLines.push([{ tag: 'text', text: ' ' + text }]);

  const content = JSON.stringify({ zh_cn: { title: '', content: contentLines } });
  await send(chatId, 'post', content);
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});