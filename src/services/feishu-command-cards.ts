type Channel = 'wecom' | 'feishu' | 'weixin';
type CliProvider = 'codex' | 'opencode';
type RunStatus = 'running' | 'stopping' | 'stopped' | 'stop_failed' | 'completed';

type FeishuCardTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'grey';

interface CommandQuickAction {
  label: string;
  cmd: string;
  type?: 'default' | 'primary' | 'danger';
}

interface FeishuCardButton {
  label: string;
  cmd: string;
  type?: 'default' | 'primary' | 'danger';
}

interface FeishuValueButton {
  label: string;
  value?: Record<string, unknown>;
  multiUrl?: string;
  type?: 'default' | 'primary' | 'danger';
}

interface FeishuCardField {
  label: string;
  value: string;
}

type CardElementBuilder = (text: string) => Array<Record<string, unknown>>;
const COMMAND_LABELS: Record<string, string> = {
  '/help': '命令帮助',
  '/new': '会话管理',
  '/clear': '会话管理',
  '/session': '当前会话',
  '/sessions': '会话列表',
  '/agents': 'Agent 列表',
  '/agent': 'Agent 管理',
  '/skill-agent': '技能扩展助手',
  '/skillagent': '技能扩展助手',
  '/skill': '技能扩展助手',
  '/login': '登录授权',
  '/rename': '会话重命名',
  '/switch': '会话切换',
  '/model': '模型管理',
  '/provider': '框架管理',
  '/models': '模型列表',
  '/skills': 'Skill 管理',
  '/search': '联网搜索',
  '/goal': '目标管理',
  '/failure': '处理未完成',
  '/deploy-workspace': 'Workspace 发布',
  '/publish-workspace': 'Workspace 发布',
  '/review': '代码审查',
};

const COMMAND_SUMMARIES: Record<string, string> = {
  '/session': '查看当前会话上下文，并进入切换或重命名流程。',
  '/sessions': '管理当前 agent 的历史会话，快速定位并切换目标会话。',
  '/agents': '查看可用 agent 列表，并在不同工作区之间切换。',
  '/agent': '查看当前 agent 状态，包括工作区和会话绑定情况。',
  '/skills': '查看当前会话生效的 skills，并快速切换不同范围。',
  '/model': '查看或切换当前模型，并在需要时恢复默认值。',
  '/provider': '查看当前执行框架，并通过卡片按钮切换 Codex 或 OpenCode。',
  '/models': '查看当前支持的模型集合，并回到当前模型设置。',
  '/search': '控制本会话的联网搜索开关，按需临时开启。',
  '/goal': '查看、设置或清除当前 Codex 目标，让长期任务有一个明确的北极星。',
  '/failure': '这次执行没有顺利完成，可以先查看帮助、检查登录，或回到当前会话继续排查。',
  '/review': '发起当前工作区的代码审查，支持按分支或提交审查。',
  '/login': '重新触发登录授权流程，恢复 Codex 执行能力。',
};

const COMMAND_TEMPLATES: Record<string, FeishuCardTemplate> = {
  '/help': 'blue',
  '/session': 'wathet',
  '/sessions': 'wathet',
  '/switch': 'wathet',
  '/rename': 'wathet',
  '/agents': 'green',
  '/agent': 'green',
  '/skills': 'turquoise',
  '/model': 'blue',
  '/provider': 'blue',
  '/models': 'blue',
  '/search': 'wathet',
  '/goal': 'turquoise',
  '/failure': 'orange',
  '/review': 'orange',
  '/login': 'blue',
};

const CARD_COPY = {
  genericTitle: '命令结果',
  actionTitle: '快捷操作',
  actionHint: '点击按钮可继续执行相关命令',
  sessionsTitle: '会话总览',
  agentsTitle: 'Agent 列表',
  helpTitle: '帮助目录',
  helpGroupLabel: '当前分组',
  searchTitle: '当前状态',
  searchAdvice: '建议：默认关闭，按需临时开启。',
  statusTitles: {
    success: '执行成功',
    error: '执行失败',
    warning: '风险提示',
    pending: '执行中',
  },
} as const;

const STATIC_QUICK_ACTIONS: Record<string, CommandQuickAction[]> = {
  '/agents': [
    { label: '查看 Agents', cmd: '/agents', type: 'primary' },
    { label: '当前 Agent', cmd: '/agent' },
    { label: '切换会话', cmd: '/sessions' },
  ],
  '/agent': [
    { label: '查看 Agents', cmd: '/agents', type: 'primary' },
    { label: '当前 Agent', cmd: '/agent' },
    { label: '切换会话', cmd: '/sessions' },
  ],
  '/skills': [
    { label: '生效 Skills', cmd: '/skills', type: 'primary' },
    { label: '全局 Skills', cmd: '/skills global' },
    { label: 'Agent Skills', cmd: '/skills agent' },
  ],
  '/review': [
    { label: '审查当前改动', cmd: '/review', type: 'primary' },
    { label: '按分支审查', cmd: '/review base main' },
    { label: '按提交审查', cmd: '/review commit <SHA>' },
  ],
  '/session': [
    { label: '当前会话', cmd: '/session', type: 'primary' },
    { label: '会话列表', cmd: '/sessions' },
    { label: '切换会话', cmd: '/switch <编号|threadId>' },
  ],
  '/sessions': [
    { label: '当前会话', cmd: '/session', type: 'primary' },
    { label: '会话列表', cmd: '/sessions' },
    { label: '切换会话', cmd: '/switch <编号|threadId>' },
  ],
  '/switch': [
    { label: '当前会话', cmd: '/session', type: 'primary' },
    { label: '会话列表', cmd: '/sessions' },
    { label: '切换会话', cmd: '/switch <编号|threadId>' },
  ],
  '/rename': [
    { label: '当前会话', cmd: '/session', type: 'primary' },
    { label: '会话列表', cmd: '/sessions' },
    { label: '切换会话', cmd: '/switch <编号|threadId>' },
  ],
  '/login': [
    { label: '重新登录', cmd: '/login', type: 'primary' },
    { label: '查看帮助', cmd: '/help' },
  ],
  '/provider': [
    { label: '查看当前', cmd: '/provider', type: 'primary' },
    { label: '使用 Codex', cmd: '/provider codex' },
    { label: '使用 OpenCode', cmd: '/provider opencode' },
  ],
  '/goal': [
    { label: '查看目标', cmd: '/goal', type: 'primary' },
    { label: '清除目标', cmd: '/goal clear', type: 'danger' },
    { label: '查看会话', cmd: '/session' },
  ],
  '/failure': [
    { label: '查看帮助', cmd: '/help', type: 'primary' },
    { label: '登录授权', cmd: '/login' },
    { label: '当前会话', cmd: '/session' },
  ],
};

