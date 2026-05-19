#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/cli.ts
import fs3 from "node:fs";
import path2 from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execSync as execSync2, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/cli-upgrade.ts
import fs from "node:fs";
import path from "node:path";
var DEFAULT_UPGRADE_PACKAGE_SPEC = "agents-to-im";
function hasDirtyGitWorktree(statusOutput) {
  return statusOutput.split(/\r?\n/).some((line) => line.trim().length > 0);
}
function findAgentsToImPackageRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "agents-to-im") {
          return current;
        }
      } catch {
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
function readAgentsToImVersion(packageRoot) {
  const pkgPath = path.join(packageRoot, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}
function buildUpgradePlan(options) {
  const packageSpec = options.packageSpec || DEFAULT_UPGRADE_PACKAGE_SPEC;
  if (options.isSourceCheckout) {
    if (hasDirtyGitWorktree(options.gitStatusOutput || "")) {
      return {
        ok: false,
        reason: "Source checkout has uncommitted changes. Commit or stash them before running upgrade."
      };
    }
    return {
      ok: true,
      plan: {
        mode: "source",
        packageRoot: options.packageRoot,
        currentVersion: options.currentVersion,
        restartBridge: options.bridgeRunning,
        steps: [
          {
            command: "git",
            args: ["pull", "--ff-only"],
            cwd: options.packageRoot,
            description: "Pull latest source"
          },
          {
            command: "npm",
            args: ["install"],
            cwd: options.packageRoot,
            description: "Sync dependencies"
          },
          {
            command: "npm",
            args: ["run", "build:all"],
            cwd: options.packageRoot,
            description: "Rebuild CLI and daemon"
          }
        ]
      }
    };
  }
  return {
    ok: true,
    plan: {
      mode: "npm",
      packageRoot: options.packageRoot,
      currentVersion: options.currentVersion,
      restartBridge: options.bridgeRunning,
      steps: [
        {
          command: "npm",
          args: ["install", "-g", packageSpec],
          description: options.bridgeRunning ? "Install latest npm package globally before restarting bridge" : "Install latest npm package globally"
        }
      ]
    }
  };
}

// src/providers/claude/cli-support.ts
import fs2 from "node:fs";
import { execSync } from "node:child_process";
function resolveWindowsNpmClaudeCliShim(cliPath, pathExists = fs2.existsSync) {
  const normalized = cliPath.replace(/\\/g, "/");
  if (!/\/npm\/claude(\.cmd)?$/i.test(normalized)) {
    return cliPath;
  }
  const cliJs = normalized.replace(/\/claude(\.cmd)?$/i, "/node_modules/@anthropic-ai/claude-code/cli.js").replace(/\//g, "\\");
  return pathExists(cliJs) ? cliJs : cliPath;
}
function isWindowsStylePath(cliPath) {
  return /^[A-Za-z]:[\\/]/.test(cliPath) || /^\\\\/.test(cliPath);
}
function normalizeConfiguredClaudeCliPath(cliPath, platform = process.platform) {
  const trimmed = cliPath?.trim();
  if (!trimmed) return void 0;
  if (platform === "win32") {
    if (trimmed.startsWith("/")) return void 0;
    return resolveWindowsNpmClaudeCliShim(trimmed);
  }
  if (isWindowsStylePath(trimmed)) return void 0;
  return trimmed;
}

// src/feishu-scopes.ts
var FEISHU_SCOPES_IMPORT_JSON = String.raw`{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "bitable:app",
      "bitable:app:readonly",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user.basic_profile:readonly",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:doc",
      "docs:doc:readonly",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.comment:write_only",
      "docs:document.content:read",
      "docs:document.media:download",
      "docs:document.media:upload",
      "docs:document.subscription",
      "docs:document.subscription:read",
      "docs:document:copy",
      "docs:document:export",
      "docs:document:import",
      "docs:event.document_deleted:read",
      "docs:event.document_edited:read",
      "docs:event.document_opened:read",
      "docs:event:subscribe",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "drive:drive",
      "drive:drive:readonly",
      "event:ip_list",
      "im:app_feed_card:write",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:chat:read",
      "im:chat:update",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.urgent:phone",
      "im:message.urgent:sms",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "sheets:spreadsheet",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "base:app:copy",
      "base:app:create",
      "base:app:read",
      "base:app:update",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:delete",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:delete",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "calendar:calendar:read",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user.basic_profile:readonly",
      "contact:user.employee_id:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document.media:upload",
      "docs:document:copy",
      "docs:document:export",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "offline_access",
      "search:docs:read",
      "search:message",
      "sheets:spreadsheet.meta:read",
      "sheets:spreadsheet:create",
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:write_only",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only"
    ]
  }
}`;

// src/cli.ts
var CTI_HOME = process.env.CTI_HOME || path2.join(os.homedir(), ".agents-to-im");
var CONFIG_PATH = path2.join(CTI_HOME, "config.env");
var PID_FILE = path2.join(CTI_HOME, "runtime", "bridge.pid");
var STATUS_FILE = path2.join(CTI_HOME, "runtime", "status.json");
var CLI_DIR = path2.dirname(fileURLToPath(import.meta.url));
var CLI_COMMAND = "agents-to-im";
var NPM_INSTALL_SPEC = "agents-to-im";
var MACOS_LAUNCHD_LABEL = "com.agents-to-im.bridge";
var FEISHU_OPEN_BASE_URL = "https://open.feishu.cn";
var LARK_OPEN_BASE_URL = "https://open.larksuite.com";
var SETUP_GUIDE_URL = "https://github.com/francize/agents-to-im/blob/main/references/setup-guides.md";
function cliCommand(command) {
  return command ? `${CLI_COMMAND} ${command}` : CLI_COMMAND;
}
function parseBooleanFlag(value) {
  if (value === void 0) return void 0;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return void 0;
}
function npmInstallCommand() {
  return `npm install -g ${NPM_INSTALL_SPEC}`;
}
function getPlatformLabel(domain) {
  return domain === "lark" ? "Lark" : "Feishu";
}
function getPlatformConsoleUrl(domain) {
  return `${domain === "lark" ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL}/app`;
}
function buildPlatformAppUrl(domain, appId, suffix) {
  const trimmed = appId.trim();
  if (!trimmed) return getPlatformConsoleUrl(domain);
  const baseUrl = domain === "lark" ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL;
  return `${baseUrl}/app/${encodeURIComponent(trimmed)}${suffix}`;
}
function buildPlatformAuthUrl(domain, appId) {
  return buildPlatformAppUrl(domain, appId, "/auth");
}
function buildPlatformEventUrl(domain, appId, tab) {
  return buildPlatformAppUrl(domain, appId, `/event?tab=${tab}`);
}
function buildPlatformBotUrl(domain, appId) {
  return buildPlatformAppUrl(domain, appId, "/bot");
}
function tryCopyToClipboard(text) {
  const attempts = process.platform === "darwin" ? [{ command: "pbcopy", args: [] }] : process.platform === "win32" ? [
    { command: "clip", args: [] },
    { command: "powershell", args: ["-NoProfile", "-Command", "Set-Clipboard"] }
  ] : [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] }
  ];
  for (const attempt of attempts) {
    const result = spawnSync(resolveExecutable(attempt.command), attempt.args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env
    });
    if (result.status === 0) return true;
  }
  return false;
}
function tryOpenExternalUrl(url) {
  const attempts = process.platform === "darwin" ? [{ command: "open", args: [url] }] : process.platform === "win32" ? [
    { command: "powershell", args: ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`] }
  ] : [{ command: "xdg-open", args: [url] }];
  for (const attempt of attempts) {
    const result = spawnSync(resolveExecutable(attempt.command), attempt.args, {
      stdio: "ignore",
      env: process.env,
      timeout: 5e3
    });
    if (result.status === 0) return true;
  }
  return false;
}
var c = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  magenta: "\x1B[35m",
  cyan: "\x1B[36m",
  white: "\x1B[37m",
  bgBlue: "\x1B[44m"
};
var ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
var BANNER_SIDE_PADDING = 2;
function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}
function isWideCodePoint(codePoint) {
  return codePoint >= 4352 && (codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 42191 && codePoint !== 12351 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65135 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 127744 && codePoint <= 128591 || codePoint >= 129280 && codePoint <= 129535 || codePoint >= 131072 && codePoint <= 262141);
}
function getDisplayWidth(value) {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (!codePoint) continue;
    if (codePoint <= 31 || codePoint >= 127 && codePoint <= 159) continue;
    if (codePoint === 65038 || codePoint === 65039 || new RegExp("\\p{Mark}", "u").test(char)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}
function ok(msg) {
  console.log(`  ${c.green}\u2713${c.reset} ${msg}`);
}
function warn(msg) {
  console.log(`  ${c.yellow}\u26A0${c.reset} ${msg}`);
}
function fail(msg) {
  console.log(`  ${c.red}\u2717${c.reset} ${msg}`);
}
function info(msg) {
  console.log(`  ${c.blue}\u2139${c.reset} ${msg}`);
}
function heading(msg) {
  console.log(`
${c.bold}${c.cyan}${msg}${c.reset}
`);
}
function t(locale, zh, en) {
  return locale === "zh" ? zh : en;
}
function detectDefaultOnboardLocale(env = process.env) {
  const locale = `${env.LC_ALL || env.LC_MESSAGES || env.LANG || ""}`.toLowerCase();
  return locale.includes("zh") ? "zh" : "en";
}
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}
async function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${c.white}${question}${suffix}: ${c.reset}`, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}
async function chooseOption(rl, question, options, config) {
  if (!options.length) {
    throw new Error("chooseOption requires at least one option");
  }
  const defaultIndex = Math.min(Math.max(config?.defaultIndex ?? 0, 0), options.length - 1);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`  ${c.white}${question}${c.reset}`);
    options.forEach((option, index) => {
      console.log(`    ${c.cyan}${index + 1}.${c.reset} ${option.label}`);
    });
    const answer = await ask(rl, config?.fallbackQuestion || "Choose");
    const parsed = parseInt(answer, 10) - 1;
    return options[parsed]?.value ?? options[defaultIndex].value;
  }
  rl.pause();
  const input = process.stdin;
  const output = process.stdout;
  const hint = config?.hint || "Use \u2191/\u2193 to move, Enter to choose";
  let selectedIndex = defaultIndex;
  let renderedLines = 0;
  const previousRawMode = Boolean(input.isRaw);
  readline.emitKeypressEvents(input);
  if (input.setRawMode) input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        readline.moveCursor(output, 0, -renderedLines);
        readline.clearScreenDown(output);
      }
      const lines = [`  ${c.white}${question}${c.reset}`];
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        const cursor = index === selectedIndex ? `${c.cyan}\u203A${c.reset}` : " ";
        const label = index === selectedIndex ? `${c.bold}${option.label}${c.reset}` : option.label;
        lines.push(`  ${cursor} ${label}`);
      }
      lines.push(`  ${c.dim}${hint}${c.reset}`);
      output.write(`${lines.join("\n")}
`);
      renderedLines = lines.length;
    };
    const cleanup = () => {
      input.off("keypress", onKeyPress);
      if (input.setRawMode) input.setRawMode(previousRawMode);
      rl.resume();
    };
    const onKeyPress = (_value, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Interrupted"));
        return;
      }
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(options[selectedIndex].value);
      }
    };
    input.on("keypress", onKeyPress);
    render();
  });
}
async function confirm(rl, question, defaultYes = true, labels) {
  return chooseOption(rl, question, [
    { label: labels?.yes || "Yes", value: true },
    { label: labels?.no || "No", value: false }
  ], {
    defaultIndex: defaultYes ? 0 : 1,
    fallbackQuestion: "Choose",
    hint: labels?.hint
  });
}
async function select(rl, question, options, defaultIndex = 0, hint) {
  return chooseOption(rl, question, options.map((option, index) => ({
    label: option,
    value: index
  })), {
    defaultIndex,
    fallbackQuestion: "Choose",
    hint
  });
}
function detectAgent(cmd, name) {
  try {
    const version = execSync2(`${cmd} --version 2>&1`, { encoding: "utf-8", timeout: 5e3 }).trim();
    const agentPath = execSync2(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
      encoding: "utf-8",
      timeout: 3e3
    }).trim().split("\n")[0];
    return { name, installed: true, version, path: agentPath };
  } catch {
    return { name, installed: false };
  }
}
function detectAgents() {
  return [
    detectAgent("claude", "Claude Code"),
    detectAgent("codex", "Codex")
  ];
}
var BANNER_LINES = [
  { text: "agents-to-im", format: (value) => `${c.bold}${value}${c.reset}` },
  { text: "Feishu/Lark bridge for AI coding agents", format: (value) => `${c.dim}${value}${c.reset}` }
];
function buildBannerLines() {
  const contentWidth = Math.max(...BANNER_LINES.map((line) => getDisplayWidth(line.text)));
  const innerWidth = contentWidth + BANNER_SIDE_PADDING * 2;
  const border = `${c.bold}${c.magenta}`;
  const top = `  ${border}+${"-".repeat(innerWidth)}+${c.reset}`;
  const bottom = `  ${border}+${"-".repeat(innerWidth)}+${c.reset}`;
  const body = BANNER_LINES.map(({ text, format }) => {
    const trailingSpaces = innerWidth - BANNER_SIDE_PADDING - getDisplayWidth(text);
    return `  ${border}|${c.reset}${" ".repeat(BANNER_SIDE_PADDING)}${format(text)}${" ".repeat(trailingSpaces)}${border}|${c.reset}`;
  });
  return ["", top, ...body, bottom, ""];
}
function showSetupStep(title, lines) {
  heading(title);
  for (const line of lines) {
    console.log(`  ${c.cyan}-${c.reset} ${line}`);
  }
  console.log("");
}
async function waitForStepCompletion(rl, prompt, options) {
  const allowLater = options?.allowLater !== false;
  const hint = options?.hint || (allowLater ? "Press Enter when done, or type later to finish onboarding for now" : "Press Enter when done");
  return new Promise((resolve) => {
    rl.question(
      `  ${c.white}${prompt}${c.reset}
  ${c.dim}${hint}${c.reset}
  ${c.cyan}> ${c.reset}`,
      (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (allowLater && normalized === "later") {
          resolve("later");
          return;
        }
        resolve("continue");
      }
    );
  });
}
function showOnboardClosing(locale = "en") {
  info(`${t(locale, "\u91CD\u65B0\u8FDB\u5165\u5F15\u5BFC:", "Onboard again:")}     ${c.cyan}${cliCommand("onboard")}${c.reset}`);
  info(`${t(locale, "\u542F\u52A8 bridge:", "Start the bridge:")}  ${c.cyan}${cliCommand("start")}${c.reset}`);
  info(`${t(locale, "\u5FEB\u901F\u91CD\u542F:", "Quick restart:")}     ${c.cyan}${cliCommand("restart")}${c.reset}`);
  info(`${t(locale, "\u67E5\u770B\u72B6\u6001:", "Check status:")}      ${c.cyan}${cliCommand("status")}${c.reset}`);
  info(`${t(locale, "\u8FD0\u884C\u8BCA\u65AD:", "Run diagnostics:")}    ${c.cyan}${cliCommand("doctor")}${c.reset}`);
  console.log("");
}
async function maybePauseOnboarding(rl, prompt, options) {
  const result = await waitForStepCompletion(rl, prompt, {
    allowLater: true,
    hint: options?.hint
  });
  if (result === "continue") return true;
  warn(options?.finishLaterMessage || `Finish the remaining steps later with ${c.cyan}${cliCommand("onboard")}${c.reset}`);
  console.log("");
  showOnboardClosing();
  return false;
}
function buildPlatformSetupChecklist(domain, nextCommand, appId = "") {
  const nextAction = nextCommand === "restart" ? "Restart" : "Start";
  return [
    `Open ${getPlatformLabel(domain)} auth page: ${buildPlatformAuthUrl(domain, appId)}`,
    "Enable the Bot capability if you have not already",
    `Import the full scopes JSON from: ${SETUP_GUIDE_URL}`,
    "Publish one app version after scopes and Bot changes",
    `${nextAction} the bridge before saving Long Connection events`,
    `Open Events page: ${buildPlatformEventUrl(domain, appId, "event")}`,
    "Switch Events & Callbacks to Long Connection",
    "Add event: im.message.receive_v1",
    "Add event: im.message.message_read_v1",
    "Add event: im.chat.updated_v1",
    "Add event: im.chat.member.bot.added_v1",
    `Open Callback page: ${buildPlatformEventUrl(domain, appId, "callback")}`,
    "Add callback: card.action.trigger",
    "Publish again so events and callbacks go live",
    `Optional: open Bot menu page: ${buildPlatformBotUrl(domain, appId)}`,
    "Add floating menu shortcuts: /new:claude and /new:codex",
    "Publish again if you changed the Bot menu"
  ];
}
function showBanner() {
  for (const line of buildBannerLines()) {
    console.log(line);
  }
}
function parseLaunchdPid(output) {
  const match = output.match(/^\s*pid = ([^\s]+)\s*$/m);
  if (!match) return "";
  const pid = match[1].trim();
  if (!pid || pid === "0" || pid === "-") return "";
  return pid;
}
function getLaunchdPid() {
  if (process.platform !== "darwin") return "";
  try {
    const uid = execSync2("id -u", { encoding: "utf-8", timeout: 3e3 }).trim();
    const output = execSync2(`launchctl print gui/${uid}/${MACOS_LAUNCHD_LABEL}`, {
      encoding: "utf-8",
      timeout: 3e3
    });
    return parseLaunchdPid(output);
  } catch {
    return "";
  }
}
function getBridgeStatusSnapshot() {
  let pid = "";
  try {
    pid = fs3.readFileSync(PID_FILE, "utf-8").trim();
  } catch {
  }
  let statusJson = {};
  try {
    statusJson = JSON.parse(fs3.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
  }
  const launchdPid = getLaunchdPid();
  if (launchdPid) {
    return { running: true, pid: launchdPid, statusJson };
  }
  if (statusJson.running !== true || !pid) {
    return { running: false, pid, statusJson };
  }
  try {
    process.kill(parseInt(pid, 10), 0);
    return { running: true, pid, statusJson };
  } catch {
    return { running: false, pid, statusJson };
  }
}
function resolveExecutable(command) {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd";
  }
  return command;
}
function ensureCommandAvailable(command) {
  const result = spawnSync(resolveExecutable(command), ["--version"], {
    stdio: "ignore",
    env: process.env
  });
  if (result.status === 0) return;
  const detail = result.error instanceof Error ? `: ${result.error.message}` : "";
  throw new Error(`Required command not found or not working: ${command}${detail}`);
}
function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, {
      stdio: "inherit",
      cwd: options?.cwd,
      env: options?.env || process.env
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if ((code || 0) === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
async function setupWizard() {
  showBanner();
  const rl = createRl();
  const locale = await chooseOption(rl, "Language / \u8BED\u8A00", [
    { label: "\u4E2D\u6587", value: "zh" },
    { label: "English", value: "en" }
  ], {
    defaultIndex: detectDefaultOnboardLocale() === "zh" ? 0 : 1,
    fallbackQuestion: "Choose",
    hint: "Use \u2191/\u2193 to move, Enter to choose"
  });
  const menuHint = t(locale, "\u4F7F\u7528 \u2191/\u2193 \u9009\u62E9\uFF0C\u6309 Enter \u786E\u8BA4", "Use \u2191/\u2193 to move, Enter to choose");
  const continueHint = t(
    locale,
    "\u5B8C\u6210\u540E\u6309\u56DE\u8F66\uFF1B\u5982\u679C\u60F3\u5148\u7ED3\u675F\u8FD9\u6B21\u5F15\u5BFC\uFF0C\u8F93\u5165 later",
    "Press Enter when done, or type later to finish onboarding for now"
  );
  const finishLaterMessage = t(
    locale,
    `\u5269\u4F59\u6B65\u9AA4\u53EF\u4EE5\u7A0D\u540E\u901A\u8FC7 ${c.cyan}${cliCommand("onboard")}${c.reset} \u7EE7\u7EED`,
    `Finish the remaining steps later with ${c.cyan}${cliCommand("onboard")}${c.reset}`
  );
  const platformConsoleUrlHint = `${c.cyan}https://open.feishu.cn/app${c.reset} / ${c.cyan}https://open.larksuite.com/app${c.reset}`;
  try {
    heading(t(locale, "\u{1F50D} \u68C0\u6D4B\u5DF2\u5B89\u88C5 agent...", "\u{1F50D} Detecting installed agents..."));
    const agents = detectAgents();
    for (const agent of agents) {
      if (agent.installed) {
        ok(`${agent.name} ${c.dim}${agent.version}${c.reset}`);
      } else {
        warn(`${agent.name} ${c.dim}${t(locale, "\u672A\u627E\u5230", "not found")}${c.reset}`);
      }
    }
    const hasAnyAgent = agents.some((agent) => agent.installed);
    if (!hasAnyAgent) {
      console.log("");
      fail(t(locale, "\u6CA1\u6709\u68C0\u6D4B\u5230\u53EF\u7528\u7684 AI agent\u3002", "No AI agents detected."));
      info(t(locale, "\u81F3\u5C11\u5148\u5B89\u88C5\u4E00\u4E2A\uFF1A", "Install at least one:"));
      info(`  Claude Code: ${c.cyan}npm install -g @anthropic-ai/claude-code${c.reset}`);
      info(`  Codex:       ${c.cyan}npm install -g @openai/codex${c.reset}`);
      console.log("");
      const shouldContinue = await confirm(
        rl,
        t(locale, "\u4ECD\u7136\u7EE7\u7EED\u914D\u7F6E\uFF1F", "Continue setup anyway?"),
        false,
        {
          yes: t(locale, "\u7EE7\u7EED", "Continue"),
          no: t(locale, "\u9000\u51FA", "Exit"),
          hint: menuHint
        }
      );
      if (!shouldContinue) return;
    }
    heading(t(locale, "\u{1F527} \u98DE\u4E66 / Lark \u914D\u7F6E", "\u{1F527} Feishu / Lark Configuration"));
    let existing = {};
    try {
      const content = fs3.readFileSync(CONFIG_PATH, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        existing[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    } catch {
    }
    info(t(
      locale,
      "\u9700\u8981\u51C6\u5907\u4E00\u4E2A\u542F\u7528\u4E86 Bot \u80FD\u529B\u7684\u98DE\u4E66 / Lark \u81EA\u5EFA\u5E94\u7528\u3002",
      "You need a Feishu/Lark custom app with bot capability."
    ));
    info(`${t(locale, "\u521B\u5EFA\u5165\u53E3\uFF1A", "Create one at:")} ${platformConsoleUrlHint}`);
    console.log("");
    const existingAppId = existing.CTI_FEISHU_APP_ID || "";
    const existingAppSecret = existing.CTI_FEISHU_APP_SECRET || "";
    const existingDomain = existing.CTI_FEISHU_DOMAIN || "";
    const existingAllowedUsers = existing.CTI_FEISHU_ALLOWED_USERS || "";
    const existingShowToolCallCards = parseBooleanFlag(existing.CTI_FEISHU_SHOW_TOOL_CALL_CARDS) ?? false;
    const appId = await ask(rl, t(locale, "App ID", "App ID"), existingAppId);
    const appSecret = await ask(
      rl,
      t(locale, "App Secret", "App Secret"),
      existingAppSecret ? `****${existingAppSecret.slice(-4)}` : void 0
    );
    const actualSecret = appSecret.startsWith("****") ? existingAppSecret : appSecret;
    const domainIdx = await select(
      rl,
      t(locale, "\u9009\u62E9\u5E73\u53F0\uFF1A", "Platform:"),
      [
        t(locale, "\u98DE\u4E66\uFF08\u4E2D\u56FD\u5927\u9646\uFF09", "Feishu (China)"),
        "Lark (international)"
      ],
      existingDomain === "lark" ? 1 : 0,
      menuHint
    );
    const domain = domainIdx === 1 ? "lark" : "";
    const platformName = domain === "lark" ? "Lark" : t(locale, "\u98DE\u4E66", "Feishu");
    heading(t(locale, "\u{1F4C1} \u5DE5\u4F5C\u76EE\u5F55", "\u{1F4C1} Working Directory"));
    const defaultWorkDir = existing.CTI_DEFAULT_WORKDIR || process.cwd();
    const workDir = await ask(rl, t(locale, "\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55", "Default working directory"), defaultWorkDir);
    const detectedClaudeCliPath = agents.find((agent) => agent.name === "Claude Code")?.path || "";
    const existingClaudeCliPath = normalizeConfiguredClaudeCliPath(existing.CTI_CLAUDE_CODE_EXECUTABLE || "");
    const claudeCliPath = await ask(
      rl,
      t(locale, "Claude CLI \u8DEF\u5F84\uFF08\u53EF\u9009\uFF09", "Claude CLI path (optional)"),
      existingClaudeCliPath || detectedClaudeCliPath || void 0
    );
    console.log("");
    info(t(
      locale,
      "Allowlist \u662F bot \u552F\u4E00\u7684\u8BBF\u95EE\u63A7\u5236\u3002\u7A7A allowlist \u4F1A\u62D2\u7EDD\u6240\u6709\u53D1\u9001\u8005\uFF1B",
      "Allowlist is the only access control for this bot. An empty allowlist rejects everyone;"
    ));
    info(t(
      locale,
      `\u5982\u4E0D\u9650\u5236\u5219\u4EFB\u4F55\u80FD\u5411 bot \u53D1\u6D88\u606F\u7684${platformName}\u7528\u6237\u90FD\u80FD\u5728\u4F60\u7684\u7535\u8111\u4E0A\u9A71\u52A8 Claude/Codex\u3002`,
      `if unrestricted, anyone who can DM your bot can drive Claude/Codex on this machine.`
    ));
    const restrictUsers = await confirm(
      rl,
      t(locale, `\u9650\u5236\u7279\u5B9A${platformName}\u7528\u6237\u4F7F\u7528\uFF1F\uFF08\u5F3A\u70C8\u5EFA\u8BAE\uFF09`, `Restrict to specific ${platformName} users? (strongly recommended)`),
      true,
      {
        yes: t(locale, "\u662F\uFF08\u8F93\u5165 user ID\uFF09", "Yes (enter user IDs)"),
        no: t(locale, "\u5426\uFF08\u653E\u884C\u6240\u6709\uFF0C\u7B49\u540C\u8BBE\u4E3A *\uFF09", "No (allow-all, equivalent to *)"),
        hint: menuHint
      }
    );
    let allowedUsers = "";
    if (restrictUsers) {
      const previousIds = existingAllowedUsers && existingAllowedUsers.trim() !== "*" ? existingAllowedUsers : "";
      allowedUsers = await ask(
        rl,
        t(locale, "\u5141\u8BB8\u7684\u7528\u6237 ID\uFF08\u9017\u53F7\u5206\u9694\uFF09", "Allowed user IDs (comma-separated)"),
        previousIds
      );
      if (!allowedUsers.trim()) {
        warn(t(
          locale,
          "\u672A\u8F93\u5165\u4EFB\u4F55 ID\u3002\u6539\u4E3A\u653E\u884C\u6240\u6709\uFF08CTI_FEISHU_ALLOWED_USERS=*\uFF09\uFF1B\u542F\u52A8\u540E\u8BF7\u5C3D\u5FEB\u7F16\u8F91\u914D\u7F6E\u6539\u6210\u4F60\u7684 open_id\u3002",
          "No IDs entered. Falling back to allow-all (CTI_FEISHU_ALLOWED_USERS=*); edit the config to your own open_id ASAP."
        ));
        allowedUsers = "*";
      }
    } else {
      allowedUsers = "*";
    }
    if (allowedUsers.trim() === "*") {
      warn(t(
        locale,
        '\u26A0\uFE0F  Allowlist \u8BBE\u4E3A "*"\uFF08allow-all\uFF09\uFF1A\u4EFB\u4F55\u80FD\u5411 bot \u53D1\u6D88\u606F\u6216\u4E0E bot \u540C\u7FA4\u7684\u4EBA\u90FD\u80FD\uFF1A',
        '\u26A0\uFE0F  Allowlist is "*" (allow-all). Anyone who can DM your bot or share a group with it can:'
      ));
      warn(t(
        locale,
        "    \u2022 \u521B\u5EFA Claude/Codex \u4F1A\u8BDD\uFF0C\u5728\u4F60\u7684\u7535\u8111\u4E0A\u4EE5\u4F60\u7684\u8EAB\u4EFD\u6267\u884C\u547D\u4EE4",
        "    \u2022 Create Claude/Codex sessions and run commands as you on this machine"
      ));
      warn(t(
        locale,
        "    \u2022 \u70B9\u51FB\u6743\u9650\u5361\u7247\uFF0C\u6279\u51C6 Claude \u5199\u6587\u4EF6 / \u6267\u884C shell",
        "    \u2022 Click permission cards to approve Claude file writes / shell exec"
      ));
      warn(t(
        locale,
        `\u751F\u4EA7\u73AF\u5883\u5F3A\u70C8\u5EFA\u8BAE\u6539\u6210\u4F60\u81EA\u5DF1\u7684 open_id\uFF08\u7F16\u8F91 ~/.agents-to-im/config.env\uFF0C\u628A CTI_FEISHU_ALLOWED_USERS=* \u6539\u4E3A ou_xxx,ou_yyy\uFF09\u3002`,
        `For production, set CTI_FEISHU_ALLOWED_USERS to your own open_id (edit ~/.agents-to-im/config.env: replace * with ou_xxx,ou_yyy).`
      ));
    }
    console.log("");
    info(t(
      locale,
      "tool \u8C03\u7528\u5361\u7247\u4F1A\u628A\u547D\u4EE4\u3001\u6587\u4EF6\u548C\u5DE5\u5177\u8FC7\u7A0B\u5355\u72EC\u53D1\u6210\u5361\u7247\uFF0C\u566A\u58F0\u901A\u5E38\u6BD4\u8F83\u5927\uFF1B\u666E\u901A\u6D88\u606F\u5361\u7247\u4E0D\u53D7\u5F71\u54CD\u3002",
      "Tool-call cards send command, file, and tool progress as separate cards. They are usually noisy; normal message cards are unaffected."
    ));
    const showToolCallCards = await confirm(
      rl,
      t(locale, "\u5728\u4F1A\u8BDD\u91CC\u5C55\u793A tool \u8C03\u7528\u5361\u7247\uFF1F", "Show tool-call cards in sessions?"),
      existingShowToolCallCards,
      {
        yes: t(locale, "\u5C55\u793A", "Show them"),
        no: t(locale, "\u4FDD\u6301\u5173\u95ED", "Keep them off"),
        hint: menuHint
      }
    );
    heading(t(locale, "\u{1F4DD} \u5199\u5165\u914D\u7F6E...", "\u{1F4DD} Writing configuration..."));
    const lines = [
      "# agents-to-im configuration",
      `# Generated at ${(/* @__PURE__ */ new Date()).toISOString()}`,
      "",
      "# Working directory",
      `CTI_DEFAULT_WORKDIR=${workDir}`,
      "",
      "# Feishu / Lark bot",
      `CTI_FEISHU_APP_ID=${appId}`,
      `CTI_FEISHU_APP_SECRET=${actualSecret || ""}`,
      `CTI_FEISHU_SHOW_TOOL_CALL_CARDS=${showToolCallCards ? "true" : "false"}`
    ];
    if (domain) lines.push(`CTI_FEISHU_DOMAIN=${domain}`);
    if (allowedUsers) lines.push(`CTI_FEISHU_ALLOWED_USERS=${allowedUsers}`);
    if (claudeCliPath) {
      lines.push("", "# Claude runtime", `CTI_CLAUDE_CODE_EXECUTABLE=${claudeCliPath}`);
    }
    lines.push("");
    fs3.mkdirSync(CTI_HOME, { recursive: true });
    fs3.mkdirSync(path2.join(CTI_HOME, "data"), { recursive: true });
    fs3.mkdirSync(path2.join(CTI_HOME, "logs"), { recursive: true });
    fs3.mkdirSync(path2.join(CTI_HOME, "runtime"), { recursive: true });
    const tmpPath = `${CONFIG_PATH}.tmp`;
    fs3.writeFileSync(tmpPath, lines.join("\n"), { mode: 384 });
    fs3.renameSync(tmpPath, CONFIG_PATH);
    ok(t(locale, `\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5230 ${c.cyan}${CONFIG_PATH}${c.reset}`, `Config saved to ${c.cyan}${CONFIG_PATH}${c.reset}`));
    heading(t(locale, "\u2705 \u914D\u7F6E\u5B8C\u6210", "\u2705 Setup Complete"));
    console.log(`  ${c.dim}${t(locale, "App ID:", "App ID:")}${c.reset}     ${appId || t(locale, "(\u672A\u8BBE\u7F6E)", "(not set)")}`);
    console.log(`  ${c.dim}${t(locale, "\u5E73\u53F0:", "Platform:")}${c.reset}     ${domain || "feishu"}`);
    console.log(`  ${c.dim}${t(locale, "\u5DE5\u4F5C\u76EE\u5F55:", "Work dir:")}${c.reset}   ${workDir}`);
    console.log(`  ${c.dim}${t(locale, "\u914D\u7F6E\u6587\u4EF6:", "Config:")}${c.reset}   ${CONFIG_PATH}`);
    console.log("");
    const bridge = getBridgeStatusSnapshot();
    const nextCommand = bridge.running ? "restart" : "start";
    const nextActionLabel = bridge.running ? t(locale, "\u7ACB\u5373\u91CD\u542F bridge", "Restart bridge now") : t(locale, "\u7ACB\u5373\u542F\u52A8 bridge", "Start bridge now");
    if (appId) {
      const authUrl = buildPlatformAuthUrl(domain, appId);
      showSetupStep(`1/6 ${platformName} ${t(locale, "Bot\u3001\u6743\u9650\u4E0E\u9996\u6B21\u53D1\u5E03", "Bot + Scopes + First Publish")}`, [
        t(locale, "\u5728\u6743\u9650\u9875\u542F\u7528 Bot \u80FD\u529B", "Enable the Bot capability on the app auth page"),
        t(locale, "\u4F7F\u7528\u201C\u5BFC\u5165\u6743\u9650\u201D\u4E00\u6B21\u6027\u5BFC\u5165 scopes JSON", "Use Import Permissions to paste the scopes JSON in one shot"),
        t(locale, "\u5B8C\u6210 Bot \u548C\u6743\u9650\u540E\uFF0C\u5148\u53D1\u5E03\u4E00\u6B21\u7248\u672C", "Publish one app version after the Bot and scopes changes"),
        `${t(locale, "\u6743\u9650\u9875\uFF1A", "Auth page:")} ${c.cyan}${authUrl}${c.reset}`
      ]);
      const copyAction = await chooseOption(rl, t(locale, "\u5148\u5904\u7406 scopes JSON\uFF1F", "Scopes JSON helper"), [
        { label: t(locale, "\u590D\u5236 scopes JSON \u5230\u526A\u8D34\u677F", "Copy scopes JSON to clipboard"), value: "copy" },
        { label: t(locale, "\u6682\u65F6\u8DF3\u8FC7\uFF08Skip Now\uFF09", "Skip Now"), value: "skip" }
      ], {
        defaultIndex: 0,
        fallbackQuestion: "Choose",
        hint: menuHint
      });
      let skipPlatformStepOne = copyAction === "skip";
      if (copyAction === "copy") {
        if (tryCopyToClipboard(FEISHU_SCOPES_IMPORT_JSON)) {
          ok(t(locale, "Scopes JSON \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F", "Scopes JSON copied to clipboard"));
        } else {
          warn(t(
            locale,
            `\u65E0\u6CD5\u8BBF\u95EE\u526A\u8D34\u677F\uFF0C\u8BF7\u7A0D\u540E\u4ECE ${SETUP_GUIDE_URL} \u624B\u52A8\u590D\u5236`,
            `Could not access the clipboard. Copy it manually from ${SETUP_GUIDE_URL}`
          ));
        }
      } else {
        info(t(
          locale,
          `\u8FD9\u4E00\u6B65\u5148\u8DF3\u8FC7\uFF0C\u7A0D\u540E\u53EF\u4ECE ${SETUP_GUIDE_URL} \u624B\u52A8\u590D\u5236`,
          `Skipping this step for now. You can copy the scopes JSON later from ${SETUP_GUIDE_URL}`
        ));
      }
      if (!skipPlatformStepOne) {
        const openAuthAction = await chooseOption(rl, t(locale, "\u73B0\u5728\u6253\u5F00\u6743\u9650\u9875\uFF1F", "Open the auth page now?"), [
          { label: t(locale, "\u6253\u5F00\u6743\u9650\u9875", "Open auth page"), value: "open" },
          { label: t(locale, "\u6682\u65F6\u8DF3\u8FC7\uFF08Skip Now\uFF09", "Skip Now"), value: "skip" }
        ], {
          defaultIndex: 0,
          fallbackQuestion: "Choose",
          hint: menuHint
        });
        if (openAuthAction === "open") {
          if (tryOpenExternalUrl(authUrl)) {
            ok(t(locale, `\u5DF2\u6253\u5F00\u6743\u9650\u9875\uFF1A${c.cyan}${authUrl}${c.reset}`, `Opened auth page: ${c.cyan}${authUrl}${c.reset}`));
          } else {
            warn(t(locale, `\u65E0\u6CD5\u81EA\u52A8\u6253\u5F00\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE\uFF1A${c.cyan}${authUrl}${c.reset}`, `Could not open the auth page automatically. Open this URL manually: ${c.cyan}${authUrl}${c.reset}`));
          }
          console.log("");
          if (!await maybePauseOnboarding(
            rl,
            t(locale, "\u5B8C\u6210 Bot\u3001\u6743\u9650\u5BFC\u5165\u548C\u9996\u6B21\u53D1\u5E03\u540E\u6309\u56DE\u8F66\u7EE7\u7EED", "Press Enter after Bot, scopes, and the first publish are done"),
            {
              hint: continueHint,
              finishLaterMessage
            }
          )) {
            return;
          }
        } else {
          skipPlatformStepOne = true;
          info(t(locale, "\u8FD9\u4E00\u6B65\u5148\u8DF3\u8FC7\uFF0C\u9700\u8981\u65F6\u6309\u4E0A\u9762\u7684\u94FE\u63A5\u624B\u52A8\u8FDB\u5165\u5373\u53EF", "Skipping this step for now. Open the URL above later when you are ready."));
        }
      }
    }
    showSetupStep(`2/6 ${t(locale, "\u542F\u52A8\u672C\u5730 bridge", "Run the local bridge")}`, [
      t(
        locale,
        `${bridge.running ? "\u91CD\u542F" : "\u542F\u52A8"}\u672C\u5730 bridge\uFF0C\u7136\u540E\u518D\u53BB\u4FDD\u5B58 Long Connection \u4E8B\u4EF6\u914D\u7F6E`,
        `${bridge.running ? "Restart" : "Start"} the local bridge before you save Long Connection events`
      ),
      t(
        locale,
        `${platformName} \u4F1A\u5728\u4FDD\u5B58\u4E8B\u4EF6\u914D\u7F6E\u65F6\u6821\u9A8C\u5E94\u7528\u8FDE\u63A5\u72B6\u6001`,
        `${platformName} validates the app connection while saving event settings`
      )
    ]);
    const bridgeAction = await chooseOption(rl, t(locale, "\u8FD9\u4E00\u9879\u600E\u4E48\u5904\u7406\uFF1F", "How do you want to handle this step?"), [
      { label: nextActionLabel, value: "run" },
      { label: t(locale, "\u6211\u81EA\u5DF1\u624B\u52A8\u6267\u884C", "I'll run it myself"), value: "manual" },
      { label: t(locale, "\u7A0D\u540E\u7EE7\u7EED\u6574\u4E2A\u5F15\u5BFC", "Finish onboarding later"), value: "later" }
    ], {
      defaultIndex: 0,
      fallbackQuestion: "Choose",
      hint: menuHint
    });
    if (bridgeAction === "run") {
      info(`${nextActionLabel}...`);
      await runDaemonCommand(nextCommand);
      ok(t(locale, `Bridge \u5DF2${bridge.running ? "\u91CD\u542F" : "\u542F\u52A8"}`, `Bridge ${bridge.running ? "restarted" : "started"}`));
      console.log("");
    } else if (bridgeAction === "manual") {
      info(`${t(locale, "\u8BF7\u5728\u53E6\u4E00\u4E2A\u7EC8\u7AEF\u6267\u884C\uFF1A", "Run this in another terminal:")} ${c.cyan}${cliCommand(nextCommand)}${c.reset}`);
      console.log("");
      if (!await maybePauseOnboarding(
        rl,
        t(locale, "\u624B\u52A8\u6267\u884C\u5B8C\u6210\u540E\u6309\u56DE\u8F66\u7EE7\u7EED", `Press Enter after ${cliCommand(nextCommand)} has completed`),
        {
          hint: continueHint,
          finishLaterMessage
        }
      )) {
        return;
      }
    } else {
      warn(finishLaterMessage);
      console.log("");
      showOnboardClosing(locale);
      return;
    }
    if (appId) {
      const eventUrl = buildPlatformEventUrl(domain, appId, "event");
      showSetupStep(`3/6 ${platformName} ${t(locale, "\u957F\u8FDE\u63A5\u4E8B\u4EF6", "Long Connection Events")}`, [
        t(locale, "\u628A Events & Callbacks \u5207\u5230 Long Connection", "Switch Events & Callbacks to Long Connection"),
        t(locale, "\u628A\u4E0B\u9762 4 \u4E2A\u4E8B\u4EF6\u4E00\u8D77\u52A0\u4E0A\uFF1A", "Add these 4 events together:"),
        "im.message.receive_v1",
        "im.message.message_read_v1",
        "im.chat.updated_v1",
        "im.chat.member.bot.added_v1",
        `${t(locale, "\u4E8B\u4EF6\u9875\uFF1A", "Events page:")} ${c.cyan}${eventUrl}${c.reset}`
      ]);
      const openEventsAction = await chooseOption(rl, t(locale, "\u73B0\u5728\u6253\u5F00\u4E8B\u4EF6\u9875\uFF1F", "Open the Events page now?"), [
        { label: t(locale, "\u6253\u5F00\u4E8B\u4EF6\u9875", "Open Events page"), value: "open" },
        { label: t(locale, "\u6682\u65F6\u8DF3\u8FC7\uFF08Skip Now\uFF09", "Skip Now"), value: "skip" }
      ], {
        defaultIndex: 0,
        fallbackQuestion: "Choose",
        hint: menuHint
      });
      if (openEventsAction === "open") {
        if (tryOpenExternalUrl(eventUrl)) {
          ok(t(locale, `\u5DF2\u6253\u5F00\u4E8B\u4EF6\u9875\uFF1A${c.cyan}${eventUrl}${c.reset}`, `Opened Events page: ${c.cyan}${eventUrl}${c.reset}`));
        } else {
          warn(t(locale, `\u65E0\u6CD5\u81EA\u52A8\u6253\u5F00\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE\uFF1A${c.cyan}${eventUrl}${c.reset}`, `Could not open the Events page automatically. Open this URL manually: ${c.cyan}${eventUrl}${c.reset}`));
        }
        console.log("");
        if (!await maybePauseOnboarding(
          rl,
          t(locale, "\u5B8C\u6210 Long Connection \u548C 3 \u4E2A\u4E8B\u4EF6\u914D\u7F6E\u540E\u6309\u56DE\u8F66\u7EE7\u7EED", "Press Enter after Long Connection and the 3 events are saved"),
          {
            hint: continueHint,
            finishLaterMessage
          }
        )) {
          return;
        }
      } else {
        info(t(locale, "\u8FD9\u4E00\u6B65\u5148\u8DF3\u8FC7\uFF0C\u9700\u8981\u65F6\u518D\u624B\u52A8\u8FDB\u5165\u4E8B\u4EF6\u9875\u914D\u7F6E", "Skipping this step for now. Open the Events page later when you are ready."));
      }
      const callbackUrl = buildPlatformEventUrl(domain, appId, "callback");
      showSetupStep(`4/6 ${platformName} ${t(locale, "\u5361\u7247\u56DE\u8C03", "Callback")}`, [
        t(locale, "\u5728 Callback \u9875\u7B7E\u6DFB\u52A0\u4E0B\u9762\u8FD9\u4E2A\u56DE\u8C03\uFF1A", "Add the callback below on the Callback tab"),
        "card.action.trigger",
        `${t(locale, "\u56DE\u8C03\u9875\uFF1A", "Callback page:")} ${c.cyan}${callbackUrl}${c.reset}`
      ]);
      const openCallbackAction = await chooseOption(rl, t(locale, "\u73B0\u5728\u6253\u5F00\u56DE\u8C03\u9875\uFF1F", "Open the Callback page now?"), [
        { label: t(locale, "\u6253\u5F00\u56DE\u8C03\u9875", "Open Callback page"), value: "open" },
        { label: t(locale, "\u6682\u65F6\u8DF3\u8FC7\uFF08Skip Now\uFF09", "Skip Now"), value: "skip" }
      ], {
        defaultIndex: 0,
        fallbackQuestion: "Choose",
        hint: menuHint
      });
      if (openCallbackAction === "open") {
        if (tryOpenExternalUrl(callbackUrl)) {
          ok(t(locale, `\u5DF2\u6253\u5F00\u56DE\u8C03\u9875\uFF1A${c.cyan}${callbackUrl}${c.reset}`, `Opened Callback page: ${c.cyan}${callbackUrl}${c.reset}`));
        } else {
          warn(t(locale, `\u65E0\u6CD5\u81EA\u52A8\u6253\u5F00\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE\uFF1A${c.cyan}${callbackUrl}${c.reset}`, `Could not open the Callback page automatically. Open this URL manually: ${c.cyan}${callbackUrl}${c.reset}`));
        }
        console.log("");
        if (!await maybePauseOnboarding(
          rl,
          t(locale, "\u5B8C\u6210\u56DE\u8C03\u914D\u7F6E\u5E76\u4FDD\u5B58\u540E\u6309\u56DE\u8F66\u7EE7\u7EED", "Press Enter after the callback has been added and saved"),
          {
            hint: continueHint,
            finishLaterMessage
          }
        )) {
          return;
        }
      } else {
        info(t(locale, "\u8FD9\u4E00\u6B65\u5148\u8DF3\u8FC7\uFF0C\u9700\u8981\u65F6\u518D\u624B\u52A8\u8FDB\u5165\u56DE\u8C03\u9875\u914D\u7F6E", "Skipping this step for now. Open the Callback page later when you are ready."));
      }
      const botUrl = buildPlatformBotUrl(domain, appId);
      showSetupStep(`5/6 ${t(locale, "\u53EF\u9009\uFF1ABot \u60AC\u6D6E\u83DC\u5355", "Optional: Bot Menu")}`, [
        t(locale, "\u5EFA\u8BAE\u914D\u7F6E\u4E24\u4E2A\u60AC\u6D6E\u83DC\u5355\u5FEB\u6377\u5165\u53E3\uFF1A", "Recommended: add floating menu shortcuts for fast DM entry points"),
        "/new:claude",
        "/new:codex",
        `${t(locale, "Bot \u83DC\u5355\u9875\uFF1A", "Bot menu page:")} ${c.cyan}${botUrl}${c.reset}`
      ]);
      const botMenuAction = await chooseOption(rl, t(locale, "\u8FD9\u4E00\u9879\u600E\u4E48\u5904\u7406\uFF1F", "How do you want to handle this step?"), [
        { label: t(locale, "\u6253\u5F00 Bot \u83DC\u5355\u9875", "Open Bot menu page"), value: "open" },
        { label: t(locale, "\u6682\u65F6\u8DF3\u8FC7\uFF08Skip Now\uFF09", "Skip Now"), value: "skip" }
      ], {
        defaultIndex: 0,
        fallbackQuestion: "Choose",
        hint: menuHint
      });
      if (botMenuAction === "open") {
        if (tryOpenExternalUrl(botUrl)) {
          ok(t(locale, `\u5DF2\u6253\u5F00 Bot \u83DC\u5355\u9875\uFF1A${c.cyan}${botUrl}${c.reset}`, `Opened Bot menu page: ${c.cyan}${botUrl}${c.reset}`));
        } else {
          warn(t(locale, `\u65E0\u6CD5\u81EA\u52A8\u6253\u5F00\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE\uFF1A${c.cyan}${botUrl}${c.reset}`, `Could not open the Bot menu page automatically. Open this URL manually: ${c.cyan}${botUrl}${c.reset}`));
        }
        console.log("");
        if (!await maybePauseOnboarding(
          rl,
          t(locale, "\u914D\u7F6E\u5B8C\u60AC\u6D6E\u83DC\u5355\u540E\u6309\u56DE\u8F66\u7EE7\u7EED", "Press Enter after the floating menu has been configured"),
          {
            hint: continueHint,
            finishLaterMessage
          }
        )) {
          return;
        }
      } else {
        info(t(locale, "\u8FD9\u4E00\u6B65\u5148\u8DF3\u8FC7\uFF0C\u9700\u8981\u65F6\u53EF\u4EE5\u7A0D\u540E\u518D\u914D", "Skipping Bot menu for now. You can configure it later if needed."));
        console.log("");
      }
      showSetupStep(`6/6 ${t(locale, "\u6700\u7EC8\u53D1\u5E03", "Final Publish")}`, [
        t(locale, "\u8FDB\u5165 Version Management & Release", "Go to Version Management & Release"),
        t(locale, "\u628A\u4E8B\u4EF6\u3001\u56DE\u8C03\u548C\u53EF\u9009\u7684 Bot \u83DC\u5355\u6539\u52A8\u518D\u53D1\u5E03\u4E00\u6B21", "Publish the remaining changes for events, callback, and optional Bot menu")
      ]);
      if (!await maybePauseOnboarding(
        rl,
        t(locale, "\u5B8C\u6210\u6700\u7EC8\u53D1\u5E03\u540E\u6309\u56DE\u8F66\u7ED3\u675F\u5F15\u5BFC", "Press Enter after the final publish has been submitted or approved"),
        {
          hint: continueHint,
          finishLaterMessage
        }
      )) {
        return;
      }
    }
    heading(t(locale, "\u2705 \u5E73\u53F0\u5F15\u5BFC\u5B8C\u6210", "\u2705 Platform Setup Guided"));
    info(t(
      locale,
      "\u98DE\u4E66 / Lark \u5E73\u53F0\u4FA7\u5DF2\u7ECF\u8D70\u5B8C\u3002\u73B0\u5728\u53EF\u4EE5\u79C1\u804A Bot \u53D1\u9001 /new:claude \u6216 /new:codex\u3002",
      "The Feishu/Lark platform steps are complete. You can now DM the bot with /new:claude or /new:codex."
    ));
    console.log("");
    showOnboardClosing(locale);
  } finally {
    rl.close();
  }
}
function showStatus() {
  showBanner();
  heading("\u{1F4CA} Bridge Status");
  let pid = "";
  try {
    pid = fs3.readFileSync(PID_FILE, "utf-8").trim();
  } catch {
  }
  let statusJson = {};
  try {
    statusJson = JSON.parse(fs3.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
  }
  const running = statusJson.running === true;
  const startedAt = statusJson.startedAt || "";
  if (running && pid) {
    try {
      process.kill(parseInt(pid, 10), 0);
      ok(`Bridge is ${c.green}running${c.reset} (PID: ${pid})`);
    } catch {
      warn(`Bridge status file says running, but PID ${pid} is dead`);
    }
  } else {
    fail(`Bridge is ${c.red}not running${c.reset}`);
  }
  if (startedAt) info(`Started at: ${startedAt}`);
  if (statusJson.lastExitReason) warn(`Last exit: ${statusJson.lastExitReason}`);
  const channels = statusJson.channels || [];
  if (channels.length) info(`Channels: ${channels.join(", ")}`);
  console.log("");
  if (fs3.existsSync(CONFIG_PATH)) {
    ok(`Config: ${CONFIG_PATH}`);
  } else {
    fail(`Config not found: ${CONFIG_PATH}`);
    info(`Run onboarding: ${c.cyan}${cliCommand("onboard")}${c.reset}`);
  }
  const port = process.env.CTI_DASHBOARD_PORT || "13578";
  if (running) {
    info(`Dashboard: ${c.cyan}http://127.0.0.1:${port}${c.reset}`);
  }
  console.log("");
}
function runDoctor() {
  showBanner();
  heading("\u{1FA7A} Diagnostics");
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`);
  } else {
    fail(`Node.js ${nodeVersion} \u2014 need >= 20`);
  }
  const agents = detectAgents();
  for (const agent of agents) {
    if (agent.installed) {
      ok(`${agent.name}: ${agent.version} (${agent.path})`);
    } else {
      warn(`${agent.name}: not found`);
    }
  }
  if (fs3.existsSync(CONFIG_PATH)) {
    ok(`Config exists: ${CONFIG_PATH}`);
    try {
      const content = fs3.readFileSync(CONFIG_PATH, "utf-8");
      const hasAppId = content.includes("CTI_FEISHU_APP_ID=") && !content.includes("CTI_FEISHU_APP_ID=your-app-id");
      const hasSecret = content.includes("CTI_FEISHU_APP_SECRET=") && !content.includes("CTI_FEISHU_APP_SECRET=your-app-secret");
      if (hasAppId) {
        ok("Feishu App ID configured");
      } else {
        fail("Feishu App ID missing or placeholder");
      }
      if (hasSecret) {
        ok("Feishu App Secret configured");
      } else {
        fail("Feishu App Secret missing or placeholder");
      }
    } catch {
      fail("Cannot read config file");
    }
  } else {
    fail(`Config not found: ${CONFIG_PATH}`);
    info(`Run onboarding: ${c.cyan}${cliCommand("onboard")}${c.reset}`);
  }
  const dataDir = path2.join(CTI_HOME, "data");
  if (fs3.existsSync(dataDir)) {
    ok(`Data directory: ${dataDir}`);
  } else {
    warn(`Data directory not found (will be created on first start)`);
  }
  let pid = "";
  try {
    pid = fs3.readFileSync(PID_FILE, "utf-8").trim();
  } catch {
  }
  if (pid) {
    try {
      process.kill(parseInt(pid, 10), 0);
      ok(`Bridge process alive (PID: ${pid})`);
    } catch {
      warn(`Stale PID file (PID ${pid} not running)`);
    }
  } else {
    info("Bridge not running");
  }
  const logFile = path2.join(CTI_HOME, "logs", "bridge.log");
  if (fs3.existsSync(logFile)) {
    const stat = fs3.statSync(logFile);
    ok(`Log file: ${logFile} (${(stat.size / 1024).toFixed(1)} KB)`);
    console.log("");
    info("Last 10 log lines:");
    try {
      const lines = fs3.readFileSync(logFile, "utf-8").trim().split("\n");
      const last = lines.slice(-10);
      for (const line of last) {
        console.log(`    ${c.dim}${line}${c.reset}`);
      }
    } catch {
    }
  } else {
    info("No log file yet");
  }
  console.log("");
}
function findDaemonScript() {
  const candidates = [
    path2.join(CLI_DIR, "..", "scripts", "daemon.sh"),
    path2.join(CLI_DIR, "scripts", "daemon.sh"),
    path2.join(process.cwd(), "scripts", "daemon.sh")
  ];
  for (const p of candidates) {
    if (fs3.existsSync(p)) return p;
  }
  return null;
}
async function runDaemonCommand(command) {
  const script = findDaemonScript();
  if (!script) {
    throw new Error("Cannot find daemon.sh script");
  }
  await runChild("bash", [script, command], {
    env: { ...process.env, CTI_HOME }
  });
}
function delegateToDaemon(command) {
  runDaemonCommand(command).then(() => {
    process.exit(0);
  }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    const packageRoot = findAgentsToImPackageRoot(CLI_DIR) || findAgentsToImPackageRoot(process.cwd());
    if (packageRoot && fs3.existsSync(path2.join(packageRoot, ".git"))) {
      info("If running from source, make sure you are in the project directory");
    } else {
      info(`If this is a packaged install, refresh it with ${c.cyan}${npmInstallCommand()}${c.reset}`);
    }
    process.exit(1);
  });
}
async function runUpgrade() {
  showBanner();
  heading("\u2B06\uFE0F Upgrade agents-to-im");
  const packageRoot = findAgentsToImPackageRoot(CLI_DIR) || findAgentsToImPackageRoot(process.cwd());
  if (!packageRoot) {
    fail("Cannot determine the agents-to-im package root from the current installation.");
    process.exit(1);
  }
  const currentVersion = readAgentsToImVersion(packageRoot);
  const isSourceCheckout = fs3.existsSync(path2.join(packageRoot, ".git"));
  const bridge = getBridgeStatusSnapshot();
  let gitStatusOutput = "";
  if (isSourceCheckout) {
    ensureCommandAvailable("git");
    try {
      gitStatusOutput = execSync2("git status --porcelain", {
        cwd: packageRoot,
        encoding: "utf-8",
        timeout: 5e3
      });
    } catch (error) {
      fail(`Cannot inspect git worktree: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  const result = buildUpgradePlan({
    packageRoot,
    currentVersion,
    isSourceCheckout,
    bridgeRunning: bridge.running,
    gitStatusOutput
  });
  if (!result.ok) {
    fail(result.reason);
    if (isSourceCheckout) {
      info("Commit or stash local changes, then rerun the upgrade command.");
    }
    process.exit(1);
  }
  const { plan } = result;
  for (const command of new Set(plan.steps.map((step) => step.command))) {
    ensureCommandAvailable(command);
  }
  info(`Current version: ${plan.currentVersion}`);
  info(`Install mode: ${plan.mode === "source" ? "source checkout" : "global npm package"}`);
  info(`Package root: ${plan.packageRoot}`);
  info(`Bridge running: ${bridge.running ? `yes${bridge.pid ? ` (PID: ${bridge.pid})` : ""}` : "no"}`);
  console.log("");
  info("Upgrade steps:");
  for (const step of plan.steps) {
    const location = step.cwd ? ` ${c.dim}(cwd: ${step.cwd})${c.reset}` : "";
    console.log(`    ${c.cyan}$ ${step.command} ${step.args.join(" ")}${c.reset}${location}`);
  }
  if (plan.restartBridge) {
    info("Bridge will be restarted after the upgrade completes.");
  }
  console.log("");
  for (const step of plan.steps) {
    info(`${step.description}...`);
    await runChild(step.command, step.args, {
      cwd: step.cwd,
      env: { ...process.env, CTI_HOME }
    });
    ok(step.description);
  }
  if (plan.restartBridge) {
    info("Restarting bridge...");
    await runDaemonCommand("restart");
    ok("Bridge restarted");
  } else {
    info(`Upgrade complete. Use ${c.cyan}${cliCommand("start")}${c.reset} when you want to run the bridge.`);
  }
  console.log("");
}
function isCliEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path2.resolve(entry) === fileURLToPath(import.meta.url);
}
function runCli(args = process.argv.slice(2)) {
  const command = args[0] || "";
  switch (command) {
    case "onboard":
    case "setup":
      setupWizard().catch((err) => {
        console.error("Setup error:", err);
        process.exit(1);
      });
      break;
    case "start":
      delegateToDaemon("start");
      break;
    case "restart":
      delegateToDaemon("restart");
      break;
    case "stop":
      delegateToDaemon("stop");
      break;
    case "status":
      showStatus();
      break;
    case "doctor":
      runDoctor();
      break;
    case "upgrade":
      runUpgrade().catch((error) => {
        fail(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
      break;
    case "logs": {
      const n = parseInt(args[1] || "50", 10);
      const logFile = path2.join(CTI_HOME, "logs", "bridge.log");
      if (fs3.existsSync(logFile)) {
        const lines = fs3.readFileSync(logFile, "utf-8").trim().split("\n");
        console.log(lines.slice(-n).join("\n"));
      } else {
        fail("No log file found");
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      showBanner();
      console.log(`  Usage: ${cliCommand()} [command]`);
      console.log("");
      console.log("  Commands:");
      console.log(`    ${c.cyan}(none)${c.reset}    Interactive onboarding wizard`);
      console.log(`    ${c.cyan}onboard${c.reset}   Run the onboarding wizard explicitly`);
      console.log(`    ${c.cyan}start${c.reset}     Start the bridge daemon`);
      console.log(`    ${c.cyan}restart${c.reset}   Restart the bridge daemon`);
      console.log(`    ${c.cyan}stop${c.reset}      Stop the bridge daemon`);
      console.log(`    ${c.cyan}status${c.reset}    Show bridge status`);
      console.log(`    ${c.cyan}doctor${c.reset}    Run diagnostics`);
      console.log(`    ${c.cyan}upgrade${c.reset}   Upgrade the local installation`);
      console.log(`    ${c.cyan}logs${c.reset} [n]  Show last n log lines (default 50)`);
      console.log(`    ${c.cyan}help${c.reset}      Show this help`);
      console.log("");
      break;
    default:
      if (command && !command.startsWith("-")) {
        fail(`Unknown command: ${command}`);
        info("Run with --help for usage");
        process.exit(1);
      }
      setupWizard().catch((err) => {
        console.error("Setup error:", err);
        process.exit(1);
      });
  }
}
if (isCliEntrypoint()) {
  runCli();
}
export {
  buildBannerLines,
  buildPlatformAuthUrl,
  buildPlatformBotUrl,
  buildPlatformEventUrl,
  buildPlatformSetupChecklist,
  detectDefaultOnboardLocale,
  getDisplayWidth,
  parseLaunchdPid,
  runCli
};
