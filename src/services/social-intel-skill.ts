import fs from 'node:fs';
import path from 'node:path';
import { upsertManagedSection } from './agents-managed-sections.js';

const SOCIAL_RULE_START = '<!-- gateway:social-intel:start -->';
const SOCIAL_RULE_END = '<!-- gateway:social-intel:end -->';

const SKILLS = [
  'social-intel',
  'social-doc-writer',
  'x-research',
  'xiaohongshu-research',
  'douyin-research',
  'bilibili-research',
  'wechat-article-research',
] as const;

type SocialSkillName = typeof SKILLS[number];

export function installSocialIntelSkills(workspaceDir: string): void {
  const skillRootDir = path.join(workspaceDir, '.codex', 'skills');
  for (const skillName of SKILLS) {
    writeSkill(skillRootDir, skillName);
  }
  ensureAgentsSocialRule(workspaceDir);
}

function writeSkill(skillRootDir: string, skillName: SocialSkillName): void {
  const skillDir = path.join(skillRootDir, skillName);
  writeIfChanged(path.join(skillDir, 'SKILL.md'), renderSkill(skillName));
  writeIfChanged(path.join(skillDir, 'agents', 'openai.yaml'), renderOpenAiYaml(skillName));
}

function renderSkill(skillName: SocialSkillName): string {
  switch (skillName) {
    case 'social-intel':
      return renderSocialIntelSkill();
    case 'social-doc-writer':
      return renderSocialDocWriterSkill();
    case 'x-research':
      return renderXResearchSkill();
    case 'xiaohongshu-research':
      return renderXiaohongshuResearchSkill();
    case 'douyin-research':
      return renderDouyinResearchSkill();
    case 'bilibili-research':
      return renderBilibiliResearchSkill();
    case 'wechat-article-research':
      return renderWechatArticleResearchSkill();
  }
}

function renderSocialIntelSkill(): string {
  return [
    '---',
    'name: social-intel',
    'description: Use when a task needs public social media research across one or more platforms, such as trend tracking, competitor monitoring, account research, or source collection before writing a report.',
    '---',
    '',
    '# Social Intel',
    '',
    'Use this skill for cross-platform public research.',
    '',
    'Workflow:',
    '- Clarify the platform scope, keywords, entities, time range, and output goal.',
    '- If the task is single-platform and needs depth, switch to the matching platform skill.',
    '- Use `./.codex/skills/gateway-browser/SKILL.md` for public-page browsing and evidence capture.',
    '- Record sources, publish time, author/account, summary, and evidence before drawing conclusions.',
    '- Distinguish between no results, login required, page blocked, and insufficient evidence.',
    '',
    'Rules:',
    '- Default boundary: public pages and user-accessible pages only; do not imply private/API access.',
    '- Never fabricate metrics, timestamps, authors, or rankings.',
    '- If evidence is weak or partial, say so explicitly and list the gaps.',
    '- For cross-platform summaries, keep platform findings separate before synthesizing.',
    '',
    'Minimum result fields:',
    '- platform',
    '- query',
    '- title',
    '- author/account',
    '- published_at',
    '- url',
    '- evidence',
    '- notes',
    '',
  ].join('\n');
}

function renderSocialDocWriterSkill(): string {
  return [
    '---',
    'name: social-doc-writer',
    'description: Use when research findings from social platforms need to be turned into a Feishu document or appended to an existing Feishu DocX or Wiki node.',
    '---',
    '',
    '# Social Doc Writer',
    '',
    'Use this skill after research findings are already collected.',
    '',
    'Workflow:',
    '- Confirm whether the user wants a new Feishu DocX/Wiki node or an append into an existing DocX.',
    '- Normalize the research into sections: background, scope, findings, evidence links, risks, and next steps.',
    '- Use `./.codex/skills/lark-cli/SKILL.md` for the real write operation.',
    '- Create a Feishu DocX or append to an existing DocX only after the structure is clear.',
    '- The final result must be a real Feishu DocX/Wiki write with returned document metadata; a markdown answer in chat is not a substitute.',
    '',
    'Rules:',
    '- Keep raw evidence links in the final document; do not replace them with unsupported summaries.',
    '- When the evidence set is incomplete, include a risk or gap section instead of guessing.',
    '- If the user asks for a Wiki node, probe spaces first, then create or update the target node.',
    '- Do not ask the user for any personal Feishu auth or user login when the target is DocX/Wiki.',
    '',
  ].join('\n');
}

function renderXResearchSkill(): string {
  return [
    '---',
    'name: x-research',
    'description: Use when the task is specifically about public research on X/Twitter, including posts, threads, search results, hashtags, and account pages.',
    '---',
    '',
    '# X Research',
    '',
    'Use this skill for posts, threads, search results, and account pages on X/Twitter.',
    '',
    'Workflow:',
    '- Confirm the target account, keyword, thread, or topic first.',
    '- Search public results and open the most relevant posts or account pages.',
    '- Capture evidence for the exact post/account URL, publish time, author/account, and visible engagement fields only when shown.',
    '- If the task expands beyond X, hand results back to `social-intel` for synthesis.',
    '',
  ].join('\n');
}