function buildGatewayStructuredMessage(msgType: string, content: Record<string, unknown> | string): string {
  return JSON.stringify({
    __gateway_message__: true,
    msg_type: msgType,
    content,
  });
}

function buildFeishuInteractiveMessage(card: Record<string, unknown>): string {
  return buildGatewayStructuredMessage('interactive', normalizeFeishuInteractiveCard(card));
}

function normalizeFeishuInteractiveCard(card: Record<string, unknown>): Record<string, unknown> {
  const legacyElements = Array.isArray(card.elements) ? card.elements : undefined;
  const existingBody = asRecord(card.body);
  if (card.schema === '2.0' || existingBody || !legacyElements) {
    return card;
  }
  const normalized: Record<string, unknown> = {
    schema: '2.0',
    body: {
      elements: legacyElements,
    },
  };
  const config = asRecord(card.config);
  const header = asRecord(card.header);
  const cardLink = asRecord(card.card_link);
  if (config) {
    normalized.config = config;
  }
  if (header) {
    normalized.header = header;
  }
  if (cardLink) {
    normalized.card_link = cardLink;
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveCommandLabel(commandName: string): string {
  const normalized = commandName.toLowerCase();
  return COMMAND_LABELS[normalized] ?? CARD_COPY.genericTitle;
}

function resolveCardTemplate(commandName: string, text: string): FeishuCardTemplate {
  const normalized = text.trim();
  if (normalized.startsWith('✅')) {
    return 'green';
  }
  if (normalized.startsWith('❌')) {
    return 'red';
  }
  if (normalized.startsWith('⚠️')) {
    return 'orange';
  }
  if (normalized.startsWith('⏳')) {
    return 'wathet';
  }
  if (normalized.startsWith('可用命令：') || normalized.startsWith('用法：')) {
    return 'blue';
  }
  return COMMAND_TEMPLATES[commandName.toLowerCase()] ?? 'grey';
}

function resolveSearchState(text: string): 'on' | 'off' | 'unknown' {
  const normalized = text.trim();
  if (normalized.includes('联网搜索：on') || normalized.includes('已开启联网搜索')) {
    return 'on';
  }
  if (normalized.includes('联网搜索：off') || normalized.includes('已关闭联网搜索')) {
    return 'off';
  }
  return 'unknown';
}

function resolveHelpPageInfo(text: string): { page: number; total: number } | undefined {
  const match = text.match(/帮助页\s+(\d+)\/(\d+)/);
  if (!match) {
    return undefined;
  }
  const page = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(page) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return {
    page: Math.trunc(page),
    total: Math.trunc(total),
  };
}

function resolveCommandQuickActions(commandName: string, text: string): CommandQuickAction[] {
  const normalized = commandName.toLowerCase();
  if (normalized === '/help') {
    const pageInfo = resolveHelpPageInfo(text);
    const page = pageInfo?.page ?? 1;
    const total = pageInfo?.total ?? 1;
    const prev = Math.max(1, page - 1);
    const next = Math.min(total, page + 1);
    return [
      { label: '上一页', cmd: `/help ${prev}`, type: page > 1 ? 'primary' : 'default' },
      { label: '下一页', cmd: `/help ${next}`, type: page < total ? 'primary' : 'default' },
    ];
  }
  if (text.includes('未识别命令')) {
    return [
      { label: '查看帮助', cmd: '/help', type: 'primary' },
      { label: '当前会话', cmd: '/session' },
      { label: 'Agent 列表', cmd: '/agents' },
    ];
  }
  const staticActions = STATIC_QUICK_ACTIONS[normalized];
  if (staticActions) {
    return staticActions;
  }
  if (normalized === '/search') {
    const state = resolveSearchState(text);
    return [
      { label: '查看状态', cmd: '/search', type: state === 'unknown' ? 'primary' : 'default' },
      { label: '开启', cmd: '/search on', type: state === 'off' ? 'primary' : 'default' },
      { label: '关闭', cmd: '/search off', type: state === 'on' ? 'danger' : 'default' },
    ];
  }
  return [
    { label: '命令帮助', cmd: '/help', type: 'primary' },
  ];
}

function buildFeishuTextBlock(content: string): Record<string, unknown> {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return {
    tag: 'markdown',
    content: escaped,
  };
}

function buildFeishuDivider(): Record<string, unknown> {
  return { tag: 'hr' };
}

function buildFeishuTitleBlock(title: string, summary: string): Record<string, unknown> {
  return buildFeishuTextBlock(`**${title}**\n${summary}`);
}

function buildFeishuStepBlock(step: string, title: string, summary: string): Record<string, unknown> {
  return buildFeishuTextBlock(`**${step}**\n**${title}**\n${summary}`);
}

function buildFeishuSectionBlock(title: string, body: string | string[]): Record<string, unknown> {
  const normalizedBody = Array.isArray(body) ? body.filter(Boolean).join('\n') : body;
  const content = normalizedBody ? `**${title}**\n${normalizedBody}` : `**${title}**`;
  return buildFeishuTextBlock(content);
}

function buildFeishuFieldGrid(fields: FeishuCardField[]): Record<string, unknown> {
  return {
    tag: 'div',
    fields: fields
      .filter((field) => field.value.trim())
      .map((field) => ({
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**${field.label}**\n${field.value}`,
        },
      })),
  };
}

function buildFeishuTipsNote(content: string | string[]): Record<string, unknown> {
  return buildFeishuSectionBlock('建议', content);
}

function buildFeishuLeadNote(content: string): Record<string, unknown> {
  return buildFeishuSectionBlock('当前重点', content);
}

function buildFeishuGuideBlock(title: string, body: string | string[]): Record<string, unknown> {
  return buildFeishuSectionBlock(title, body);
}

function extractIndexedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line) || /^👉\s+\d+\.\s+/.test(line));
}

function extractBulletedLines(text: string, sectionTitle: string): string[] {
  const lines = text.split('\n').map((line) => line.trim());
  const startIndex = lines.findIndex((line) => line === sectionTitle);
  if (startIndex < 0) {
    return [];
  }
  const collected: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line) {
      continue;
    }
    if (line.endsWith('：') && !line.startsWith('- ')) {
      break;
    }
    if (line.startsWith('- ')) {
      collected.push(line.slice(2).trim());
      continue;
    }
    break;
  }
  return collected;
}

function stripListMarker(line: string): string {
  return line.replace(/^👉\s+/, '').replace(/^\d+\.\s+/, '').trim();
}

function stripSelectionMarker(line: string): string {
  return line.replace(/^👉\s+/, '').trim();
}

function extractCurrentModelName(currentLine: string | undefined): string | undefined {
  if (!currentLine) {
    return undefined;
  }
  const normalized = currentLine.replace(/^(当前模型：|✅ 已切换模型为：|✅ 已重置模型：)/, '').trim();
  return normalized || undefined;
}

function prioritizeCurrentModel(models: string[], currentModel: string | undefined): string[] {
  if (!currentModel) {
    return models;
  }
  const selected = models.find((model) => model === currentModel);
  if (!selected) {
    return models;
  }
  return [selected, ...models.filter((model) => model !== selected)];
}

function resolveModelPageInfo(text: string): { page: number; total: number } | undefined {
  const match = text.match(/模型页\s+(\d+)\/(\d+)/);
  if (!match) {
    return undefined;
  }
  const page = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(page) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return {
    page: Math.trunc(page),
    total: Math.trunc(total),
  };
}

function buildSessionsCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const indexed = extractIndexedLines(text);
  const currentSession = indexed.find((line) => line.startsWith('👉'));
  const summary = lines[0] ?? text;
  const sessionButtons = buildSessionButtons(indexed);
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('当前状态', summary),
  ];
  if (indexed.length > 0) {
    elements.push(buildFeishuFieldGrid([
      { label: '会话数量', value: String(indexed.length) },
      { label: '当前会话', value: currentSession ? stripSelectionMarker(currentSession) : '未标记' },
      { label: '可执行操作', value: '切换 / 重命名' },
    ]));
  }
  if (sessionButtons.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('会话切换', '点击按钮切换会话'));
    elements.push(...buildCommandButtonRows(sessionButtons, 1));
  }
  return elements;
}

function buildSessionButtons(lines: string[]): FeishuCardButton[] {
  const buttons: FeishuCardButton[] = [];
  for (const line of lines) {
      const normalized = line.replace(/^👉\s+/, '');
      const match = normalized.match(/^(\d+)\.\s+(.+)$/);
      if (!match) {
        continue;
      }
      const index = match[1];
      const body = match[2] ?? '';
      const title = body.split(' (')[0]?.trim() ?? body.trim();
      const preview = body.match(/\)\s*-\s*(.+)$/)?.[1]?.trim() ?? '';
      const labelText = preview ? `${index}. ${title} · ${preview}` : `${index}. ${title}`;
      const label = truncateCardButtonLabel(labelText || `会话 ${index}`, 26);
      buttons.push({
        label,
        cmd: `/switch ${index}`,
        type: line.startsWith('👉') ? 'primary' : 'default',
      });
  }
  return buttons;
}

function truncateCardButtonLabel(input: string, max = 22): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function buildAgentsCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const indexed = compactAgentEntries(lines);
  const currentAgent = indexed.find((line) => line.startsWith('👉'));
  const summary = lines[0] ?? text;
  const workspaceLines = lines.filter((line) => line.startsWith('/'));
  const agentButtons = buildAgentButtons(lines);
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('当前状态', summary),
  ];
  if (indexed.length > 0) {
    elements.push(buildFeishuFieldGrid([
      { label: 'Agent 数量', value: String(indexed.length) },
      { label: '当前 Agent', value: currentAgent ? stripListMarker(currentAgent) : '未标记' },
      { label: '切换', value: '/agent use' },
    ]));
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('Agent 切换', '点击按钮切换 Agent'));
    elements.push(...buildCommandButtonRows(agentButtons, 1));
  } else if (workspaceLines.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('工作区', workspaceLines));
  }
  return elements;
}

function buildSkillsCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const indexed = extractIndexedLines(text);
  const summary = lines[0] ?? text;
  const scopeMatch = summary.match(/范围：([^，)]+).*agent：(.+)）$/);
  const scope = scopeMatch?.[1]?.trim() ?? '';
  const agent = scopeMatch?.[2]?.trim() ?? '';
  const titleSummary = [scope || 'effective', agent].filter(Boolean).join(' · ');
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('生效技能', titleSummary || summary),
  ];
  if (scope || agent || indexed.length > 0) {
    elements.push(buildFeishuFieldGrid([
      { label: '范围', value: scope || 'effective' },
      { label: 'Agent', value: agent },
      { label: '数量', value: indexed.length > 0 ? String(indexed.length) : '' },
    ]));
  }
  if (indexed.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('技能', compactSkillEntries(indexed)));
  } else if (lines.length > 1) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('详情', lines.slice(1)));
  }
  return elements;
}

function compactAgentEntries(lines: string[]): string[] {
  const results: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\d+\.\s+|^👉\s+\d+\.\s+/.test(line)) {
      continue;
    }
    const workspace = lines[i + 1]?.startsWith('/') ? lines[i + 1] : '';
    results.push(workspace ? `${line} · ${workspace}` : line);
  }
  return results;
}

function compactSkillEntries(lines: string[]): string[] {
  return lines.map((line) => {
    const normalized = stripListMarker(line);
    return normalized.split(' - ')[0]?.trim() ?? normalized;
  });
}

function buildAgentButtons(lines: string[]): FeishuCardButton[] {
  const buttons: FeishuCardButton[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\d+\.\s+|^👉\s+\d+\.\s+/.test(line)) {
      continue;
    }
    const normalized = line.replace(/^👉\s+/, '');
    const match = normalized.match(/^(\d+)\.\s+(.+)$/);
    if (!match) {
      continue;
    }
    const index = match[1];
    const body = match[2] ?? '';
    const title = body.split(' (')[0]?.trim() ?? body.trim();
    const workspace = lines[i + 1]?.startsWith('/') ? lines[i + 1].split('/').filter(Boolean).pop() ?? '' : '';
    const labelText = workspace ? `${title} · ${workspace}` : title;
    buttons.push({
      label: truncateCardButtonLabel(labelText || `Agent ${index}`, 26),
      cmd: `/agent use ${index}`,
      type: line.startsWith('👉') ? 'primary' : 'default',
    });
  }
  return buttons;
}

function buildAgentCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const elements: Array<Record<string, unknown>> = [];
  const agentLine = lines.find((line) => line.startsWith('当前 agent：') || line.startsWith('✅ 已切换到 agent：') || line.startsWith('✅ 已创建并切换到 agent：'));
  const workspaceLine = lines.find((line) => line.startsWith('工作区：'));
  const sessionLine = lines.find((line) => line.startsWith('当前会话：'));
  if (agentLine) {
    elements.push(buildFeishuGuideBlock('当前状态', agentLine));
  }
  if (workspaceLine || sessionLine) {
    elements.push(buildFeishuFieldGrid([
      { label: '工作区', value: workspaceLine?.replace(/^工作区：/, '').trim() ?? '' },
      { label: '当前会话', value: sessionLine?.replace(/^当前会话：/, '').trim() ?? '' },
    ]));
    elements.push(buildFeishuDivider());
    elements.push(...buildCommandButtonRows([
      { label: 'Agent 列表', cmd: '/agents', type: 'primary' },
      { label: '当前会话', cmd: '/sessions' },
    ]));
  }
  if (elements.length === 0) {
    elements.push(buildFeishuTitleBlock('Agent', text));
  }
  return elements;
}

function buildModelCardElements(text: string): Array<Record<string, unknown>> {
  const maxVisibleModelButtons = 9;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const elements: Array<Record<string, unknown>> = [];
  const visibleModels = extractBulletedLines(text, '可见模型：');
  const hiddenModels = extractBulletedLines(text, '隐藏/兼容模型：');
  const currentLine = lines.find((line) => line.startsWith('当前模型：') || line.startsWith('✅ 已切换模型为：') || line.startsWith('✅ 已重置模型：'));
  const currentModel = extractCurrentModelName(currentLine);
  const prioritizedVisibleModels = prioritizeCurrentModel(visibleModels, currentModel);
  const visibleModelButtons = prioritizedVisibleModels.slice(0, maxVisibleModelButtons);
  const pageInfo = resolveModelPageInfo(text);
  const hasMoreVisibleModels = (pageInfo?.page ?? 1) < (pageInfo?.total ?? 1)
    || prioritizedVisibleModels.length > visibleModelButtons.length;
  if (currentLine) {
    elements.push(buildFeishuGuideBlock('当前状态', currentLine));
    elements.push(buildFeishuFieldGrid([
      { label: '模型状态', value: currentModel ?? '' },
      { label: '可见模型数', value: visibleModels.length > 0 ? String(visibleModels.length) : '' },
      { label: '隐藏模型数', value: hiddenModels.length > 0 ? String(hiddenModels.length) : '' },
      { label: '页码', value: pageInfo ? `${pageInfo.page}/${pageInfo.total}` : '' },
    ]));
  }
  const warnings = lines.filter((line) => line.startsWith('⚠️'));
  if (warnings.length > 0) {
    if (elements.length > 0) {
      elements.push(buildFeishuDivider());
    }
    elements.push(buildFeishuSectionBlock('提示', warnings));
  }
  if (visibleModelButtons.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('可选模型', `点击即可切换，共显示 ${visibleModelButtons.length} 个`));
    elements.push(...buildCommandButtonRows(
      visibleModelButtons.map((model) => ({
        label: model === currentModel ? `当前 · ${model}` : model,
        cmd: model === currentModel ? '/model' : `/model ${model}`,
        type: model === currentModel ? 'primary' : 'default',
      })),
      3,
    ));
    if (hasMoreVisibleModels) {
      elements.push(buildFeishuTipsNote('还有更多可见模型，点击下方按钮继续查看。'));
      elements.push(...buildCommandButtonRows([
        { label: '更多模型', cmd: `/model page ${Math.min(pageInfo?.total ?? 2, (pageInfo?.page ?? 1) + 1)}`, type: 'primary' },
      ]));
    }
  }
  if (pageInfo && pageInfo.total > 1) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('模型翻页', `当前第 ${pageInfo.page} / ${pageInfo.total} 页`));
    elements.push(...buildCommandButtonRows([
      { label: '上一页', cmd: `/model page ${Math.max(1, pageInfo.page - 1)}`, type: pageInfo.page > 1 ? 'primary' : 'default' },
      { label: '下一页', cmd: `/model page ${Math.min(pageInfo.total, pageInfo.page + 1)}`, type: pageInfo.page < pageInfo.total ? 'primary' : 'default' },
    ]));
  }
  if (hiddenModels.length > 0) {
    elements.push(buildFeishuTipsNote(`还有 ${hiddenModels.length} 个隐藏/兼容模型，已默认收起。`));
  }
  if (currentModel) {
    elements.push(buildFeishuDivider());
    elements.push(...buildCommandButtonRows([
      { label: '重置模型', cmd: '/model reset', type: 'default' },
    ]));
  }
  if (elements.length === 0) {
    elements.push(buildFeishuGuideBlock('当前状态', text));
  }
  return elements;
}

function buildSearchCardElements(text: string): Array<Record<string, unknown>> {
  const state = resolveSearchState(text);
  const stateLine = state === 'on'
    ? '🟢 已开启'
    : state === 'off'
    ? '⚪ 已关闭'
    : '🟡 状态未知';
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('当前状态', stateLine),
  ];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  elements.push(buildFeishuFieldGrid([
    { label: '联网搜索', value: stateLine },
    { label: '推荐策略', value: state === 'on' ? '当前临时开启' : '默认关闭，按需开启' },
  ]));
  if (lines.some((line) => line.startsWith('⚠️'))) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('提示', lines.filter((line) => line.startsWith('⚠️'))));
  }
  return elements;
}

function buildGoalCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const objectiveLine = lines.find((line) => line.includes('目标：')) ?? lines[0] ?? text;
  const objective = objectiveLine
    .replace(/^[✅❌⚠️⏳]\s*/, '')
    .replace(/^(已设置目标：|当前目标：)/, '')
    .trim();
  const statusLine = lines.find((line) => line.startsWith('状态：'));
  const tokenBudgetLine = lines.find((line) => line.startsWith('Token 预算：'));
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('当前目标', objective || text),
  ];
  if (statusLine || tokenBudgetLine) {
    elements.push(buildFeishuFieldGrid([
      { label: '状态', value: statusLine?.replace(/^状态：/, '').trim() ?? '' },
      { label: 'Token 预算', value: tokenBudgetLine?.replace(/^Token 预算：/, '').trim() ?? '' },
    ]));
  }
  const details = lines.filter((line) => line !== objectiveLine && line !== statusLine && line !== tokenBudgetLine);
  if (details.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('详情', details));
  }
  return elements;
}

function buildHelpCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const pageInfo = resolveHelpPageInfo(text);
  const groupNames = lines
    .filter((line) => line.startsWith('【') && line.endsWith('】'))
    .map((line) => line.replace(/^【/, '').replace(/】$/, ''));
  const primaryGroupName = groupNames[0] ?? '';
  const summary = groupNames.length === 1 && pageInfo
    ? `${primaryGroupName} · ${pageInfo.page}/${pageInfo.total}`
    : pageInfo
    ? `帮助页 ${pageInfo.page}/${pageInfo.total}`
    : primaryGroupName || '可用命令';
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('当前重点', summary),
  ];
  elements.push(buildFeishuFieldGrid([
    { label: CARD_COPY.helpGroupLabel, value: groupNames.join(' / ') },
    { label: '页码', value: pageInfo ? `${pageInfo.page}/${pageInfo.total}` : '' },
    { label: '命令数', value: '' },
  ]));
  elements.push(buildFeishuDivider());
  const shortcutButtons = resolveHelpShortcutButtons(primaryGroupName);
  if (shortcutButtons.length > 0) {
    elements.push(...buildCommandButtonRows(shortcutButtons, 3));
  }
  if (elements[elements.length - 1]?.tag === 'hr') {
    elements.pop();
  }
  return elements;
}

function resolveHelpShortcutButtons(groupName: string): FeishuCardButton[] {
  if (groupName === '会话与 Agent') {
    return [
      { label: '框架管理', cmd: '/provider', type: 'primary' },
      { label: '新建会话', cmd: '/new' },
      { label: '会话列表', cmd: '/sessions' },
      { label: 'Agent 列表', cmd: '/agents' },
    ];
  }
  if (groupName === '模型、技能与执行') {
    return [
      { label: '模型管理', cmd: '/model', type: 'primary' },
      { label: '生效 Skills', cmd: '/skills' },
      { label: '目标管理', cmd: '/goal' },
      { label: '搜索状态', cmd: '/search' },
    ];
  }
  return [
    { label: '查看帮助', cmd: '/help', type: 'primary' },
  ];
}

function buildCommandButtonRows(buttons: FeishuCardButton[], buttonsPerRow = 2): Array<Record<string, unknown>> {
  return buildValueButtonRows(buttons.map((item) => ({
    label: item.label,
    type: item.type,
    value: {
      gateway_cmd: item.cmd,
      command: item.cmd,
      text: item.cmd,
    },
  })), buttonsPerRow);
}

function buildFeishuButtonElement(button: FeishuValueButton): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tag: 'button',
    type: button.type ?? 'default',
    text: {
      tag: 'plain_text',
      content: button.label,
    },
  };
  if (button.value) {
    element.value = button.value;
  }
  if (button.multiUrl) {
    element.multi_url = {
      url: button.multiUrl,
    };
  }
  return element;
}

function buildValueButtonRows(buttons: FeishuValueButton[], buttonsPerRow = 2): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const step = Math.max(1, buttonsPerRow);
  for (let i = 0; i < buttons.length; i += step) {
    const chunk = buttons.slice(i, i + step);
    rows.push({
      tag: 'column_set',
      flex_mode: 'flow',
      columns: chunk.map((item) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: [buildFeishuButtonElement(item)],
      })),
    });
  }
  return rows;
}

function buildStatusCardElements(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? text;
  const icon = firstLine[0] ?? '';
  const title = icon === '✅'
    ? CARD_COPY.statusTitles.success
    : icon === '❌'
    ? CARD_COPY.statusTitles.error
    : icon === '⚠'
    ? CARD_COPY.statusTitles.warning
    : icon === '⏳'
    ? CARD_COPY.statusTitles.pending
    : CARD_COPY.genericTitle;
  const summary = firstLine.replace(/^[✅❌⚠️⏳]\s*/, '').trim() || firstLine;
  const details = lines.slice(1);
  const elements: Array<Record<string, unknown>> = [
    buildFeishuGuideBlock('结论', title),
    buildFeishuLeadNote(summary),
    buildFeishuFieldGrid([
      { label: '状态', value: firstLine },
      { label: '类型', value: title },
    ]),
  ];
  if (details.length > 0) {
    elements.push(buildFeishuDivider(), buildFeishuSectionBlock('详情', details));
  }
  return elements;
}

function buildFeishuActionSection(actions: CommandQuickAction[]): Array<Record<string, unknown>> {
  if (actions.length === 0) {
    return [];
  }
  return [
    buildFeishuDivider(),
    buildFeishuSectionBlock('下一步', CARD_COPY.actionHint),
    ...buildCommandButtonRows(actions.map((item) => ({
      label: item.label,
      cmd: item.cmd,
      type: item.type,
    })), 3),
  ];
}

function buildGenericCardElements(text: string): Array<Record<string, unknown>> {
  if (/^[✅❌⚠️⏳]/.test(text.trim())) {
    return buildStatusCardElements(text);
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const summary = lines[0] ?? text;
  if (lines.length <= 1) {
    return [buildFeishuGuideBlock('当前重点', summary)];
  }
  return [
    buildFeishuGuideBlock('当前重点', summary),
    buildFeishuDivider(),
    buildFeishuSectionBlock('详情', lines.slice(1)),
  ];
}

function isModelRichText(text: string): boolean {
  return text.includes('当前模型：')
    || text.includes('✅ 已切换模型为：')
    || text.includes('✅ 已重置模型：')
    || text.includes('可见模型：')
    || text.includes('隐藏/兼容模型：');
}

const COMMAND_CARD_RENDERERS: Record<string, CardElementBuilder> = {
  '/session': buildSessionsCardElements,
  '/sessions': buildSessionsCardElements,
  '/switch': buildSessionsCardElements,
  '/rename': buildSessionsCardElements,
  '/agents': buildAgentsCardElements,
  '/skills': buildSkillsCardElements,
  '/agent': buildAgentCardElements,
  '/model': buildModelCardElements,
  '/models': buildModelCardElements,
  '/search': buildSearchCardElements,
  '/goal': buildGoalCardElements,
  '/help': buildHelpCardElements,
};

function resolveCommandCardElements(commandName: string, text: string): Array<Record<string, unknown>> {
  const normalized = commandName.toLowerCase();
  if ((normalized === '/model' || normalized === '/models') && isModelRichText(text)) {
    return buildModelCardElements(text);
  }
  if (normalized === '/goal') {
    return buildGoalCardElements(text);
  }
  if (/^[✅❌⚠️⏳]/.test(text.trim())) {
    return buildStatusCardElements(text);
  }
  const renderer = COMMAND_CARD_RENDERERS[normalized];
  if (renderer) {
    return renderer(text);
  }
  return buildGenericCardElements(text);
}

function buildFeishuInteractiveCommandCard(commandName: string, text: string): Record<string, unknown> {
  const title = resolveCommandLabel(commandName);
  const normalized = commandName.toLowerCase();
  const actions = resolveCommandQuickActions(commandName, text);
  const elements = resolveCommandCardElements(commandName, text);
  const summary = COMMAND_SUMMARIES[normalized];
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: resolveCardTemplate(commandName, text),
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      ...(summary ? [buildFeishuLeadNote(summary)] : []),
      ...elements,
      ...buildFeishuActionSection(actions),
    ],
  };
}

export function formatCommandOutboundMessage(channel: Channel, commandName: string, text: string): string {
  if (channel !== 'feishu') {
    return text;
  }
  const normalized = text.trim();
  if (!normalized) {
    return text;
  }
  return buildFeishuInteractiveMessage(buildFeishuInteractiveCommandCard(commandName, normalized));
}

export function buildFeishuRunCardMessage(input: {
  runId: string;
  agentName: string;
  provider: CliProvider;
  status: RunStatus;
  startedAt: number;
  lastActivityAt: number;
  threadId?: string;
}): string {
  const statusMap: Record<RunStatus, { title: string; template: FeishuCardTemplate; summary: string }> = {
    running: { title: '处理中', template: 'turquoise', summary: '正在为你处理当前请求' },
    stopping: { title: '正在停止', template: 'yellow', summary: '正在结束当前任务' },
    stopped: { title: '已停止', template: 'grey', summary: '当前任务已停止' },
    stop_failed: { title: '停止未完成', template: 'orange', summary: '停止请求未成功完成' },
    completed: { title: '已完成', template: 'green', summary: '当前任务已处理完成' },
  };
  const statusMeta = statusMap[input.status];
  const nextStep = input.status === 'running'
    ? '如需中断本次执行，点击下方“停止本次任务”。'
    : input.status === 'stopping'
    ? '稍等片刻，状态卡会继续更新。'
    : '当前阶段已经结束，如需继续可直接发送下一条消息。';
  const elements: Array<Record<string, unknown>> = [
    buildFeishuLeadNote(statusMeta.summary),
    buildFeishuGuideBlock('当前阶段', statusMeta.title),
    buildFeishuGuideBlock('下一步', nextStep),
  ];
  if (input.status === 'running') {
    elements.push(buildFeishuDivider());
    elements.push(
      ...buildValueButtonRows([
        {
          label: '停止本次任务',
          type: 'danger',
          value: {
            gateway_cmd: `/run stop ${input.runId}`,
            command: `/run stop ${input.runId}`,
            text: `/run stop ${input.runId}`,
            run_id: input.runId,
          },
        },
      ], 1),
    );
  }
  if (input.status === 'completed' || input.status === 'stopped' || input.status === 'stop_failed') {
    elements.push(buildFeishuDivider(), buildFeishuGuideBlock('继续操作', '你可以查看当前会话状态，或继续管理本轮目标。'));
    elements.push(...buildCommandButtonRows([
      { label: '查看会话', cmd: '/session', type: 'primary' },
      { label: '查看目标', cmd: '/goal' },
      { label: '新建会话', cmd: '/new' },
    ], 3));
  }
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    header: {
      template: statusMeta.template,
      title: {
        tag: 'plain_text',
        content: statusMeta.title,
      },
    },
    elements,
  });
}

export function buildFeishuLoginChoiceMessage(input: {
  provider?: CliProvider;
  providerLabel?: string;
  supportsDeviceAuth?: boolean;
  authState?: {
    hasConfig?: boolean;
    hasAuth?: boolean;
    model?: string;
  };
} = {}): string {
  const provider = input.provider ?? 'codex';
  if (provider === 'opencode') {
    return buildFeishuOpenCodeLoginChoiceMessage();
  }
  const providerLabel = input.providerLabel ?? 'Codex';
  const supportsDeviceAuth = input.supportsDeviceAuth ?? true;
  const writeLocation = 'config.toml';
  const authLocation = 'auth.json';
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '登录授权',
      },
    },
    elements: [
      buildFeishuStepBlock(
        '步骤 1',
        '选择登录方式',
        supportsDeviceAuth
          ? `飞书下可以使用设备授权，或直接写入项目内的 ${providerLabel} API 配置。`
          : `当前模型通道是 ${providerLabel}，请直接写入项目内 API 配置。`,
      ),
      buildFeishuFieldGrid([
        { label: '当前通道', value: providerLabel },
        { label: '写入位置', value: writeLocation },
        { label: '认证文件', value: authLocation },
        { label: '配置状态', value: formatLoginConfigState(input.authState?.hasConfig) },
        { label: '授权状态', value: formatLoginAuthState(input.authState?.hasAuth) },
        { label: '当前模型', value: input.authState?.model?.trim() || '未读取' },
      ]),
      buildFeishuTipsNote([
        `API Key 不会通过普通聊天文本转发给 ${providerLabel}。`,
        supportsDeviceAuth ? '优先推荐设备授权；需要固定 API 配置时再使用表单登录。' : '当前渠道不支持设备授权，请直接填写 API URL / Key。',
      ]),
      buildFeishuDivider(),
      buildFeishuGuideBlock('下一步', '点击一种登录方式继续。'),
      ...buildValueButtonRows([
        {
          label: 'API URL / Key 登录',
          type: supportsDeviceAuth ? 'default' : 'primary',
          value: {
            gateway_action: 'codex_login.open_api_form',
          },
        },
        ...(supportsDeviceAuth
          ? [{
              label: '设备授权登录',
              type: 'primary' as const,
              value: {
                gateway_action: 'codex_login.start_device_auth',
              },
            }]
          : []),
      ], 2),
    ],
  });
}

export function buildFeishuDeviceAuthProgressMessage(input: {
  providerLabel?: string;
  text: string;
}): string {
  const providerLabel = input.providerLabel?.trim() || 'Codex';
  const text = input.text.trim();
  const authUrl = extractFirstUrl(text);
  const deviceCode = extractDeviceAuthCode(text, authUrl);
  const jumpUrl = buildDeviceAuthJumpUrl(authUrl, deviceCode);
  const fields: FeishuCardField[] = [
    { label: '登录通道', value: providerLabel },
    { label: '授权码', value: deviceCode ? `\`${deviceCode}\`` : '等待 CLI 输出授权码' },
    { label: '授权链接', value: jumpUrl ? `[点击打开授权页面](${jumpUrl})` : '等待 CLI 输出授权链接' },
  ];
  const actions: FeishuValueButton[] = [
    ...(jumpUrl
      ? [{
          label: '打开授权链接',
          type: 'primary' as const,
          multiUrl: jumpUrl,
        }]
      : []),
    {
      label: '重新选择登录',
      value: {
        gateway_cmd: '/login',
        command: '/login',
        text: '/login',
      },
    },
  ];

  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: false,
    },
    header: {
      template: authUrl ? 'blue' : 'wathet',
      title: {
        tag: 'plain_text',
        content: '设备授权登录',
      },
    },
    elements: [
      buildFeishuStepBlock(
        '步骤 2',
        '打开授权页面完成登录',
        jumpUrl
          ? '点击卡片中的授权链接或下方按钮打开授权页面；授权码已放在跳转链接里，也可从卡片中复制。'
          : '正在等待 CLI 返回授权链接，请稍候。',
      ),
      buildFeishuFieldGrid(fields),
      buildFeishuDivider(),
      ...buildValueButtonRows(actions, actions.length > 1 ? 2 : 1),
    ],
  });
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"')）\]]+/i);
  return match?.[0]?.replace(/[.,;，。；:：]+$/, '');
}

function extractDeviceAuthCode(text: string, authUrl: string | undefined): string | undefined {
  if (authUrl) {
    try {
      const parsedUrl = new URL(authUrl);
      for (const key of ['user_code', 'userCode', 'code']) {
        const value = parsedUrl.searchParams.get(key)?.trim();
        if (value) {
          return value;
        }
      }
    } catch {
      // Non-standard URLs still fall through to text parsing.
    }
  }

  const separatedCodeMatch = text.match(/([A-Z0-9]{4,}(?:[- ][A-Z0-9]{3,}?))(?=Device codes|device codes|[^A-Za-z0-9]|$)/);
  if (separatedCodeMatch?.[1]) {
    return separatedCodeMatch[1].replace(/\s+/g, '-');
  }

  const lowerText = text.toLowerCase();
  const cueIndex = lowerText.search(/one-time code|enter(?: this)?(?: one-time)? code|授权码|验证码/);
  if (cueIndex >= 0) {
    const codeMatch = text.slice(cueIndex).match(/[A-Z0-9]{6,}/);
    return codeMatch?.[0];
  }
  return undefined;
}

function buildDeviceAuthJumpUrl(authUrl: string | undefined, deviceCode: string | undefined): string | undefined {
  if (!authUrl) {
    return undefined;
  }
  const normalizedCode = deviceCode?.trim();
  if (!normalizedCode) {
    return authUrl;
  }
  try {
    const parsedUrl = new URL(authUrl);
    if (!parsedUrl.searchParams.has('user_code') && !parsedUrl.searchParams.has('code')) {
      parsedUrl.searchParams.set('user_code', normalizedCode);
    }
    return parsedUrl.toString();
  } catch {
    const separator = authUrl.includes('?') ? '&' : '?';
    return `${authUrl}${separator}user_code=${encodeURIComponent(normalizedCode)}`;
  }
}

function formatLoginConfigState(value: boolean | undefined): string {
  if (value === true) {
    return '已写入';
  }
  if (value === false) {
    return '未发现';
  }
  return '未知';
}

function formatLoginAuthState(value: boolean | undefined): string {
  if (value === true) {
    return '已发现';
  }
  if (value === false) {
    return '未发现';
  }
  return '未知';
}

export function buildFeishuOpenCodeLoginChoiceMessage(): string {
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: 'OpenCode 登录授权',
      },
    },
    elements: [
      buildFeishuStepBlock('步骤 1', '使用 API URL / Key 登录 OpenCode', '飞书内暂不提供 OpenCode 的浏览器授权登录，请直接写入 API 配置。'),
      buildFeishuFieldGrid([
        { label: '写入位置', value: '.config/opencode/opencode.json' },
        { label: '认证文件', value: '.local/share/opencode/auth.json' },
      ]),
      buildFeishuTipsNote('推荐填写 OpenAI 兼容 API：base_url + api_key + model。'),
      buildFeishuDivider(),
      buildFeishuGuideBlock('下一步', '点击下方按钮进入配置表单。'),
      ...buildValueButtonRows([
        {
          label: 'API URL / Key 登录',
          type: 'primary',
          value: {
            gateway_action: 'codex_login.open_api_form',
          },
        },
      ], 1),
    ],
  });
}

