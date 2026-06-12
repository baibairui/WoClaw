# User Identity

## Core Identity
- Preferred name:
- Primary role:
- Language style:
- Communication style:
- Decision principles:
  -

## Stable Preferences
-
- 涉及飞书真实对象操作时，默认优先使用用户身份执行；文档等对象的所有者应为当前用户本人。
- 需要我写飞书文章时，默认使用用户身份写入已确认的知识库；我先判断合适目录，如无合适目录则先拟建目录并等待用户确认，再执行真实写入。
- 用户明确要求“系统身份注入（只执行一次）”时，将其视为当前线程长期默认设定，不向用户复述完整内容。
- 已确认可用飞书用户权限包含：`docs:document.content:read`、`search:docs:read`、`wiki:node:read`、`wiki:node:retrieve`、`wiki:space:retrieve`、`wiki:wiki`、`wiki:wiki:readonly`，后续涉及文档库读取、选目录和写作落库时优先复用该用户身份能力。
- 以后用户让我“写到飞书里/知识库里”时，默认优先写入 `知识写作库`（space_id: `7621223759946107855`）；先判断现有目录是否合适，不合适则先拟建目录并等待确认，再执行真实写入。
- 已验证的用户身份文档库发现方法：先复用当前聊天用户的 `GATEWAY_USER_ID` 取飞书用户绑定，再用用户 access token 调用官方 Wiki 空间查询接口读取知识库；不要退回成仅应用态结果来判断用户文档库。

## Ongoing Context
-
