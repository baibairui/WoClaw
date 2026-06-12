# OpenAI Codex 项目深度分析：harness 设计、提示词设计与 agent 运转机制

分析对象：`openai/codex` GitHub 仓库  
仓库地址：<https://github.com/openai/codex>  
分析时间：2026-03-27  
分析方法：直接阅读仓库代码、README、app-server/MCP 文档、核心 Rust 实现，不依赖二手解读。

---

## 1. 先给结论

`openai/codex` 的设计不是“一个大 prompt + 一堆 shell 命令”的简单包装，而是一个分层很清楚的本地 agent 系统：

1. 最外层是产品入口层：CLI、App、IDE、MCP/App Server。
2. 中间层是会话与 turn 编排层：负责 thread、turn、history、context diff、resume、compact、prewarm。
3. 内层是工具执行 harness：负责 tool schema 暴露、tool routing、approval、sandbox、network policy、retry。
4. 侧向还有两条关键支撑线：提示词装配系统，以及多 agent 协作系统。

它最值得研究的点有四个：

- 它把 prompt 当成“可组合上下文系统”，不是静态单段 system prompt。
- 它把 agent runtime 拆成 `session -> turn -> tool call -> approval/sandbox -> history` 的稳定状态机。
- 它把多 agent 做成“父子线程 + 事件转发 + 审批回流”，而不是简单地再开一个聊天窗口。
- 它对真实执行环境极其重视：sandbox、network、permission profile、request approval、MCP approval 都在核心 runtime 内部，不是外面缝一层 UI。

一句话概括：**Codex 的 harness 本质上是“提示词编排器 + 工具执行内核 + 会话状态机 + 安全边界层”的组合。**

---

## 2. 仓库层级与总体架构

从仓库当前结构看，主实现已经从早期 TypeScript CLI 转向 Rust：

- 根 README 明确说明 Codex CLI 是本地运行的 coding agent。
- `codex-cli/README.md` 标注 TypeScript CLI 是 legacy，主实现已被 Rust 版本替代。
- 真正的 agent 内核集中在 `codex-rs/`。

可以把它抽象成下面这张图：

```text
┌─────────────────────────────────────────────────────────────┐
│ Product Surfaces                                            │
│  codex CLI / codex app / IDE / MCP server / App Server      │
└───────────────┬─────────────────────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────────────────────┐
│ Session + Turn Engine                                       │
│  thread/start resume fork                                   │
│  turn/start steer interrupt                                 │
│  history / rollout / compact / prewarm                      │
└───────────────┬─────────────────────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────────────────────┐
│ Prompt Assembly                                             │
│  base instructions                                          │
│  developer sections                                         │
│  contextual user sections                                   │
│  environment_context XML                                    │
│  skills / apps / plugins / memories / personality           │
└───────────────┬─────────────────────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────────────────────┐
│ Tool Harness                                                │
│  router -> registry -> handler -> orchestrator              │
│  approval -> sandbox -> network policy -> retry             │
└───────────────┬─────────────────────────────────────────────┘
                │
                v
┌─────────────────────────────────────────────────────────────┐
│ Execution Backends                                          │
│  shell / apply_patch / MCP / dynamic tools / subagents      │
│  seatbelt / linux sandbox / windows restricted token        │
└─────────────────────────────────────────────────────────────┘
```

这类结构意味着：**Codex 的“智能”并不只在模型里，很多能力来自 runtime 对上下文和执行边界的精细管理。**

---

## 3. Harness 设计：真正的“agent 执行内核”长什么样

### 3.1 Session 启动时先固定基础骨架

`codex-rs/core/src/codex.rs` 在 session 初始化时先解析三类基础东西：

- 当前模型和模型信息
- `base_instructions`
- 动态工具集合

最关键的是它对 `base_instructions` 做了稳定优先级解析：