export function buildFeishuOpenCodeOauthMessage(input: {
  provider: string;
  url: string;
}): string {
  const providerLabel = toProviderLabel(input.provider);
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: 'OpenCode 登录授权',
      },
    },
    elements: [
      buildFeishuStepBlock(
        '步骤 3',
        `${providerLabel} 授权已就绪`,
        '点击下面的按钮在浏览器中完成授权，网关会继续自动推进后续确认步骤。',
      ),
      buildFeishuFieldGrid([
        { label: '登录渠道', value: providerLabel },
        { label: '授权链接', value: input.url },
      ]),
      buildFeishuGuideBlock('下一步', '打开浏览器完成授权，完成后返回飞书等待状态刷新。'),
      buildFeishuDivider(),
      ...buildValueButtonRows([
        {
          label: '打开授权链接',
          type: 'primary',
          multiUrl: input.url,
        },
      ], 1),
    ],
  });
}

export function buildFeishuOpenCodeInputFallbackMessage(input: {
  provider: string;
  prompt: string;
}): string {
  const providerLabel = toProviderLabel(input.provider);
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: false,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: 'OpenCode 登录补充输入',
      },
    },
    elements: [
      buildFeishuStepBlock(
        '步骤 4',
        '补充授权信息',
        input.prompt.trim(),
      ),
      buildFeishuGuideBlock('填写说明', '仅在授权流程明确要求补充输入时填写。'),
      {
        tag: 'form',
        name: 'opencode_oauth_input',
        elements: [
          {
            tag: 'input',
            name: 'auth_input',
            label_position: 'top',
            label: {
              tag: 'plain_text',
              content: '输入内容',
            },
            placeholder: {
              tag: 'plain_text',
              content: '仅在确实需要时填写',
            },
            max_length: 500,
          },
          {
            tag: 'button',
            name: 'submit_opencode_auth_input',
            type: 'primary',
            action_type: 'form_submit',
            text: {
              tag: 'plain_text',
              content: '继续登录',
            },
            value: {
              gateway_action: 'opencode_login.submit_auth_input',
              provider_id: input.provider,
            },
          },
        ],
      },
    ],
  });
}

