import fs from 'node:fs';
import path from 'node:path';
import { upsertManagedSection } from './agents-managed-sections.js';

export const GATEWAY_BROWSER_SKILL_NAME = 'gateway-browser';
const LEGACY_SKILL_NAMES = ['playwright-explore-website', 'react-best-practices'];
const BROWSER_RULE_START = '<!-- gateway:browser-rule:start -->';
const BROWSER_RULE_END = '<!-- gateway:browser-rule:end -->';
const BROWSER_HANDOFF_TRIGGER_SUMMARY = 'login/OTP/captcha/payment confirmation';
const BROWSER_STOP_CONDITION_SUMMARY = 'the page intent is ambiguous, multiple similar targets exist, or the expected page state did not appear';

interface GlobalSkillSyncOptions {
  roots?: string[];
}

let configuredManagedGlobalSkillRoots: string[] | undefined;

export function installGatewayBrowserSkill(workspaceDir: string): void {
  installToSkillRoot(path.join(workspaceDir, '.codex', 'skills'));
  ensureAgentsBrowserRule(workspaceDir);
}

export function syncManagedGlobalSkills(options: GlobalSkillSyncOptions = {}): void {
  const roots = options.roots ?? defaultGlobalSkillRoots();
  for (const root of roots) {
    installToSkillRoot(root);
    purgeLegacySkills(root);
  }
}

export function configureManagedGlobalSkillRoots(roots: string[] | undefined): void {
  configuredManagedGlobalSkillRoots = normalizeManagedGlobalSkillRoots(roots);
}

export function renderGatewayBrowserSkill(): string {
  return [
    '---',
    'name: gateway-browser',
    'description: Use when tasks require operating web pages. Run the bundled browser script in this skill so browser actions stay observable and reversible.',
    '---',
    '',
    '# Gateway Browser Skill',
    '',
    'When the user asks for browser operations, run the bundled browser script in this skill.',
    '',
    'Workflow:',
    '1. Read current page state with `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs snapshot` before deciding the next action.',
    '2. Execute one minimal action at a time (click/type/select-option/navigate/wait-for).',
    '3. Re-run `snapshot` after each key action; refs are not stable across navigations.',
    '4. If needed, use `screenshot`, `tabs`, `evaluate`, or recording commands to collect evidence.',
    '5. Report action, evidence, result, and next step.',
    '',
    'Environment:',
    '- `GATEWAY_BROWSER_API_BASE`',
    '- `GATEWAY_INTERNAL_API_TOKEN`',
    '',
    'Examples:',
    '- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs snapshot`',
    '- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs navigate --url "https://example.com"`',
    '- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs click --ref e1`',
    '- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs type --ref e2 --text "hello" --submit true`',
    '- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs tabs --action list`',
    '',
    'Report format:',
    '- Action: what changed on the page in this step.',
    '- Evidence: snapshot/screenshot/console/network findings that support the conclusion.',
    '- Result: success, blocked state, or failure reason.',
    '- Next step: the next minimal action or the exact user takeover request.',
    '',
    'Status templates:',
    '- In progress: report the latest action, current evidence, and immediate next step.',
    '- Blocked: report the blocker, risk, and the exact decision needed from the user.',
    '- Handoff: report why user takeover is required, what state is preserved, and how to resume.',
    '- Done: report what was completed, the final result/artifact, and any follow-up suggestion.',
    '',
    'Stop conditions:',
    `- Stop when ${BROWSER_STOP_CONDITION_SUMMARY}.`,
    '- Stop when a modal, redirect, or permission prompt changes the task scope unexpectedly.',
    '- Stop when the action would send external data, upload files, or submit content the user did not explicitly approve.',
    '- When stopping, report the last confirmed page state and the exact decision needed from the user.',
    '',
    'Rules:',
    '- Reuse existing tabs whenever possible.',
    '- Prefer visible, reversible actions over hidden shortcuts.',
    '- Do not run Playwright directly or invent another browser wrapper; use only the script bundled in this skill.',
    `- On ${BROWSER_HANDOFF_TRIGGER_SUMMARY}, request user takeover.`,
    '- Before submit/delete/publish/payment or other irreversible actions, capture evidence and confirm intent if the user did not state it explicitly.',
    '- If the page is visually unclear or the user asks what is on screen, capture a screenshot instead of guessing from stale refs.',
    '- If an action fails twice, stop and ask for user decision.',
    '- If a click/type fails, refresh the snapshot first, then inspect console/network before retrying.',
    '- During user takeover, keep the current tab/state intact and report the exact resume point.',
    '- Treat logged-in browser profiles, cookies, and storage as sensitive data.',
    '- Avoid arbitrary page-context JS unless it is necessary to inspect or unblock the task.',
    '',
  ].join('\n');
}

