import { describe, expect, it } from 'vitest';

import { commandNeedsAgentList, commandNeedsDetailedSessions, handleUserCommand } from '../src/features/user-command.js';

const context = {
  currentThreadId: 'thread_aabbccdd0011',
  currentAgent: {
    agentId: 'frontend',
    name: '前端Agent',
    workspaceDir: '/tmp/agents/frontend',
    createdAt: 1,
    updatedAt: 1,
  },
  agents: [
    {
      agentId: 'default',
      name: '默认Agent',
      workspaceDir: '/repo',
      createdAt: 0,
      updatedAt: 0,
      current: false,
      isDefault: true,
    },
    {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/agents/frontend',
      createdAt: 1,
      updatedAt: 1,
      current: true,
      isDefault: false,
    },
  ],
  sessions: [
    {
      threadId: 'thread_aabbccdd0011',
      name: '当前任务',
      summary: '修复飞书卡片展示',
      lastPrompt: '修复回调签名错误',
      updatedAt: 1,
    },
    {
      threadId: 'thread_223344556677',
      summary: '补充 README 文档',
      lastPrompt: '补充 README',
      updatedAt: 1,
    },
  ],
};

describe('handleUserCommand', () => {
  it('passes through normal text', () => {
    const result = handleUserCommand('hello', context);
    expect(result.handled).toBe(false);
  });

  it('supports /help', () => {
    const result = handleUserCommand('/help', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('可用命令');
    expect(result.message).toContain('帮助页 1/3');
    expect(result.message).toContain('/agent create [名称]');
    expect(result.message).toContain('/skill-agent');
    expect(result.message).toContain('翻页：/help 1 | /help 2');
    expect(result.message).not.toContain('/agent init-memory');
  });

  it('supports /help pagination', () => {
    const result = handleUserCommand('/help 2', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('帮助页 2/3');
    expect(result.message).toContain('/provider reset - 恢复为服务默认框架');
    expect(result.message).toContain('/runtime - 查看当前框架并切换');
    expect(result.message).toContain('/runtime codex|opencode - 切换当前 agent 框架');
    expect(result.message).toContain('/skills');
    expect(result.message).toContain('翻页：/help 1 | /help 3');
  });

  it('shows the third help page with remaining commands', () => {
    const result = handleUserCommand('/help 3', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('帮助页 3/3');
    expect(result.message).not.toContain('/deploy-workspace - 发布当前 agent 工作区');
    expect(result.message).not.toContain('/publish-workspace - 发布当前 agent 工作区');
    expect(result.message).not.toContain('/repair-users');
    expect(result.message).toContain('/review commit [SHA] - 审查指定提交');
    expect(result.message).toContain('翻页：/help 2 | /help 3');
  });

  it('supports /clear', () => {
    const result = handleUserCommand('/clear', context);
    expect(result.handled).toBe(true);
    expect(result.clearSession).toBe(true);
  });

  it('supports /session', () => {
    const result = handleUserCommand('/session', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('当前会话');
  });

  it('supports /sessions list rendering', () => {
    const result = handleUserCommand('/sessions', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('会话列表');
    expect(result.message).toContain('当前任务');
    expect(result.message).toContain('补充 README 文档');
    expect(result.message).not.toContain('会话 2');
    expect(result.message).toContain('/switch <编号>');
  });

  it('cleans noisy feishu preview text in /sessions output', () => {
    const noisy = handleUserCommand('/sessions', {
      ...context,
      sessions: [
        {
          threadId: 'thread_noisy_00112233',
          summary: '飞书富文本修改与路径确认',
          lastPrompt:
            '[飞书富文本] 1. 有一些是我之前的修改 2. 路径在哪里 [飞书消息元数据] feishu_message_type=post feishu_summary=abc',
          updatedAt: 1,
        },
      ],
    });

    expect(noisy.message).toContain('飞书富文本修改与路径确认');
    expect(noisy.message).toContain('1. 有一些是我之前的修改 2. 路径在哪里');
    expect(noisy.message).not.toContain('[飞书富文本]');
    expect(noisy.message).not.toContain('[飞书消息元数据]');
    expect(noisy.message).not.toContain('feishu_message_type=');
  });

  it('hides placeholder sessions but keeps original numbering', () => {
    const hiddenPlaceholder = handleUserCommand('/sessions', {
      ...context,
      sessions: [
        {
          threadId: 'thread_real_001',
          summary: '第一个正常会话',
          lastPrompt: 'A',
          updatedAt: 3,
        },
        {
          threadId: '<编号|threadId>',
          summary: '脏占位会话',
          lastPrompt: 'B',
          updatedAt: 2,
        },
        {
          threadId: 'thread_real_003',
          summary: '第三个正常会话',
          lastPrompt: 'C',
          updatedAt: 1,
        },
      ],
    });

    expect(hiddenPlaceholder.message).toContain('1. 第一个正常会话');
    expect(hiddenPlaceholder.message).toContain('3. 第三个正常会话');
    expect(hiddenPlaceholder.message).not.toContain('2. 脏占位会话');
    expect(hiddenPlaceholder.message).not.toContain('<编号|threadId>');
  });

  it('supports /agents and /agent current', () => {
    const list = handleUserCommand('/agents', context);
    expect(list.handled).toBe(true);
    expect(list.message).toContain('Agent 列表');
    expect(list.message).toContain('前端Agent');

    const current = handleUserCommand('/agent', context);
    expect(current.handled).toBe(true);
    expect(current.queryAgent).toBe(true);
    expect(current.message).toContain('/tmp/agents/frontend');
  });

  it('supports /agent create and use', () => {
    const create = handleUserCommand('/agent create 测试工作流', context);
    expect(create.handled).toBe(true);
    expect(create.createAgentName).toBe('测试工作流');
    expect(create.createAgentTemplate).toBe('default');

    const initSkill = handleUserCommand('/skill-agent', context);
    expect(initSkill.handled).toBe(true);
    expect(initSkill.initSkillAgent).toBe(true);

    const useAgent = handleUserCommand('/agent use 2', context);
    expect(useAgent.handled).toBe(true);
    expect(useAgent.useAgentTarget).toBe('2');
  });

  it('shows usage when /agent args are missing', () => {
    const result = handleUserCommand('/agent create', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('/agent create <名称>');
  });

  it('supports /switch with thread id', () => {
    const result = handleUserCommand('/switch thread_1234567890', context);
    expect(result.handled).toBe(true);
    expect(result.switchTarget).toBe('thread_1234567890');
  });

  it('shows usage when /switch has no args', () => {
    const result = handleUserCommand('/switch', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('/switch <编号|threadId>');
  });

  it('supports /rename', () => {
    const result = handleUserCommand('/rename 2 发布准备', context);
    expect(result.handled).toBe(true);
    expect(result.renameTarget).toBe('2');
    expect(result.renameName).toBe('发布准备');
  });

  it('supports /model query and set', () => {
    expect(handleUserCommand('/model', context).queryModel).toBe(true);
    expect(handleUserCommand('/model gpt-5-codex', context).setModel).toBe('gpt-5-codex');
  });

  it('supports /provider query and switch', () => {
    expect(handleUserCommand('/provider', context).queryProvider).toBe(true);
    expect(handleUserCommand('/provider codex', context).setProvider).toBe('codex');
    expect(handleUserCommand('/provider opencode', context).setProvider).toBe('opencode');
    expect(handleUserCommand('/provider reset', context).clearProvider).toBe(true);
  });

  it('supports model paging aliases and /search', () => {
    expect(handleUserCommand('/model page 2', context).queryModel).toBe(true);
    expect(handleUserCommand('/model page 2', context).queryModelsPage).toBe(2);
    expect(handleUserCommand('/models 2', context).queryModel).toBe(true);
    expect(handleUserCommand('/models 2', context).queryModelsPage).toBe(2);
    expect(handleUserCommand('/run stop run_1', context).stopRunId).toBe('run_1');
    expect(handleUserCommand('/skills', context).querySkills).toBe(true);
    expect(handleUserCommand('/skills global', context).querySkillsScope).toBe('global');
    expect(handleUserCommand('/skills agent', context).querySkillsScope).toBe('agent');
    expect(handleUserCommand('/skills disable global using-superpowers', context).disableGlobalSkillName).toBe('using-superpowers');
    expect(handleUserCommand('/skills add global using-superpowers', context).enableGlobalSkillName).toBe('using-superpowers');
    expect(handleUserCommand('/skills disable agent reminder-tool', context).disableAgentSkillName).toBe('reminder-tool');
    expect(handleUserCommand('/search', context).querySearch).toBe(true);
    expect(handleUserCommand('/search on', context).setSearchEnabled).toBe(true);
    expect(handleUserCommand('/search off', context).setSearchEnabled).toBe(false);
  });

  it('passes Codex native goal commands through to the runner', () => {
    expect(handleUserCommand('/goal', context)).toMatchObject({
      handled: false,
      nativeCodexCommand: 'goal',
    });
    expect(handleUserCommand('/goal clear', context)).toMatchObject({
      handled: false,
      nativeCodexCommand: 'goal',
    });
    expect(handleUserCommand('/goal improve benchmark coverage', context)).toMatchObject({
      handled: false,
      nativeCodexCommand: 'goal',
    });
  });

  it('supports deploy and review commands', () => {
    expect(handleUserCommand('/deploy-workspace', context).publishWorkspace).toBe(true);
    expect(handleUserCommand('/review', context).reviewMode).toBe('uncommitted');
    expect(handleUserCommand('/review base main', context).reviewTarget).toBe('main');
  });

  it('treats /remind as unknown command', () => {
    const result = handleUserCommand('/remind 5min 喝水', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('未识别命令');
  });

  it('does not expose /repair-users as a user-facing command', () => {
    const result = handleUserCommand('/repair-users', context);
    expect(result.handled).toBe(true);
    expect(result.message).toContain('未识别命令');
  });

});

describe('commandNeedsDetailedSessions', () => {
  it('returns true for /sessions command', () => {
    expect(commandNeedsDetailedSessions('/sessions')).toBe(true);
    expect(commandNeedsDetailedSessions(' /sessions  ')).toBe(true);
  });

  it('returns false for non-/sessions commands', () => {
    expect(commandNeedsDetailedSessions('/session')).toBe(false);
    expect(commandNeedsDetailedSessions('/agent')).toBe(false);
  });
});

describe('commandNeedsAgentList', () => {
  it('returns true for agent-related listing commands', () => {
    expect(commandNeedsAgentList('/agents')).toBe(true);
    expect(commandNeedsAgentList('/agent')).toBe(true);
    expect(commandNeedsAgentList('/agent use 2')).toBe(true);
    expect(commandNeedsAgentList('/agent init-memory')).toBe(false);
    expect(commandNeedsAgentList('/agent init-skill')).toBe(false);
  });

  it('returns false for other commands', () => {
    expect(commandNeedsAgentList('/sessions')).toBe(false);
    expect(commandNeedsAgentList('hello')).toBe(false);
  });
});