export function buildFeishuApiLoginFormMessage(defaults?: {
  provider?: CliProvider;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
}): string {
  const provider = defaults?.provider ?? 'codex';
  const providerLabel = provider === 'opencode' ? 'OpenCode' : 'Codex';
  const baseUrl = defaults?.baseUrl?.trim() || (provider === 'opencode' ? 'https://api.openai.com/v1' : 'https://codex.ai02.cn');
  const model = defaults?.model?.trim() || (provider === 'opencode' ? 'gpt-5' : 'gpt-5.3-codex');
  const reasoningEffort = defaults?.reasoningEffort?.trim() || '';
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: false,
    },
    header: {
      template: 'wathet',
      title: {
        tag: 'plain_text',
        content: 'API URL / Key 登录',
      },
    },
    elements: [
      buildFeishuStepBlock('步骤 2', '填写 API 配置', `提交后会覆盖当前项目内的 ${providerLabel} 登录配置。`),
      buildFeishuGuideBlock('填写说明', `建议填写：base_url=${baseUrl}，model=${model}`),
      ...(provider === 'opencode'
        ? [buildFeishuTipsNote('可选：reasoning effort 支持 none / minimal / low / medium / high / xhigh。')]
        : []),
      {
        tag: 'form',
        name: 'codex_api_login',
        elements: [
          {
            tag: 'input',
            name: 'base_url',
            default_value: baseUrl,
            label_position: 'top',
            label: {
              tag: 'plain_text',
              content: 'API URL',
            },
            placeholder: {
              tag: 'plain_text',
              content: baseUrl,
            },
            max_length: 500,
          },
          {
            tag: 'input',
            name: 'api_key',
            label_position: 'top',
            label: {
              tag: 'plain_text',
              content: 'API Key',
            },
            placeholder: {
              tag: 'plain_text',
              content: 'sk-...',
            },
            max_length: 500,
          },
          {
            tag: 'input',
            name: 'model',
            default_value: model,
            label_position: 'top',
            label: {
              tag: 'plain_text',
              content: 'Model',
            },
            placeholder: {
              tag: 'plain_text',
              content: model,
            },
            max_length: 120,
          },
          ...(provider === 'opencode'
            ? [{
                tag: 'input',
                name: 'reasoning_effort',
                default_value: reasoningEffort,
                label_position: 'top',
                label: {
                  tag: 'plain_text',
                  content: 'Reasoning Effort',
                },
                placeholder: {
                  tag: 'plain_text',
                  content: 'none | minimal | low | medium | high | xhigh',
                },
                max_length: 20,
              } satisfies Record<string, unknown>]
            : []),
          {
            tag: 'button',
            name: 'submit_api_login',
            type: 'primary',
            action_type: 'form_submit',
            text: {
              tag: 'plain_text',
              content: '保存并启用',
            },
            value: {
              gateway_action: 'codex_login.submit_api_credentials',
            },
          },
        ],
      },
    ],
  });
}

