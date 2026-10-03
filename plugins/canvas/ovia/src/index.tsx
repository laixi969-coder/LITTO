// OVIA domain nodes for the infinite canvas.
// Canvas nodes are *views*: they store only { oviaProjectId, oviaKind, oviaId }. World / Look / Asset / Shot / State / Take live in the OVIA server's domain tables.
import { definePlugin } from "@infinite-canvas/plugin-sdk";
import { nodes } from "./nodes";

export default definePlugin({
    id: "ovia",
    name: "OVIA 领域节点",
    version: "1.1.0",
    description: "把 OVIA 的 World / Look / 资产 / 镜头作为领域节点接入画布：连线即语义，面板里生成关键帧、设 Hero、批准 Take。",
    nodes,
});
