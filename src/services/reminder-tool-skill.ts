import fs from 'node:fs';
import path from 'node:path';
import { upsertManagedSection } from './agents-managed-sections.js';

export const REMINDER_TOOL_SKILL_NAME = 'reminder-tool';
const REMINDER_RULE_START = '<!-- gateway:reminder-rule:start -->';
const REMINDER_RULE_END = '<!-- gateway:reminder-rule:end -->';

export function installReminderToolSkill(workspaceDir: string): void {
  installToSkillRoot(path.join(workspaceDir, '.codex', 'skills'));
  removeLegacySkillDirs(workspaceDir);
  ensureAgentsReminderRule(workspaceDir);
}

export function renderReminderToolSkill(): string {
  return [
    '---',
    'name: reminder-tool',
    'description: Use when a user asks to be reminded later, at a time, after a delay, or on a schedule in the current chat. Runs the bundled reminder script to create a durable reminder task instead of emitting reminder-action text blocks or asking the user to run /remind.',
    '---',
    '',
    '# Reminder Tool',
    '',
    'When the user asks for a reminder, run the bundled script in this skill.',
    '',
    'Use this workflow:',
    '1. Extract the delay and reminder message.',
    '2. If the delay is ambiguous, ask a follow-up question before running the command.',
    '3. Run `node ./.codex/skills/reminder-tool/scripts/reminder-cli.mjs create --delay <value> --message <text>`.',
    '4. Read the returned JSON and tell the user the reminder has been created. Do not emit fenced action blocks.',
    '',
    'Rules:',
    '- Prefer `delay` for simple durations such as `5min`, `2h`, `1d`.',
    '- Keep `message` short, concrete, and action-oriented.',
    '- Never ask the user to type `/remind`.',
    '- Never output ```reminder-action blocks.',
    '- The script expects these env vars to already exist in the runtime: `GATEWAY_REMINDER_DB_PATH`, `GATEWAY_REMINDER_CHANNEL`, `GATEWAY_REMINDER_USER_ID`.',
    '',
    'Examples:',
    '- User: `20分钟后提醒我开会`',
    '  Run: `node ./.codex/skills/reminder-tool/scripts/reminder-cli.mjs create --delay 20min --message "开会"`',
    '- User: `明天提醒我交周报`',
    '  If the exact trigger time is unclear, ask for a concrete time first.',
    '',
  ].join('\n');
}

function renderReminderToolOpenAiYaml(): string {
  return [
    'interface:',
    '  display_name: "Reminder Tool"',
    '  short_description: "Create durable chat reminders with the reminder-tool skill."',
    '  default_prompt: "Use $reminder-tool to create a reminder for this chat."',
    'policy:',
    '  allow_implicit_invocation: true',
    '',
  ].join('\n');
}

