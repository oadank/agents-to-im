// 用 lark-cli im +messages-send --content --msg-type post 发送带 @ 的富文本消息
// 飞书 post 消息 @：content 里用 {"tag":"at","user_id":"ou_xxx","user_name":"名称"}
// 用法: node send-feishu.cjs [chatId] [text] [target1,target2...|all]
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 通讯录/默认群聊从本地 contacts.json 读取（勿提交真实 open_id；模板见 contacts.example.json）
const contactsPath = path.join(__dirname, 'contacts.json');
let CONTACTS = { chatIdDefault: '', openIds: {} };
if (fs.existsSync(contactsPath)) {
  try { CONTACTS = JSON.parse(fs.readFileSync(contactsPath, 'utf8')); } catch {}
}
const OPEN_IDS = CONTACTS.openIds || {};

const runJs = path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
const node = process.execPath;

const [, , chatIdArg, textArg, targetsArg] = process.argv;
const chatId = chatIdArg || CONTACTS.chatIdDefault;
const text = textArg || '';
const targets = targetsArg === 'all'
  ? Object.keys(OPEN_IDS)
  : (targetsArg || '').split(',').filter(Boolean);

// 构造 post 格式的 content（富文本，支持真正的 @ 提及）
// 格式：每行是一个数组，@ 和文字可以混排
const contentLines = [];

// 第一行：所有 @ 提及
const atElements = [];
targets.forEach((t) => {
  const id = OPEN_IDS[t];
  if (id) {
    atElements.push({ tag: 'at', user_id: id, user_name: t });
  }
});

// 第二行：消息正文
const textLine = [{ tag: 'text', text: ' ' + text }];

if (atElements.length > 0) {
  contentLines.push(atElements);
}
contentLines.push(textLine);

const content = JSON.stringify({
  zh_cn: {
    title: '',
    content: contentLines,
  },
});

const args = ['im', '+messages-send', '--chat-id', chatId, '--content', content, '--msg-type', 'post', '--as', 'user'];
const dry = process.env.CTI_DRY === '1';
const finalArgs = dry ? [...args, '--dry-run'] : args;
console.error('CONTENT:', content);
const r = spawnSync(node, [runJs, ...finalArgs], { encoding: 'utf8' });
console.log(r.stdout);
if (r.stderr) console.error('STDERR:', r.stderr.slice(0, 400));