function toProviderLabel(provider: string): string {
  if (provider === 'openai') {
    return 'OpenAI';
  }
  if (provider === 'xai') {
    return 'xAI';
  }
  return provider.slice(0, 1).toUpperCase() + provider.slice(1);
}

export function buildFeishuApiLoginResultMessage(input: {
  provider?: CliProvider;
  ok: boolean;
  baseUrl?: string;
  model?: string;
  maskedApiKey?: string;
  reasoningEffort?: string;
  message: string;
}): string {
  const providerLabel = input.provider === 'opencode' ? 'OpenCode' : 'Codex';
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: input.ok ? 'green' : 'red',
      title: {
        tag: 'plain_text',
        content: '登录授权',
      },
    },
    elements: [
      buildFeishuGuideBlock('结论', input.ok ? `${providerLabel} 配置写入成功` : `${providerLabel} 配置写入失败`),
      buildFeishuLeadNote(input.message),
      buildFeishuFieldGrid([
        { label: 'API URL', value: input.baseUrl ?? '' },
        { label: 'Model', value: input.model ?? '' },
        { label: 'Reasoning', value: input.reasoningEffort ?? '' },
        { label: 'API Key', value: input.maskedApiKey ?? (input.ok ? '已配置' : '') },
      ]),
      buildFeishuDivider(),
      buildFeishuGuideBlock('下一步', input.ok ? '如需切换账号或刷新凭据，可重新进入登录流程。' : '修正配置后返回表单重试。'),
      ...buildValueButtonRows(input.ok
        ? [
            {
              label: '重新登录',
              type: 'primary',
              value: {
                gateway_cmd: '/login',
                command: '/login',
                text: '/login',
              },
            },
          ]
        : [
            {
              label: '返回表单',
              type: 'primary',
              value: {
                gateway_action: 'codex_login.open_api_form',
                base_url: input.baseUrl ?? '',
                model: input.model ?? '',
                reasoning_effort: input.reasoningEffort ?? '',
              },
            },
            {
              label: '重新选择登录',
              value: {
                gateway_cmd: '/login',
                command: '/login',
                text: '/login',
              },
            },
          ]),
    ],
  });
}