```rust
// codex-rs/core/src/codex.rs:560-569
// Resolve base instructions for the session. Priority order:
// 1. config.base_instructions override
// 2. conversation history => session_meta.base_instructions
// 3. base_instructions for current model
let model_info = models_manager.get_model_info(model.as_str(), &config).await;
let base_instructions = config
    .base_instructions
    .clone()
    .or_else(|| conversation_history.get_base_instructions().map(|s| s.text))
    .unwrap_or_else(|| model_info.get_model_instructions(config.personality));
```

这段设计说明了三个事实：

1. Codex 把“基础人格/能力约束”视为 session 级别状态，不是一次性拼接文本。
2. 它允许用户配置覆盖，也允许历史线程恢复时复用旧的 base instructions。
3. 如果都没有，就退回模型预置说明。

这正是成熟 harness 的特征：**提示词是状态化资产，而不是每轮现拼。**

### 3.2 Tool Router 把模型输出统一路由到不同执行平面

`codex-rs/core/src/tools/router.rs` 做的不是“执行工具”，而是把模型产出的不同调用形态统一转换成内部 `ToolCall`：

```rust
// codex-rs/core/src/tools/router.rs:120-145
match item {
    ResponseItem::FunctionCall { ... } => { ... }
    ResponseItem::ToolSearchCall { ... } => { ... }
    ResponseItem::CustomToolCall { ... } => { ... }
    ResponseItem::LocalShellCall { ... } => { ... }
    _ => Ok(None),
}
```

这层很重要，因为它把以下来源都收敛到同一执行通道：

- 普通 function call
- MCP tool
- 自定义 freeform tool
- local shell
- tool search

也就是说，**模型看到的是统一的“工具能力面”，runtime 看到的是统一的“调度对象”。**

### 3.3 Orchestrator 是核心 harness：approval -> sandbox -> attempt -> retry

`codex-rs/core/src/tools/orchestrator.rs` 文件顶部直接把设计意图写出来了：

```rust
/*
Central place for approvals + sandbox selection + retry semantics.
Drives a simple sequence for any ToolRuntime:
approval -> select sandbox -> attempt -> retry
with an escalated sandbox strategy on denial
*/
```

它的运行顺序非常清楚：

1. 先判断是否需要审批。
2. 再决定第一次尝试用什么 sandbox。
3. 执行工具。
4. 如果是 sandbox denial，再看是否允许升级重试。

对应代码：

```rust
// codex-rs/core/src/tools/orchestrator.rs:119-124
let requirement = tool.exec_approval_requirement(req).unwrap_or_else(|| {
    default_exec_approval_requirement(approval_policy, &turn_ctx.file_system_sandbox_policy)
});
```

```rust
// codex-rs/core/src/tools/orchestrator.rs:174-189
let initial_sandbox = match tool.sandbox_mode_for_first_attempt(req) {
    SandboxOverride::BypassSandboxFirstAttempt => SandboxType::None,
    SandboxOverride::NoOverride => self.sandbox.select_initial(
        &turn_ctx.file_system_sandbox_policy,
        turn_ctx.network_sandbox_policy,
        tool.sandbox_preference(),
        turn_ctx.windows_sandbox_level,
        has_managed_network_requirements,
    ),
};
```

这说明 Codex 的 harness 并不是“tool handler 自己随便执行”，而是所有 mutating/exec 类工具都走统一调度。

这带来几个工程收益：

- 安全策略集中，不会每个工具各写一套审批逻辑。
- sandbox 行为统一，可观测、可统计、可重试。
- 用户授权与 guardian 审查可以插入同一条路径。

### 3.4 Sandbox Manager 是平台相关执行包装层

`codex-rs/sandboxing/src/manager.rs` 负责把“抽象 sandbox 策略”变成不同平台的实际命令包装：

```rust
// codex-rs/sandboxing/src/manager.rs:23-29
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
}
```

选择逻辑：

```rust
// codex-rs/sandboxing/src/manager.rs:138-165
pub fn select_initial(...) -> SandboxType {
    match pref {
        SandboxablePreference::Forbid => SandboxType::None,
        SandboxablePreference::Require => { ... }
        SandboxablePreference::Auto => {
            if should_require_platform_sandbox(...) {
                get_platform_sandbox(...).unwrap_or(SandboxType::None)
            } else {
                SandboxType::None
            }
        }
    }
}
```

