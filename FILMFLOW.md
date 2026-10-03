# FilmFlow

AI 虚拟制片工作台：让几十个 AI 镜头真正属于同一部影片。实现依据 `AI_Virtual_Production_Infinite_Canvas_FINAL_PRD.md`，
基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（锁定 `UPSTREAM_SHA`）扩展。

```
server/   FilmFlow 后端：认证/工作区/多租户、领域模型、任务队列、积分账本、Provider 适配器、Admin（Hono + SQLite）
web/      上游前端 + 新增 /studio 制片工作台、设置、管理后台
docs/adr  架构决策记录（先读 0001）   docs/PLAN.md  阶段状态
```

## 运行
```bash
# 1) 后端（Node ≥ 22）
cd server && npm install && npm run dev        # http://localhost:8787 ，数据在 server/data/
# 2) 前端
cd web && bun install && bun run dev           # http://localhost:3000/studio （/ff-api 自动代理到后端）
# 3) 构建画布领域节点插件（输出到 web/public/plugins/filmflow.js，默认启用）
cd plugins/canvas/sdk && npm install && cd ../filmflow && npm install && npm run build
# 4) 可选：灌一个演示项目
cd server && npm run seed
```
- 登录：邮箱验证码。未配置 SMTP 时（非 production）验证码会打印在后端日志并回显到登录页。
- 管理员：邮箱在 `FILMFLOW_ADMIN_EMAILS`（默认 `admin@filmflow.local`）的账号登录后即为超级管理员。
- 默认带离线 **Mock Provider**（生成带标注的 SVG 关键帧/Take），无需任何付费 Key 即可跑通整条链路。接真实模型：管理后台启用 `openai-compatible` Provider，填 Base URL 与平台 Key（或用户在「设置 → API Key」填 BYOK），上架对应模型。

## 环境变量（server）
`PORT` `FILMFLOW_DATA_DIR` `FILMFLOW_DB` `FILMFLOW_MASTER_KEY`(64 位 hex，生产必设) `FILMFLOW_ADMIN_EMAILS` `NODE_ENV=production`

## 质量门禁
```bash
cd server && npm run typecheck && npm test     # 15 个黄金路径验收测试（PRD §26）
cd web && bun run typecheck && bun run build
```

## 在上游画布里用领域节点
先在 `/studio/login` 登录，再打开 `/canvas`：新建节点 →「FilmFlow 项目」，面板里选项目 →「同步领域节点到画布」。资产节点连到镜头节点即把资产加入该镜头；上游图片节点可「登记为参考」并绑定角色。