function renderGatewayBrowserOpenAiYaml(): string {
  return [
    'interface:',
    '  display_name: "Gateway Browser"',
    '  short_description: "Operate the gateway-owned browser through the gateway-browser skill."',
    '  default_prompt: "Use $gateway-browser when the user wants browser operations."',
    'policy:',
    '  allow_implicit_invocation: true',
    '',
  ].join('\n');
}

function renderGatewayBrowserScript(): string {
  return [
    '#!/usr/bin/env node',
    '',
    "import process from 'node:process';",
    '',
    "const apiBaseUrl = requireEnv('GATEWAY_BROWSER_API_BASE');",
    "const internalToken = requireEnv('GATEWAY_INTERNAL_API_TOKEN');",
    'const argv = process.argv.slice(2);',
    "if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {",
    '  printHelp();',
    '  process.exit(0);',
    '}',
    '',
    'const [command, ...rest] = argv;',
    'const parsed = parseArgs(rest);',
    'const args = normalizeArgs(command, parsed);',
    '',
    'const response = await fetch(`${apiBaseUrl.replace(/\\/+$/, "")}/execute`, {',
    "  method: 'POST',",
    '  headers: {',
    "    'content-type': 'application/json',",
    "    'x-gateway-internal-token': internalToken,",
    '  },',
    '  body: JSON.stringify({ command, args }),',
    '});',
    '',
    'const payload = await response.json().catch(() => ({}));',
    'if (!response.ok || payload.ok !== true) {',
    "  const message = typeof payload.error === 'string' ? payload.error : `browser command failed: ${response.status}`;",
    '  fail(message);',
    '}',
    '',
    'process.stdout.write(`${JSON.stringify(payload, null, 2)}\\n`);',
    '',
    'function printHelp() {',
    "  process.stdout.write([",
    "    'Gateway Browser CLI',",
    "    '',",
    "    'Commands:',",
    "    '  snapshot',",
    "    '  navigate --url <url>',",
    "    '  click --ref <e1>',",
    "    '  hover --ref <e1>',",
    "    '  drag --start-ref <e1> --end-ref <e2>',",
    "    '  type --ref <e1> --text <value> [--slowly true] [--submit true]',",
    "    '  select-option --ref <e1> --values a,b',",
    "    '  press-key --key Enter',",
    "    '  wait-for [--time 3] [--text foo] [--text-gone foo]',",
    "    '  evaluate --function \"() => document.title\" [--ref e1]',",
    "    '  file-upload --ref <e1> --paths /tmp/a.png,/tmp/b.png',",
    "    '  fill-form --json <json>',",
    "    '  handle-dialog --accept true [--prompt-text value]',",
    "    '  resize --width 1440 --height 900',",
    "    '  screenshot [--filename page.png] [--full-page true] [--type png] [--ref e1]',",
    "    '  navigate-back',",
    "    '  close',",
    "    '  start-recording [--filename demo.mp4] [--interval-ms 400]',",
    "    '  stop-recording',",
    "    '  tabs --action list|new|select|close [--index 0]',",
    "  ].join('\\n'));",
    '}',
    '',
    'function parseArgs(tokens) {',
    '  const output = {};',
    '  for (let i = 0; i < tokens.length; i += 1) {',
    '    const token = tokens[i];',
    "    if (!token.startsWith('--')) {",
    '      fail(`unexpected argument: ${token}`);',
    '    }',
    '    const key = token.slice(2);',
    '    const value = tokens[i + 1];',
    "    if (!value || value.startsWith('--')) {",
    "      output[key] = 'true';",
    '      continue;',
    '    }',
    '    output[key] = value;',
    '    i += 1;',
    '  }',
    '  return output;',
    '}',
    '',
    'function normalizeArgs(command, parsed) {',
    "  const jsonPayload = typeof parsed.json === 'string' && parsed.json.trim() ? parseJson(parsed.json, '--json') : {};",
    '  const args = { ...jsonPayload };',
    '  switch (command) {',
    "    case 'snapshot':",
    "    case 'navigate-back':",
    "    case 'close':",
    "    case 'stop-recording':",
    '      return args;',
    "    case 'navigate':",
    '      return { ...args, url: stringValue(parsed.url) };',
    "    case 'click':",
    "    case 'hover':",
    '      return { ...args, ref: stringValue(parsed.ref) };',
    "    case 'drag':",
    '      return { ...args, startRef: stringValue(parsed["start-ref"] ?? parsed.startRef), endRef: stringValue(parsed["end-ref"] ?? parsed.endRef) };',
    "    case 'type':",
    '      return {',
    '        ...args,',
    '        ref: stringValue(parsed.ref),',
    '        text: stringValue(parsed.text),',
    '        slowly: booleanValue(parsed.slowly),',
    '        submit: booleanValue(parsed.submit),',
    '      };',
    "    case 'select-option':",
    '      return {',
    '        ...args,',
    '        ref: stringValue(parsed.ref),',
    '        values: arrayValue(parsed.values),',
    '      };',
    "    case 'press-key':",
    '      return { ...args, key: stringValue(parsed.key) };',
    "    case 'wait-for':",
    '      return {',
    '        ...args,',
    '        time: numberValue(parsed.time),',
    '        text: optionalString(parsed.text),',
    '        textGone: optionalString(parsed["text-gone"] ?? parsed.textGone),',
    '      };',
    "    case 'evaluate':",
    '      return {',
    '        ...args,',
    '        function: stringValue(parsed.function),',
    '        ref: optionalString(parsed.ref),',
    '      };',
    "    case 'file-upload':",
    '      return {',
    '        ...args,',
    '        ref: stringValue(parsed.ref),',
    '        paths: arrayValue(parsed.paths),',
    '      };',
    "    case 'fill-form':",
    '      return {',
    '        ...args,',
    '        fields: Array.isArray(args.fields) ? args.fields : [],',
    '      };',
    "    case 'handle-dialog':",
    '      return {',
    '        ...args,',
    '        accept: booleanValue(parsed.accept),',
    '        promptText: optionalString(parsed["prompt-text"] ?? parsed.promptText),',
    '      };',
    "    case 'resize':",
    '      return {',
    '        ...args,',
    '        width: requiredNumber(parsed.width, "--width"),',
    '        height: requiredNumber(parsed.height, "--height"),',
    '      };',
    "    case 'screenshot':",
    '      return {',
    '        ...args,',
    '        filename: optionalString(parsed.filename),',
    '        fullPage: booleanValue(parsed["full-page"] ?? parsed.fullPage),',
    '        type: optionalString(parsed.type),',
    '        ref: optionalString(parsed.ref),',
    '      };',
    "    case 'start-recording':",
    '      return {',
    '        ...args,',
    '        filename: optionalString(parsed.filename),',
    '        intervalMs: numberValue(parsed["interval-ms"] ?? parsed.intervalMs),',
    '      };',
    "    case 'tabs':",
    '      return {',
    '        ...args,',
    '        action: optionalString(parsed.action) || "list",',
    '        index: numberValue(parsed.index),',
    '      };',
    '    default:',
    '      fail(`unsupported browser command: ${command}`);',
    '  }',
    '}',
    '',
    'function requireEnv(name) {',
    "  const value = process.env[name]?.trim();",
    '  if (!value) {',
    '    fail(`missing required env: ${name}`);',
    '  }',
    '  return value;',
    '}',
    '',
    'function stringValue(value) {',
    '  const text = optionalString(value);',
    '  if (!text) {',
    "    fail('missing required argument');",
    '  }',
    '  return text;',
    '}',
    '',
    'function optionalString(value) {',
    "  return typeof value === 'string' && value.trim() ? value.trim() : undefined;",
    '}',
    '',
    'function booleanValue(value) {',
    "  if (value === undefined) {",
    '    return undefined;',
    '  }',
    "  if (value === true || value === 'true') {",
    '    return true;',
    '  }',
    "  if (value === false || value === 'false') {",
    '    return false;',
    '  }',
    "  fail(`invalid boolean value: ${value}`);",
    '}',
    '',
    'function numberValue(value) {',
    "  if (value === undefined || value === '') {",
    '    return undefined;',
    '  }',
    '  const parsed = Number(value);',
    '  if (!Number.isFinite(parsed)) {',
    "    fail(`invalid number value: ${value}`);",
    '  }',
    '  return parsed;',
    '}',
    '',
    'function requiredNumber(value, flagName) {',
    '  const parsed = numberValue(value);',
    '  if (parsed === undefined) {',
    '    fail(`missing required ${flagName}`);',
    '  }',
    '  return parsed;',
    '}',
    '',
    'function arrayValue(value) {',
    "  if (typeof value !== 'string' || !value.trim()) {",
    '    return [];',
    '  }',
    '  return value.split(",").map((item) => item.trim()).filter(Boolean);',
    '}',
    '',
    'function parseJson(value, flagName) {',
    '  try {',
    '    return JSON.parse(value);',
    '  } catch {',
    '    fail(`invalid JSON for ${flagName}`);',
    '  }',
    '}',
    '',
    'function fail(message) {',
    '  process.stderr.write(`${message}\\n`);',
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

function renderAgentsBrowserRuleSection(): string {
  return [
    BROWSER_RULE_START,
    '浏览器操作职责：',
    '- 当任务需要网页交互时，只允许使用 `./.codex/skills/gateway-browser/SKILL.md` 及其自带脚本完成操作，不要让用户手工点击。',
    '- 禁止直接使用 playwright-cli、任何自定义 wrapper script、/open 或其他 shell/browser 启动通道。',
    '- 每次操作前先说明计划步骤，操作后按“Action / Evidence / Result / Next step”回报。',
    '- 页面意图模糊、多个相似目标并存、或预期状态未出现时，先暂停并请求用户决策。',
    '- 涉及提交、发布、支付、外部数据发送、文件上传时，若用户未明确授权，先暂停并确认。',
    '- 如果网页需要登录、验证码或支付确认，先提示用户接管，不要编造已完成。',
    '- 人工接管触发条件可直接按这组理解：登录、验证码、扫码、支付确认、权限弹窗、高风险提交、页面目标歧义。',
    BROWSER_RULE_END,
  ].join('\n');
}

function installToSkillRoot(skillRootDir: string): void {
  const skillDir = path.join(skillRootDir, GATEWAY_BROWSER_SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  writeIfChanged(path.join(skillDir, 'SKILL.md'), renderGatewayBrowserSkill());
  writeIfChanged(path.join(skillDir, 'agents', 'openai.yaml'), renderGatewayBrowserOpenAiYaml());
  writeIfChanged(path.join(skillDir, 'scripts', 'gateway-browser.mjs'), renderGatewayBrowserScript());
}

function purgeLegacySkills(skillRootDir: string): void {
  for (const name of LEGACY_SKILL_NAMES) {
    fs.rmSync(path.join(skillRootDir, name), { recursive: true, force: true });
  }
}

function ensureAgentsBrowserRule(workspaceDir: string): void {
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return;
  }
  const content = fs.readFileSync(agentsPath, 'utf8');
  const next = upsertManagedSection(
    content,
    BROWSER_RULE_START,
    BROWSER_RULE_END,
    renderAgentsBrowserRuleSection(),
    [
      /(?:\n|^)浏览器操作职责：[\s\S]*?(?=\n定时提醒职责：|\n开始任何任务前，先阅读这些记忆文件：|\n<!-- gateway:reminder-rule:start -->|\n$)/m,
    ],
  );
  if (next !== content) {
    fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, 'utf8');
  }
}

function writeIfChanged(filePath: string, content: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  if (existing === content) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

export function defaultGlobalSkillRoots(): string[] {
  if (configuredManagedGlobalSkillRoots?.length) {
    return [...configuredManagedGlobalSkillRoots];
  }

  const codexHomeDir = process.env.CODEX_HOME?.trim();
  if (!codexHomeDir) {
    return [];
  }

  const resolvedHome = path.resolve(codexHomeDir);
  return [path.join(resolvedHome, '.codex', 'skills')];
}

function normalizeManagedGlobalSkillRoots(roots: string[] | undefined): string[] | undefined {
  if (!roots) {
    return undefined;
  }

  const normalized = roots
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}