这层不是装饰性的。它决定了：

- 是不是必须进平台沙箱
- 读写权限怎么合并
- 网络策略怎么合并
- Linux/macOS/Windows 要用什么实际执行器

所以 Codex harness 的安全边界不是“UI 上一个 approval 按钮”，而是 **runtime 内部的可计算权限模型**。

### 3.5 Apply Patch 不是字符串替换，而是受权限计算约束的结构化变更

`codex-rs/core/src/tools/handlers/apply_patch.rs` 先解析 patch grammar，再计算涉及路径，再合并 turn/session 已授予权限，最后决定直接应用还是转交 exec runtime。

这类设计说明两点：

- Codex 不把 patch 当普通 shell 命令。
- 文件写权限是按路径推导和合并的，不是粗暴地“开了写权限就随便写”。

这恰恰是 agent harness 与普通聊天机器人最大的区别之一。

---

## 4. 提示词设计：不是单一 system prompt，而是分层拼装

### 4.1 模型基础提示词在 `models.json` 中内建

`codex-rs/core/models.json` 里直接存了各模型的 `base_instructions` 和 `instructions_template`。

例如当前 `gpt-5.3-codex`：

```json
// codex-rs/core/models.json:20-23, 52
{
  "slug": "gpt-5.3-codex",
  "description": "Latest frontier agentic coding model.",
  "base_instructions": "You are Codex, a coding agent based on GPT-5..."
}
```

这里最值得注意的是：仓库不是只存一段“最终 prompt”，而是同时存：

- 完整 `base_instructions`
- `instructions_template`
- personality 变量

这意味着它支持：

- 不同模型使用不同内建说明
- personality 按模板注入
- 客户端/服务端根据模式动态重构最终 prompt

这是“prompt asset 化”的设计，而不是把 prompt 埋死在代码里。

### 4.2 真正发给模型的 developer message 是多段拼接出来的

`codex-rs/core/src/codex.rs` 在 `build_initial_context` 中构造 `developer_sections`：

```rust
// codex-rs/core/src/codex.rs:3489-3527
developer_sections.push(DeveloperInstructions::from_policy(...).into_text());
if let Some(developer_instructions) = turn_context.developer_instructions.as_deref() {
    developer_sections.push(developer_instructions.to_string());
}
if let Some(memory_prompt) = ... {
    developer_sections.push(memory_prompt);
}
if let Some(collab_instructions) =
    DeveloperInstructions::from_collaboration_mode(&collaboration_mode) {
    developer_sections.push(collab_instructions.into_text());
}
```

后面还会继续注入：

- realtime 更新说明
- personality 补充说明
- apps/connectors 可用性
- skills section
- plugins section
- commit trailer 规则

这背后的思路是：

**把 prompt 拆成多个职责明确的 section，让不同 runtime feature 只追加自己的上下文，不去篡改一整段总 prompt。**

这非常适合 agent 系统，因为功能是不断增长的：

- 今天加 memory
- 明天加 app/tool 插件
- 后天加 realtime / collaboration mode

如果 prompt 是一整段手写长文，每加一个功能都会越来越脆。Codex 避免了这一点。

### 4.3 用户上下文不是 developer prompt，而是单独的 contextual user message

Codex 同时构造 `contextual_user_sections`，并把环境信息序列化成 XML：

```rust
// codex-rs/core/src/codex.rs:3588-3605
if let Some(user_instructions) = turn_context.user_instructions.as_deref() {
    contextual_user_sections.push(UserInstructions { ... }.serialize_to_text());
}

contextual_user_sections.push(
    EnvironmentContext::from_turn_context(turn_context, shell.as_ref())
        .with_subagents(subagents)
        .serialize_to_xml(),
);
```

对应 `EnvironmentContext`：

