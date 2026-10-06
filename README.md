<p align="center">
  <img src="packages/assets/logo-wordmark.svg" width="260" alt="LITTO 里头" />
</p>

<h3 align="center">好戏，都在里头。</h3>

LITTO（里头）是面向影视与短剧创作的 AI 工作台：把剧本、角色、场景、分镜和生成放进同一个无限画布，由 Agent 协助你从一句灵感走到一部成片。

产品要求以 [LITTO PRD V3.0](docs/prd.md) 为准，包含一级 Music Film／音乐影像模块。当前实现与目标之间的差距见 [V3 核查表](docs/prdAudit.md)；已有后端代码不等于当前工作台已接通全部制片能力，MV 核心链路尚未实现。

## 核心能力

- **无限画布**：文本、图片、视频、音频、3D 导演台等节点自由连线，所见即所得。
- **AI Agent**：内置创作搭档，能读写项目文件、操作画布、调用图像/视频/音频生成；支持 MCP，外部 Coding 工具也能驱动 LITTO。
- **剧本到分镜**：技能与团队（导演 / 编剧 / 审校）把小说或灵感拆成剧本、资产和分镜。
- **自带模型**：自由接入文本与媒体模型供应商（含自定义供应商与 ComfyUI 工作流），密钥由你自己保管。
- **本地优先**：项目与素材保存在你指定的工作目录。

## 从源码运行

要求：[Bun](https://bun.sh)（运行时）与 Node.js 20+（安装依赖时可用 npm）。

```sh
# 1) 安装依赖
#    注意：在部分网络环境下 `bun install` 会卡在 "Resolved, downloaded and extracted"。
#    此时可改用 npm（需要放宽 workspace 协议的 peer 依赖检查并跳过安装脚本）：
npm install --legacy-peer-deps --ignore-scripts
#    @vue-flow/core 需要应用仓库内的补丁：
patch -p1 -N -d node_modules/@vue-flow/core < patches/vueFlowCore.patch

# 2) 准备工作区目录（服务器模式下项目必须位于 data/workspaces 内）
mkdir -p data/workspaces/myProject

# 3) 启动服务端（http://localhost:3000）
cd apps/server && NODE_ENV=dev bun src/index.ts

# 4) 另开终端启动前端开发服务器（默认 http://localhost:5173，被占用时会自动换端口）
cd apps/web && npx vite
```

数据（设置、插件、工作区）默认保存在仓库的 `data/`，可用环境变量 `TOONFLOW_DATA_DIR` 指定其他位置。

MV 听歌识词可使用自托管 Speaches，无需用户提供商业 API Key。CPU/GPU 容器配置、环境变量与部署验收见 [MV 开源转写部署](docs/musicDeployment.md)。

默认启用邮箱验证码、Session 与租户隔离；`LITTO_AUTH=off` 为本地单用户模式。当前工作台的 BYOK 设置尚未接入云端加密凭据系统，部署状态与其他未满足项见 V3 核查表。

## 目录

| 路径 | 说明 |
| --- | --- |
| `apps/server` | 服务端（Bun + Express）：Agent、生成、工作区、MCP |
| `apps/web` | 前端（Vue 3 + Vite） |
| `packages/*` | 节点、工具、供应商适配、技能、国际化等 |
| `cloud/` | LITTO 云端能力原型（账号、积分账本、管理后台、连续性检查），迁移中 |
| `legacy/` | 早期基于 infinite-canvas 的 React 版本，仅供参考 |

## 致谢与许可（Attribution）

LITTO 基于开源项目 [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app)（MIT 许可，Copyright (c) 2026 HBAI-Ltd）构建。本仓库的 [LICENSE](./LICENSE) 保留了 Toonflow 的版权与许可声明，并追加 LITTO 贡献者的版权行。依赖项各自遵循其许可证。
