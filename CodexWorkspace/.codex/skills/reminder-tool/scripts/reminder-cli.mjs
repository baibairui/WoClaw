#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_REMINDER_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const [command, ...rest] = argv;
if (command !== 'create') {
  fail(`unsupported reminder command: ${command || '(empty)'}`);
}

const args = parseArgs(rest);
const message = String(args.message ?? '').trim();
if (!message) {
  fail('missing --message');
}

const delayMs = resolveDelayMs({
  delay: typeof args.delay === 'string' ? args.delay : undefined,
  delayMs: args['delay-ms'] ?? args.delayMs,
});
if (delayMs === undefined) {
  fail('provide a valid --delay or --delay-ms');
}

const dbPath = requireEnv('GATEWAY_REMINDER_DB_PATH');
const channel = requireChannel(process.env.GATEWAY_REMINDER_CHANNEL);
const userId = requireEnv('GATEWAY_REMINDER_USER_ID');
const sourceAgentId = process.env.GATEWAY_REMINDER_AGENT_ID?.trim() || null;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
ensureSchema(db);

const now = Date.now();
const dueAt = now + delayMs;
const id = randomUUID();
db.prepare(`
  INSERT INTO reminder_task(id, channel, user_id, message, created_at, due_at, status, sent_at, source_agent_id)
  VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
`).run(id, channel, userId, message, now, dueAt, sourceAgentId);

process.stdout.write(`${JSON.stringify({
  ok: true,
  reminder_id: id,
  due_at: dueAt,
  delay_ms: delayMs,
  message,
}, null, 2)}\n`);

function printHelp() {
  process.stdout.write('Reminder CLI\n\nCommands:\n  create --delay <5min|2h|1d> --message <text>\n  create --delay-ms <milliseconds> --message <text>\n');
}

function parseArgs(tokens) {
  const output = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      fail(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = tokens[i + 1];
    if (!value || value.startsWith('--')) {
      output[key] = 'true';
      continue;
    }
    output[key] = value;
    i += 1;
  }
  return output;
}

function ensureSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS reminder_task (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      sent_at INTEGER,
      source_agent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_task_status_due_at
      ON reminder_task(status, due_at);
  `);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`missing required env: ${name}`);
  }
  return value;
}

function requireChannel(value) {
  if (value === 'wecom' || value === 'feishu' || value === 'weixin') {
    return value;
  }
  fail('invalid GATEWAY_REMINDER_CHANNEL');
}

function resolveDelayMs(input) {
  if (typeof input.delayMs === 'string' && input.delayMs.trim()) {
    const parsed = Number.parseInt(input.delayMs, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_REMINDER_DELAY_MS) {
      return parsed;
    }
    return undefined;
  }
  if (typeof input.delay === 'string') {
    return parseReminderDelayMs(input.delay);
  }
  return undefined;
}

function parseReminderDelayMs(input) {
  const value = input.trim().toLowerCase();
  const match = value.match(/^(\d+)(秒钟?|秒|s|sec|secs|second|seconds|分钟?|分|min|mins|minute|minutes|小时?|时|h|hr|hrs|hour|hours|天|d|day|days)$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = String(match[2] || '').toLowerCase();
  if (['秒', '秒钟', 's', 'sec', 'secs', 'second', 'seconds'].includes(unit)) {
    return amount * 1000;
  }
  if (['分', '分钟', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
    return amount * 60 * 1000;
  }
  if (['时', '小时', 'h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
    return amount * 60 * 60 * 1000;
  }
  if (['天', 'd', 'day', 'days'].includes(unit)) {
    return amount * 24 * 60 * 60 * 1000;
  }
  return undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