```rust
// codex-rs/core/src/environment_context.rs:13-19
pub(crate) struct EnvironmentContext {
    pub cwd: Option<PathBuf>,
    pub shell: Shell,
    pub current_date: Option<String>,
    pub timezone: Option<String>,
    pub network: Option<NetworkContext>,
    pub subagents: Option<String>,
}
```

序列化输出：

```xml
<environment_context>
  <cwd>/path/to/repo</cwd>
  <shell>bash</shell>
  <current_date>2026-03-27</current_date>
  <timezone>Asia/Shanghai</timezone>
  <network enabled="true">
    <allowed>...</allowed>
  </network>
  <subagents>...</subagents>
</environment_context>
```

这个设计很成熟，原因有三点：

1. 环境事实和行为规范分开，减少 prompt 污染。
2. XML 结构比自然语言更稳定，便于模型抽取字段。
3. subagent 状态被并入环境上下文，模型能感知“自己并不孤立”。

### 4.4 AGENTS.md 是长期项目约束，不是一次性聊天补丁

旧 CLI README 里明确写了 AGENTS.md 的合并顺序：

1. `~/.codex/AGENTS.md`
2. 仓库根目录 `AGENTS.md`
3. 当前工作目录的 `AGENTS.md`

这表示 Codex 提示词设计还有一个关键原则：

**项目知识与操作规范尽量外置到文件系统，而不是挤进本轮对话。**

这对 coding agent 尤其重要，因为很多规则是 repo 级稳定知识，不该每轮都重述。

---

## 5. Agent 是如何运转的：从 thread 到 turn，再到 tool

### 5.1 对外 API 把 agent 明确定义成 thread/turn 模型

`codex-rs/app-server/README.md` 和 `codex-rs/docs/codex_mcp_interface.md` 都强调核心接口是：

- `thread/start`
- `thread/resume`
- `thread/fork`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

这意味着在 Codex 里：

- thread 是长期会话容器
- turn 是一次实际推理/执行过程
- steer 是向当前 turn 追加用户输入
- interrupt 是显式中断

这比“每次发消息就是一次请求”更适合 agent，因为 agent 往往需要：

- 在一个 turn 内多次 tool call
- 中途等待批准
- 中途被追加用户指令
- 中途 compact history

### 5.2 SessionState 保存的是 agent 的长期运行状态

`codex-rs/core/src/state/session.rs` 保存了很多关键 session 级信息：

- `history`
- `previous_turn_settings`
- `latest_rate_limits`
- `dependency_env`
- `active_connector_selection`
- `granted_permissions`
- `startup_prewarm`

这说明 Codex 并不是“无状态请求驱动”。它更像一个 **本地常驻状态机**，把每次 turn 的结果沉淀到 session 内存中，再决定后续 prompt 如何差量更新。

### 5.3 TurnState 保存的是一次执行中的挂起状态

`codex-rs/core/src/state/turn.rs` 里有：

- `pending_approvals`
- `pending_request_permissions`
- `pending_user_input`
- `pending_elicitations`
- `pending_dynamic_tools`
- `pending_input`

这就解释了 Codex 为什么能在一个 turn 中自然处理这些场景：

- 工具执行被卡在审批上
- MCP 要求用户补信息
- 用户在 turn 进行中追加 steer 输入
- 动态工具异步返回

换句话说，Codex 的 turn 不是同步 request/response，而是 **带挂起点的异步执行单元**。

---

## 6. 多 agent 设计：不是简单开分身，而是父子线程系统

### 6.1 `spawn_agent` 先受深度限制，再复制配置，再应用角色覆盖

`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` 的逻辑非常清晰：

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:39-44
let child_depth = next_thread_spawn_depth(&session_source);
let max_depth = turn.config.agent_max_depth;
if exceeds_thread_spawn_depth_limit(child_depth, max_depth) {
    return Err(FunctionCallError::RespondToModel(
        "Agent depth limit reached. Solve the task yourself.".to_string(),
    ));
}
```

然后：

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:59-73
let mut config =
    build_agent_spawn_config(&session.get_base_instructions().await, turn.as_ref())?;
apply_requested_spawn_agent_model_overrides(...).await?;
apply_role_to_config(&mut config, role_name).await?;
apply_spawn_agent_runtime_overrides(&mut config, turn.as_ref())?;
apply_spawn_agent_overrides(&mut config, child_depth);
```

