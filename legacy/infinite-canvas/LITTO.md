# LITTO（里头）

> 好戏，都在里头。

AI 虚拟制片工作台：让几十个 AI 镜头真正属于同一部影片。实现依据 `AI_Virtual_Production_Infinite_Canvas_FINAL_PRD.md`，
基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（锁定 `UPSTREAM_SHA`）扩展。

```
server/   LITTO 后端：认证/工作区/多租户、领域模型、任务队列、积分账本、Provider 适配器、Admin（Hono + SQLite）
web/      上游前端 + 新增 /studio 制片工作台、设置、管理后台
docs/adr  架构决策记录（先读 0001）   docs/PLAN.md  阶段状态
```

## 运行
```bash
# 1) 后端（Node ≥ 22）
cd server && npm install && npm run dev        # http://localhost:8787 ，数据在 server/data/
# 2) 前端
cd web && bun install && bun run dev           # http://localhost:3000/studio （/litto-api 自动代理到后端）
# 3) 构建画布领域节点插件（输出到 web/public/plugins/litto.js，默认启用）
cd plugins/canvas/sdk && npm install && cd ../litto && npm install && npm run build
# 4) 可选：灌一个演示项目
cd server && npm run seed
```
- 登录：邮箱验证码。未配置 SMTP 时（非 production）验证码会打印在后端日志并回显到登录页。
- 管理员：邮箱在 `LITTO_ADMIN_EMAILS`（默认 `admin@litto.local`）的账号登录后即为超级管理员。
- 默认带离线 **Mock Provider**（生成带标注的 SVG 关键帧/Take），无需任何付费 Key 即可跑通整条链路。接真实模型：管理后台启用 `openai-compatible` Provider，填 Base URL 与平台 Key（或用户在「设置 → API Key」填 BYOK），上架对应模型。

## 环境变量（server）
`PORT` `LITTO_DATA_DIR` `LITTO_DB` `LITTO_MASTER_KEY`(64 位 hex，生产必设) `LITTO_ADMIN_EMAILS` `LITTO_PUBLIC_URL` `LITTO_WEB_URL` `NODE_ENV=production`

| 能力 | 变量 |
|---|---|
| OAuth（配置了才启用） | `LITTO_OAUTH_GITHUB_ID/SECRET`、`LITTO_OAUTH_GOOGLE_ID/SECRET`、`LITTO_OAUTH_APPLE_ID/TEAM_ID/KEY_ID/PRIVATE_KEY`；回调地址 `${LITTO_PUBLIC_URL}/auth/oauth/<provider>/callback` |
| 企业 SSO | 管理后台 → 企业 SSO：标准 **OIDC**（Okta / Azure AD / Keycloak 等，discovery + PKCE + id_token 的 JWKS 验签）；按邮箱域名发现，可强制 SSO（禁用验证码/OAuth）、自动加入团队工作区。**不支持 SAML** |
| 支付 | `LITTO_STRIPE_SECRET`、`LITTO_STRIPE_WEBHOOK_SECRET`；非 production 默认 Mock 支付（即时到账，仅测试） |
| 媒体衍生物 / 渲染 | 服务器装有 `ffmpeg` 时自动生成缩略图、480p 代理视频，并可把全部为真实视频的序列渲染成 MP4 |
| Provider 回调 | 管理后台 → Provider → 生成 Webhook 密钥；回调 `POST /webhooks/providers/:id`，头 `X-LITTO-Signature` = HMAC-SHA256(密钥, 原始 body) |

## 质量门禁
```bash
cd server && npm run typecheck && npm test     # 23 个测试：黄金路径验收（PRD §26）+ 团队/OAuth/订阅/Webhook/成片/LLM
cd web && bun run typecheck && bun run build
```

## 在上游画布里用领域节点
先在 `/studio/login` 登录，再打开 `/canvas`：新建节点 →「LITTO 项目」，面板里选项目 →「同步领域节点到画布」。资产节点连到镜头节点即把资产加入该镜头；上游图片节点可「登记为参考」并绑定角色。

## 实时协作
项目页订阅 `GET /projects/:id/events`（SSE）：他人的改动会在 ~300ms 内刷新你的视图，右上角显示协作者头像，镜头/资产节点上会出现对方的彩色边框。保存镜头/资产时携带 `expectedUpdatedAt`，他人更晚修改过则返回 412 `stale`。这是「变更推送 + 在线状态 + 乐观并发」，不是 CRDT 式的同字段合并编辑。

## 简单模式（默认）与专业模式
- 新建项目是一个向导：名称 + 画面风格预设 + 可选剧本。贴了剧本会自动识别角色/场景/道具、套用影调与世界观并拆成镜头（`POST /projects/:id/bootstrap`，规则识别，英文剧本效果最好；识别结果可在资产栏改）。
- 影调用 6 个预设一键套用，13 个专业字段在「高级微调」里；镜头只露出标题、动作、台词、景别、时长、出场资产，其余在「专业参数」里。
- 右上角「专业模式」开关显示 QC/状态/历史标签与影调的序列/镜头覆盖等；默认关闭。
- 没有参考图的角色只给出「建议上传」的提示（medium），不再阻止批准 Take。