function renderXiaohongshuResearchSkill(): string {
  return [
    '---',
    'name: xiaohongshu-research',
    'description: Use when the task is specifically about public Xiaohongshu content research, such as notes, search results, topic pages, or creator profile review.',
    '---',
    '',
    '# Xiaohongshu Research',
    '',
    '适用于公开笔记、搜索结果、作者主页、话题页调研。',
    '',
    'Workflow:',
    '- 先确认是查关键词、具体博主、具体笔记还是话题。',
    '- 打开公开笔记、搜索结果、作者主页，优先记录可见标题、作者、发布时间、链接和页面证据。',
    '- 遇到登录墙、内容折叠或结果不稳定时，明确说明证据边界。',
    '',
  ].join('\n');
}

function renderDouyinResearchSkill(): string {
  return [
    '---',
    'name: douyin-research',
    'description: Use when the task is specifically about public Douyin research, such as public videos, account pages, keyword results, or trend observation.',
    '---',
    '',
    '# Douyin Research',
    '',
    '适用于公开视频、搜索结果、账号页、热点观察。',
    '',
    'Workflow:',
    '- 先确认目标账号、视频、关键词或趋势主题。',
    '- 优先从公开视频、搜索结果、账号页提取证据，不要假设私域数据可见。',
    '- 明确区分公开视频可见信息与需要登录后才能确认的信息。',
    '',
  ].join('\n');
}

function renderBilibiliResearchSkill(): string {
  return [
    '---',
    'name: bilibili-research',
    'description: Use when the task is specifically about public Bilibili research, such as video pages, series pages, creator channels, or topic collection.',
    '---',
    '',
    '# Bilibili Research',
    '',
    '适用于视频页、合集页、UP 主主页、专题内容收集。',
    '',
    'Workflow:',
    '- 确认目标是单个视频、合集、UP 主还是关键词结果。',
    '- 在视频页、合集页、UP 主主页记录标题、UP 主、发布时间、链接和页面证据。',
    '- 如需提炼视频内容，优先使用页面可见简介、分区、字幕或摘要，不编造未看到的内容。',
    '',
  ].join('\n');
}

function renderWechatArticleResearchSkill(): string {
  return [
    '---',
    'name: wechat-article-research',
    'description: Use when the task is specifically about public WeChat official account article research, including article links, article body extraction, and evidence collection from accessible pages.',
    '---',
    '',
    '# WeChat Article Research',
    '',
    '适用于公众号文章链接、文章正文、可访问的公开文章页提取。',
    '',
    'Workflow:',
    '- 优先获取明确的公众号文章链接，再做正文提取和结构化记录。',
    '- 记录文章标题、公众号名、发布时间、原文链接和关键证据。',
    '- 如果文章不可访问、被删除或只能在私域查看，明确说明无法验证。',
    '',
  ].join('\n');
}

function renderOpenAiYaml(skillName: SocialSkillName): string {
  return [
    'interface:',
    `  display_name: "${displayName(skillName)}"`,
    `  short_description: "${shortDescription(skillName)}"`,
    `  default_prompt: "Use $${skillName} for this task."`,
    'policy:',
    '  allow_implicit_invocation: true',
    '',
  ].join('\n');
}

function displayName(skillName: SocialSkillName): string {
  switch (skillName) {
    case 'social-intel':
      return 'Social Intel';
    case 'social-doc-writer':
      return 'Social Doc Writer';
    case 'x-research':
      return 'X Research';
    case 'xiaohongshu-research':
      return 'Xiaohongshu Research';
    case 'douyin-research':
      return 'Douyin Research';
    case 'bilibili-research':
      return 'Bilibili Research';
    case 'wechat-article-research':
      return 'WeChat Article Research';
  }
}

function shortDescription(skillName: SocialSkillName): string {
  switch (skillName) {
    case 'social-intel':
      return 'Collect public social research evidence across platforms.';
    case 'social-doc-writer':
      return 'Turn research findings into Feishu documents.';
    case 'x-research':
      return 'Research public X/Twitter content.';
    case 'xiaohongshu-research':
      return 'Research public Xiaohongshu content.';
    case 'douyin-research':
      return 'Research public Douyin content.';
    case 'bilibili-research':
      return 'Research public Bilibili content.';
    case 'wechat-article-research':
      return 'Research public WeChat articles.';
  }
}

function ensureAgentsSocialRule(workspaceDir: string): void {
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return;
  }
  const content = fs.readFileSync(agentsPath, 'utf8');
  const section = [
    SOCIAL_RULE_START,
    '社媒调研职责：',
    '- 跨平台公开信息调研优先使用 `./.codex/skills/social-intel/SKILL.md`。',
    '- 单平台深挖优先使用对应 skill：`x-research`、`xiaohongshu-research`、`douyin-research`、`bilibili-research`、`wechat-article-research`。',
    '- 把调研结果沉淀为飞书文档时，优先使用 `./.codex/skills/social-doc-writer/SKILL.md`。',
    '- 网页访问和证据采集继续只走 `./.codex/skills/gateway-browser/SKILL.md`，不要假设有平台私有 API。',
    '- 结论前必须先记录来源链接、发布时间、作者/账号、摘要和证据；证据不足时明确标注缺口。',
    SOCIAL_RULE_END,
  ].join('\n');
  const next = upsertManagedSection(content, SOCIAL_RULE_START, SOCIAL_RULE_END, section, [
    /(?:\n|^)社媒调研职责：[\s\S]*?(?=\n开始任何任务前，先阅读这些记忆文件：|\n<!-- gateway:browser-rule:start -->|\n<!-- gateway:reminder-rule:start -->|\n$)/m,
  ]);
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