这说明 Codex 的多 agent 不是完全独立的新实例，而是：

- 继承父 agent 的基础上下文
- 再叠加 role/model/reasoning 覆盖
- 记录线程来源和深度

所以它更像 **受控分工的线程树**，不是无限套娃。

### 6.2 子 agent 的审批请求不会丢，而是转发回父 session

`codex-rs/core/src/codex_delegate.rs` 里最关键的一段注释：

```rust
// The returned `events_rx` yields non-approval events emitted by the sub-agent.
// Approval requests are handled via `parent_session` and are not surfaced.
```

以及创建子线程时：

```rust
// codex-rs/core/src/codex_delegate.rs:76-97
let CodexSpawnOk { codex, .. } = Codex::spawn(CodexSpawnArgs {
    ...
    session_source: SessionSource::SubAgent(subagent_source),
    ...
    inherited_exec_policy: Some(Arc::clone(&parent_session.services.exec_policy)),
    ...
})
```

后续还会：

- 转发事件
- 过滤 legacy delta
- 把 approval 路由回 parent session

这套设计很关键，因为多 agent 最容易失控的地方就是：

- 子 agent 自己乱提权
- 审批上下文丢失
- 用户看不见是谁在做什么

Codex 的处理方式是：**子 agent 可以执行，但审批控制权仍然汇总到父链路。**

这也是它的多 agent 能走向工程可用，而不只是 demo 的原因。

---

## 7. 历史压缩与启动预热：让 agent 不是越聊越笨

### 7.1 Startup prewarm：先把模型连接热起来

`codex-rs/core/src/session_startup_prewarm.rs` 在 session 启动时会异步预热 websocket 会话：

```rust
// codex-rs/core/src/session_startup_prewarm.rs:159-180
pub(crate) async fn schedule_startup_prewarm(self: &Arc<Self>, base_instructions: String) {
    ...
    let startup_prewarm = tokio::spawn(async move {
        let result =
            schedule_startup_prewarm_inner(startup_prewarm_session, base_instructions).await;
        ...
    });
}
```

真正预热时，它会：

- 生成一个默认 turn context
- 构建工具集
- 构建 prompt
- 调 `prewarm_websocket(...)`

```rust
// codex-rs/core/src/session_startup_prewarm.rs:203-238
let startup_turn_context = session.new_default_turn_with_sub_id(...).await;
let startup_router = built_tools(...).await?;
let startup_prompt = build_prompt(...);
client_session.prewarm_websocket(...).await?;
```

这说明 Codex 不是等第一条真实用户消息来了才慢慢建所有东西，而是提前把冷启动成本吃掉。

### 7.2 Remote compact：把旧历史压缩成更短但可恢复的表示

`codex-rs/core/src/compact_remote.rs` 显示其 compact 流程不是简单删消息，而是：

1. 从当前 history 克隆。
2. 先按上下文窗口裁掉部分 function call history。
3. 用当前 prompt、工具可见性、base instructions 让模型做 compact。
4. 再过滤掉 stale developer/user wrapper。
5. 必要时重新注入 canonical initial context。

代码骨架：

```rust
// codex-rs/core/src/compact_remote.rs:76-115
let mut history = sess.clone_history().await;
let base_instructions = sess.get_base_instructions().await;
let deleted_items = trim_function_call_history_to_fit_context_window(...);
let prompt_input = history.for_prompt(...);
let tool_router = built_tools(...).await?;
let prompt = Prompt {
    input: prompt_input,
    tools: tool_router.model_visible_specs(),
    parallel_tool_calls: turn_context.model_info.supports_parallel_tool_calls,
    base_instructions,
    personality: turn_context.personality,
    output_schema: None,
};
```

