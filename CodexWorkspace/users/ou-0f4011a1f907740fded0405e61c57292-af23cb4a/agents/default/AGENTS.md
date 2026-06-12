# AGENTS.md

当前工作区属于 agent `默认Agent`（ID: `default`）。

开始任务前，先阅读这些文件：
- `./SOUL.md`
- `../../user.md`
- `../../../../runtime/house-rules.md`
- `../../../../runtime/shared-context.md`

工具路由：
- 浏览器任务：`./.codex/skills/gateway-browser/SKILL.md`
- 桌面任务：`./.codex/skills/macos-gui-skill/SKILL.md`
- 定时提醒：`./.codex/skills/reminder-tool/SKILL.md`
- 飞书官方操作：`./.codex/skills/lark-cli/SKILL.md`
- 社媒调研：`./.codex/skills/social-intel/SKILL.md`

工作规则：
- 不要编造执行结果；没有真实证据前不要声称完成。
- 用户长期身份维护在上层 `user.md`。
- 当前 agent 短期上下文维护在 `./memory/daily/`。
- 能力专属的长操作规范留在对应 skill 中，不在当前工作区复制 playbook。

<!-- gateway:browser-rule:start -->
浏览器操作职责：
- 当任务需要网页交互时，只允许使用 `./.codex/skills/gateway-browser/SKILL.md` 及其自带脚本完成操作，不要让用户手工点击。
- 禁止直接使用 playwright-cli、任何自定义 wrapper script、/open 或其他 shell/browser 启动通道。
- 每次操作前先说明计划步骤，操作后按“Action / Evidence / Result / Next step”回报。
- 页面意图模糊、多个相似目标并存、或预期状态未出现时，先暂停并请求用户决策。
- 涉及提交、发布、支付、外部数据发送、文件上传时，若用户未明确授权，先暂停并确认。
- 如果网页需要登录、验证码或支付确认，先提示用户接管，不要编造已完成。
- 人工接管触发条件可直接按这组理解：登录、验证码、扫码、支付确认、权限弹窗、高风险提交、页面目标歧义。
<!-- gateway:browser-rule:end -->

<!-- gateway:desktop-rule:start -->
桌面操作职责：
- 当任务需要桌面软件交互时，只允许使用 `./.codex/skills/macos-gui-skill/SKILL.md` 及其自带脚本完成操作，不要直接执行 shell 命令或自行调用 osascript。
- 只操作前台可见应用；如果目标应用不在前台，先用 skill 激活或启动它。
- 默认走 `observe -> act -> observe`；先用 `observe` 拿视觉证据，再执行一个 2-5 步的 `act` GUI 动作包，然后再次观察结果。
- 在认定 `act` 不可用、缺依赖或权限不足之前，必须先运行 `doctor` 读取明确诊断结果。
- 不要自行切换到系统级 UI 脚本探测环境；`doctor` 是桌面技能依赖、权限和 fallback 判断的唯一依据。
- `run-shell` 和 `run-applescript` 只作为兜底，不要作为默认首选；只有在 `doctor` 明确表明需要处理 blocker，或用户明确要求时才允许使用。
- 每次关键动作后都要补一张截图作为证据，按“Action Bundle / Evidence / Result / Next step”回报。
- 涉及发送、删除、支付、权限确认等不可逆动作时，若用户未明确授权，先暂停并请求确认。
<!-- gateway:desktop-rule:end -->

<!-- gateway:reminder-rule:start -->
提醒规则：
- 用户提出“稍后提醒我”或定时任务需求时，优先使用 `./.codex/skills/reminder-tool/SKILL.md`。
- 必须执行该 skill 自带 reminder 脚本创建提醒，不要要求用户输入 `/remind`。
<!-- gateway:reminder-rule:end -->

<!-- gateway:feishu-ops:start -->
飞书官方操作规则：
- 用户要求创建或编辑飞书文档、知识库、日程、待办、云空间对象时，统一使用 `./.codex/skills/lark-cli/SKILL.md`。
- 优先使用 `lark-cli` 的 shortcut 命令，不要继续调用仓库里的旧飞书脚本。
- 首次使用前先确认宿主机已安装 `@larksuite/cli`，并完成 `npx skills add larksuite/cli -y -g`。
- 文档写入优先使用 `lark-cli docs +create` / `lark-cli docs +update`；知识库节点操作优先使用 `lark-cli wiki`；不要再使用 `feishu-canvas`。
- 日程优先使用 `lark-cli calendar +agenda`、`+freebusy`、`+suggestion`、`+create`；待办优先使用 `lark-cli task +create`、`+update`、`+get-my-tasks`。
- 若参数结构不确定，先执行 `lark-cli schema ...` 或阅读官方 lark skill 文档，不要猜字段。
- 必须执行真实 `lark-cli` 命令拿到返回结果后再声称完成。
<!-- gateway:feishu-ops:end -->

<!-- gateway:social-intel:start -->
社媒调研职责：
- 跨平台公开信息调研优先使用 `./.codex/skills/social-intel/SKILL.md`。
- 单平台深挖优先使用对应 skill：`x-research`、`xiaohongshu-research`、`douyin-research`、`bilibili-research`、`wechat-article-research`。
- 把调研结果沉淀为飞书文档时，优先使用 `./.codex/skills/social-doc-writer/SKILL.md`。
- 网页访问和证据采集继续只走 `./.codex/skills/gateway-browser/SKILL.md`，不要假设有平台私有 API。
- 结论前必须先记录来源链接、发布时间、作者/账号、摘要和证据；证据不足时明确标注缺口。
<!-- gateway:social-intel:end -->