function renderReminderToolScript(): string {
  return [
    '#!/usr/bin/env node',
    '',
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import process from 'node:process';",
    "import { randomUUID } from 'node:crypto';",
    "import { DatabaseSync } from 'node:sqlite';",
    '',
    'const MAX_REMINDER_DELAY_MS = 30 * 24 * 60 * 60 * 1000;',
    '',
    'const argv = process.argv.slice(2);',
    "if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {",
    '  printHelp();',
    '  process.exit(0);',
    '}',
    '',
    'const [command, ...rest] = argv;',
    "if (command !== 'create') {",
    "  fail(`unsupported reminder command: ${command || '(empty)'}`);",
    '}',
    '',
    'const args = parseArgs(rest);',
    "const message = String(args.message ?? '').trim();",
    'if (!message) {',
    "  fail('missing --message');",
    '}',
    '',
    'const delayMs = resolveDelayMs({',
    "  delay: typeof args.delay === 'string' ? args.delay : undefined,",
    "  delayMs: args['delay-ms'] ?? args.delayMs,",
    '});',
    'if (delayMs === undefined) {',
    "  fail('provide a valid --delay or --delay-ms');",
    '}',
    '',
    "const dbPath = requireEnv('GATEWAY_REMINDER_DB_PATH');",
    "const channel = requireChannel(process.env.GATEWAY_REMINDER_CHANNEL);",
    "const userId = requireEnv('GATEWAY_REMINDER_USER_ID');",
    "const sourceAgentId = process.env.GATEWAY_REMINDER_AGENT_ID?.trim() || null;",
    '',
    'fs.mkdirSync(path.dirname(dbPath), { recursive: true });',
    'const db = new DatabaseSync(dbPath);',
    'ensureSchema(db);',
    '',
    'const now = Date.now();',
    'const dueAt = now + delayMs;',
    'const id = randomUUID();',
    'db.prepare(`',
    '  INSERT INTO reminder_task(id, channel, user_id, message, created_at, due_at, status, sent_at, source_agent_id)',
    "  VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL, ?)",
    '`).run(id, channel, userId, message, now, dueAt, sourceAgentId);',
    '',
    'process.stdout.write(`${JSON.stringify({',
    '  ok: true,',
    '  reminder_id: id,',
    '  due_at: dueAt,',
    '  delay_ms: delayMs,',
    '  message,',
    '}, null, 2)}\\n`);',
    '',
    'function printHelp() {',
    "  process.stdout.write('Reminder CLI\\n\\nCommands:\\n  create --delay <5min|2h|1d> --message <text>\\n  create --delay-ms <milliseconds> --message <text>\\n');",
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
    'function ensureSchema(database) {',
    '  database.exec(`',
    '    PRAGMA journal_mode = WAL;',
    '    PRAGMA synchronous = NORMAL;',
    '    CREATE TABLE IF NOT EXISTS reminder_task (',
    '      id TEXT PRIMARY KEY,',
    '      channel TEXT NOT NULL,',
    '      user_id TEXT NOT NULL,',
    '      message TEXT NOT NULL,',
    '      created_at INTEGER NOT NULL,',
    '      due_at INTEGER NOT NULL,',
    '      status TEXT NOT NULL,',
    '      sent_at INTEGER,',
    '      source_agent_id TEXT',
    '    );',
    '    CREATE INDEX IF NOT EXISTS idx_reminder_task_status_due_at',
    '      ON reminder_task(status, due_at);',
    '  `);',
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
    'function requireChannel(value) {',
    "  if (value === 'wecom' || value === 'feishu' || value === 'weixin') {",
    '    return value;',
    '  }',
    "  fail('invalid GATEWAY_REMINDER_CHANNEL');",
    '}',
    '',
    'function resolveDelayMs(input) {',
    "  if (typeof input.delayMs === 'string' && input.delayMs.trim()) {",
    '    const parsed = Number.parseInt(input.delayMs, 10);',
    '    if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_REMINDER_DELAY_MS) {',
    '      return parsed;',
    '    }',
    '    return undefined;',
    '  }',
    "  if (typeof input.delay === 'string') {",
    '    return parseReminderDelayMs(input.delay);',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function parseReminderDelayMs(input) {',
    "  const value = input.trim().toLowerCase();",
    "  const match = value.match(/^(\\d+)(秒钟?|秒|s|sec|secs|second|seconds|分钟?|分|min|mins|minute|minutes|小时?|时|h|hr|hrs|hour|hours|天|d|day|days)$/i);",
    '  if (!match) {',
    '    return undefined;',
    '  }',
    '  const amount = Number(match[1]);',
    '  if (!Number.isFinite(amount) || amount <= 0) {',
    '    return undefined;',
    '  }',
    "  const unit = String(match[2] || '').toLowerCase();",
    "  if (['秒', '秒钟', 's', 'sec', 'secs', 'second', 'seconds'].includes(unit)) {",
    '    return amount * 1000;',
    '  }',
    "  if (['分', '分钟', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {",
    '    return amount * 60 * 1000;',
    '  }',
    "  if (['时', '小时', 'h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {",
    '    return amount * 60 * 60 * 1000;',
    '  }',
    "  if (['天', 'd', 'day', 'days'].includes(unit)) {",
    '    return amount * 24 * 60 * 60 * 1000;',
    '  }',
    '  return undefined;',
    '}',
    '',
    'function fail(message) {',
    '  process.stderr.write(`${message}\\n`);',
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
}

function writeIfChanged(filePath: string, content: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  if (existing === content) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureAgentsReminderRule(workspaceDir: string): void {
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return;
  }
  const content = fs.readFileSync(agentsPath, 'utf8');
  const reminderSection = [
    REMINDER_RULE_START,
    '提醒规则：',
    '- 用户提出“稍后提醒我”或定时任务需求时，优先使用 `./.codex/skills/reminder-tool/SKILL.md`。',
    '- 必须执行该 skill 自带 reminder 脚本创建提醒，不要要求用户输入 `/remind`。',
    REMINDER_RULE_END,
  ].join('\n');
  const next = upsertManagedSection(content, REMINDER_RULE_START, REMINDER_RULE_END, reminderSection, [
    /(?:\n|^)提醒规则：[\s\S]*?(?=\n[A-Z\u4e00-\u9fff#].*：|\n执行权限规则：|\n飞书官方操作规则：|\n$)/m,
  ]);
  if (next !== content) {
    fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, 'utf8');
  }
}

function installToSkillRoot(skillRootDir: string): void {
  const skillDir = path.join(skillRootDir, REMINDER_TOOL_SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  writeIfChanged(path.join(skillDir, 'SKILL.md'), renderReminderToolSkill());
  writeIfChanged(path.join(skillDir, 'agents', 'openai.yaml'), renderReminderToolOpenAiYaml());
  writeIfChanged(path.join(skillDir, 'scripts', 'reminder-cli.mjs'), renderReminderToolScript());
}

function removeLegacySkillDirs(workspaceDir: string): void {
  fs.rmSync(path.join(workspaceDir, 'skills', REMINDER_TOOL_SKILL_NAME), { recursive: true, force: true });
  fs.rmSync(path.join(workspaceDir, '.agent', 'skills', REMINDER_TOOL_SKILL_NAME), { recursive: true, force: true });
}