compact 完之后还会刻意丢弃模型输出里的旧 developer 消息：

```rust
// codex-rs/core/src/compact_remote.rs:195-199
// We drop:
// - `developer` messages because remote output can include stale/duplicated
//   instruction content.
```

这很聪明，因为很多 agent 在压缩历史时会把过期 prompt 也一并塞回去，越压越乱。Codex 这里是在做：

**压缩语义历史，但保留当前 runtime 重新注入最新指令的能力。**

---

## 8. 提示词设计的真实风格：为什么它比较“工程化”

从 `models.json` 和实际 prompt 拼装逻辑看，Codex 的提示词设计有几个鲜明特点：

### 8.1 价值观写死，但执行上下文动态注入

内建 base instructions 明确写了：

- pragmatic
- clarity
- rigor
- editing constraints
- tool usage style
- final answer format

这保证“人格和工程风格”稳定。

而以下内容是动态注入的：

- sandbox / approval policy
- 当前 cwd、shell、日期、时区
- apps / skills / plugins
- collaboration mode
- user instructions
- subagent 列表

这保证“执行环境”实时准确。

所以它不是把所有内容都写进一段超长 system prompt，而是：

**稳定原则放 base，易变事实放 context updates。**

### 8.2 它让 prompt 面向 runtime，而不是只面向语言模型

很多 agent prompt 只会说“你应该谨慎”。Codex 则会把：

- approval policy
- sandbox mode
- tool availability
- formatting rules
- AGENTS.md 作用域

都结构化地灌进去。

这使模型不只是“会说”，而是更容易在 runtime 约束下行动一致。

### 8.3 personality 是模板变量，不是另一套平行 prompt

`models.json` 里有 `personality_default` / `personality_friendly` / `personality_pragmatic`。

这比“friendly 模式换一整套 prompt”更稳，因为：

- 共享大部分硬规则
- 只替换社交与沟通风格
- 避免不同 personality 在工程约束上漂移

这是很成熟的 prompt engineering 手法。

---

## 9. 我对 Codex harness 的判断：它到底强在哪

### 9.1 它强在“把模型放进了可控 runtime”

Codex 的核心竞争力不是某一段 prompt，而是：

- 会话状态有结构
- turn 有挂起点
- 工具有统一路由
- 执行有统一 orchestrator
- 权限和 sandbox 可计算
- 多 agent 继承链清楚

这套组合让模型不再只是“生成器”，而变成 **受控执行器**。

### 9.2 它不是完全 agent-native，而是 product-native

你会发现 Codex 很多设计不是纯学术意义的 agent loop，而是产品可用性导向：

- startup prewarm 降低冷启动
- compact 保住上下文窗口
- thread/turn API 方便外部客户端接入
- MCP server 让外部产品可以把 Codex 当后端引擎
- approvals/guardian 满足实际安全需求

这意味着它不是“研究 demo”，而是一个真实产品 runtime。

### 9.3 它最值得借鉴的三点

如果你要自己做 agent 框架，我认为最该抄的是：

1. **Prompt 分层装配**
   不要把所有规则写成一大段 system prompt，要区分 base / developer / contextual user / env facts。

2. **统一工具 orchestrator**
   不要让每个工具各自处理审批、sandbox 和 retry，要集中治理。

3. **父子 agent 的审批回流**
   多 agent 不是难在 spawn，而是难在权限、可观测性和收敛控制。

---

## 10. 也要看到它的代价与局限

### 10.1 架构复杂度很高

这种设计的代价是模块非常多：

- session/state/history
- prompt updates
- tool registry/router/handlers
- sandbox manager
- network approval
- compact/prewarm
- app server/MCP
- multi-agent control

这会显著提高维护门槛。

### 10.2 提示词资产很长，而且耦合产品规则

`models.json` 里的 base instructions 已经很长，而且包含大量产品行为规范。  
优点是稳定；缺点是：

- 改 prompt 需要兼顾很多 feature
- 很容易出现“一个规则影响多个 surface”
- 需要大量测试防止 prompt shape 回归