export function buildFeishuUserAuthMessage(input: {
  gatewayUserId: string;
  reason?: string;
  authStartUrl?: string;
  authStatusUrl?: string;
}): string {
  const gatewayUserId = input.gatewayUserId.trim();
  const authStartUrl = input.authStartUrl?.trim() || `/feishu/oauth/start?gateway_user_id=${gatewayUserId}`;
  const authStatusUrl = input.authStatusUrl?.trim() || `/feishu/auth/status?gateway_user_id=${gatewayUserId}`;
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '飞书个人授权',
      },
    },
    elements: [
      buildFeishuStepBlock(
        '步骤 1',
        '授权个人任务与个人日历',
        input.reason?.trim() || '完成一次飞书 OAuth 绑定后，agent 才能创建到你本人的任务和主日历事件。',
      ),
      buildFeishuFieldGrid([
        { label: '授权入口', value: authStartUrl },
        { label: '状态检查', value: authStatusUrl },
      ]),
      buildFeishuTipsNote('这是飞书个人身份授权，不是 Codex CLI 的 /login。'),
      buildFeishuDivider(),
      buildFeishuGuideBlock('下一步', '先点击“去飞书授权”，完成后再用“查看授权状态”确认是否生效。'),
      ...buildValueButtonRows([
        {
          label: '去飞书授权',
          type: 'primary',
          multiUrl: authStartUrl,
        },
        {
          label: '查看授权状态',
          multiUrl: authStatusUrl,
        },
      ]),
    ],
  });
}

export function buildFeishuPersonalAuthUnavailableMessage(input?: {
  reason?: string;
}): string {
  return buildFeishuInteractiveMessage({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: '飞书个人权限连接',
      },
    },
    elements: [
      buildFeishuGuideBlock(
        '当前状态',
        '当前环境未启用个人权限连接',
      ),
      buildFeishuLeadNote(
        input?.reason?.trim() || '当前环境还不能直接连接你的个人飞书权限，因此我暂时无法创建你的个人任务或个人日历事件。',
      ),
      buildFeishuFieldGrid([
        { label: '当前状态', value: '基础飞书机器人能力可用，个人任务/个人日历未启用' },
        { label: '下一步', value: '请让管理员为当前服务启用飞书个人权限连接后，再重试该请求' },
      ]),
      buildFeishuTipsNote('这不是 /login 问题，而是当前环境尚未启用“以你的身份访问飞书个人能力”。'),
      buildFeishuGuideBlock('下一步', '联系管理员启用该能力后再重试；若只是确认现状，可直接关闭这张卡片。'),
    ],
  });
}
