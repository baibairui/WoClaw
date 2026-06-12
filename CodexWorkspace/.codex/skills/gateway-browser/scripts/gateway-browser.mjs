#!/usr/bin/env node

import process from 'node:process';

const apiBaseUrl = requireEnv('GATEWAY_BROWSER_API_BASE');
const internalToken = requireEnv('GATEWAY_INTERNAL_API_TOKEN');
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const [command, ...rest] = argv;
const parsed = parseArgs(rest);
const args = normalizeArgs(command, parsed);

const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/execute`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-gateway-internal-token': internalToken,
  },
  body: JSON.stringify({ command, args }),
});

const payload = await response.json().catch(() => ({}));
if (!response.ok || payload.ok !== true) {
  const message = typeof payload.error === 'string' ? payload.error : `browser command failed: ${response.status}`;
  fail(message);
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

function printHelp() {
  process.stdout.write([
    'Gateway Browser CLI',
    '',
    'Commands:',
    '  snapshot',
    '  navigate --url <url>',
    '  click --ref <e1>',
    '  hover --ref <e1>',
    '  drag --start-ref <e1> --end-ref <e2>',
    '  type --ref <e1> --text <value> [--slowly true] [--submit true]',
    '  select-option --ref <e1> --values a,b',
    '  press-key --key Enter',
    '  wait-for [--time 3] [--text foo] [--text-gone foo]',
    '  evaluate --function "() => document.title" [--ref e1]',
    '  file-upload --ref <e1> --paths /tmp/a.png,/tmp/b.png',
    '  fill-form --json <json>',
    '  handle-dialog --accept true [--prompt-text value]',
    '  resize --width 1440 --height 900',
    '  screenshot [--filename page.png] [--full-page true] [--type png] [--ref e1]',
    '  navigate-back',
    '  close',
    '  start-recording [--filename demo.mp4] [--interval-ms 400]',
    '  stop-recording',
    '  tabs --action list|new|select|close [--index 0]',
  ].join('\n'));
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

function normalizeArgs(command, parsed) {
  const jsonPayload = typeof parsed.json === 'string' && parsed.json.trim() ? parseJson(parsed.json, '--json') : {};
  const args = { ...jsonPayload };
  switch (command) {
    case 'snapshot':
    case 'navigate-back':
    case 'close':
    case 'stop-recording':
      return args;
    case 'navigate':
      return { ...args, url: stringValue(parsed.url) };
    case 'click':
    case 'hover':
      return { ...args, ref: stringValue(parsed.ref) };
    case 'drag':
      return { ...args, startRef: stringValue(parsed["start-ref"] ?? parsed.startRef), endRef: stringValue(parsed["end-ref"] ?? parsed.endRef) };
    case 'type':
      return {
        ...args,
        ref: stringValue(parsed.ref),
        text: stringValue(parsed.text),
        slowly: booleanValue(parsed.slowly),
        submit: booleanValue(parsed.submit),
      };
    case 'select-option':
      return {
        ...args,
        ref: stringValue(parsed.ref),
        values: arrayValue(parsed.values),
      };
    case 'press-key':
      return { ...args, key: stringValue(parsed.key) };
    case 'wait-for':
      return {
        ...args,
        time: numberValue(parsed.time),
        text: optionalString(parsed.text),
        textGone: optionalString(parsed["text-gone"] ?? parsed.textGone),
      };
    case 'evaluate':
      return {
        ...args,
        function: stringValue(parsed.function),
        ref: optionalString(parsed.ref),
      };
    case 'file-upload':
      return {
        ...args,
        ref: stringValue(parsed.ref),
        paths: arrayValue(parsed.paths),
      };
    case 'fill-form':
      return {
        ...args,
        fields: Array.isArray(args.fields) ? args.fields : [],
      };
    case 'handle-dialog':
      return {
        ...args,
        accept: booleanValue(parsed.accept),
        promptText: optionalString(parsed["prompt-text"] ?? parsed.promptText),
      };
    case 'resize':
      return {
        ...args,
        width: requiredNumber(parsed.width, "--width"),
        height: requiredNumber(parsed.height, "--height"),
      };
    case 'screenshot':
      return {
        ...args,
        filename: optionalString(parsed.filename),
        fullPage: booleanValue(parsed["full-page"] ?? parsed.fullPage),
        type: optionalString(parsed.type),
        ref: optionalString(parsed.ref),
      };
    case 'start-recording':
      return {
        ...args,
        filename: optionalString(parsed.filename),
        intervalMs: numberValue(parsed["interval-ms"] ?? parsed.intervalMs),
      };
    case 'tabs':
      return {
        ...args,
        action: optionalString(parsed.action) || "list",
        index: numberValue(parsed.index),
      };
    default:
      fail(`unsupported browser command: ${command}`);
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`missing required env: ${name}`);
  }
  return value;
}

function stringValue(value) {
  const text = optionalString(value);
  if (!text) {
    fail('missing required argument');
  }
  return text;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  fail(`invalid boolean value: ${value}`);
}

function numberValue(value) {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`invalid number value: ${value}`);
  }
  return parsed;
}

function requiredNumber(value, flagName) {
  const parsed = numberValue(value);
  if (parsed === undefined) {
    fail(`missing required ${flagName}`);
  }
  return parsed;
}

function arrayValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseJson(value, flagName) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`invalid JSON for ${flagName}`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