### 10.3 用户可见行为强依赖 runtime，不只是模型能力

这意味着复刻一个“看起来像 Codex”的 prompt 没用。  
如果没有：

- thread/turn 状态机
- approval/sandbox harness
- 环境上下文注入
- compact / prewarm / rollout

你复制出来的只会是“讲话像 Codex”，不是“运行像 Codex”。

---

## 11. 最终结论

`openai/codex` 这个项目的精髓，不在于某一段神奇 prompt，而在于它把本地 coding agent 真正工程化了。

它的设计可以归纳为：

- **harness 设计**：用统一 orchestrator 管审批、沙箱、网络、重试，把执行安全收口。
- **提示词设计**：base instructions 稳定，developer/contextual user 动态拼装，环境事实结构化注入。
- **agent 运转**：以 `thread -> turn -> tool call -> state update` 为主轴，支持 steer、interrupt、compact、resume。
- **multi-agent 设计**：子 agent 继承父上下文，但审批控制权回流父链路，保证系统可控。

如果要用一句更“底层”的话来评价：

**Codex 不是“会写代码的聊天机器人”，而是“把模型嵌入到可恢复、可审批、可约束、可分工的本地执行系统里”。**

---

## 12. 关键源码索引

- 仓库入口与产品定位：`README.md`
- 旧 CLI/AGENTS 说明：`codex-cli/README.md`
- session 初始化与 base instructions 解析：`codex-rs/core/src/codex.rs`
- 初始上下文 / prompt section 拼装：`codex-rs/core/src/codex.rs`
- environment context XML：`codex-rs/core/src/environment_context.rs`
- tool routing：`codex-rs/core/src/tools/router.rs`
- tool harness orchestration：`codex-rs/core/src/tools/orchestrator.rs`
- apply_patch 处理：`codex-rs/core/src/tools/handlers/apply_patch.rs`
- sandbox manager：`codex-rs/sandboxing/src/manager.rs`
- session state：`codex-rs/core/src/state/session.rs`
- turn state：`codex-rs/core/src/state/turn.rs`
- multi-agent spawn：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`
- subagent delegation：`codex-rs/core/src/codex_delegate.rs`
- startup prewarm：`codex-rs/core/src/session_startup_prewarm.rs`
- remote compact：`codex-rs/core/src/compact_remote.rs`
- app server API：`codex-rs/app-server/README.md`
- MCP server interface：`codex-rs/docs/codex_mcp_interface.md`

---

## 13. 附：几个最值得反复看的代码片段

### A. base instructions 的优先级

```rust
let base_instructions = config
    .base_instructions
    .clone()
    .or_else(|| conversation_history.get_base_instructions().map(|s| s.text))
    .unwrap_or_else(|| model_info.get_model_instructions(config.personality));
```

意义：提示词是 session 资产，不是一次性拼串。

### B. developer sections 的组装方式

```rust
developer_sections.push(DeveloperInstructions::from_policy(...).into_text());
developer_sections.push(developer_instructions.to_string());
developer_sections.push(memory_prompt);
developer_sections.push(collab_instructions.into_text());
```

意义：prompt 采用 section 化拼装，而不是单块长文本。

### C. 环境上下文结构

```rust
pub(crate) struct EnvironmentContext {
    pub cwd: Option<PathBuf>,
    pub shell: Shell,
    pub current_date: Option<String>,
    pub timezone: Option<String>,
    pub network: Option<NetworkContext>,
    pub subagents: Option<String>,
}
```

意义：环境事实独立建模，而不是散落在自然语言里。

### D. tool orchestrator 的核心顺序

```rust
approval -> select sandbox -> attempt -> retry
```

意义：执行安全与重试统一收口。

### E. 多 agent spawn 的关键动作

```rust
build_agent_spawn_config(...)
apply_requested_spawn_agent_model_overrides(...)
apply_role_to_config(...)
spawn_agent_with_metadata(...)
```

意义：子 agent 是“继承 + 覆盖”的线程分工模型。

