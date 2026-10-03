// FilmFlow domain nodes for the infinite canvas.
// Canvas nodes are *views*: they store only { ffProjectId, ffKind, ffId }. World / Look / Asset / Shot / State / Take live in the FilmFlow server's domain tables.
import { definePlugin } from "@infinite-canvas/plugin-sdk";
import { nodes } from "./nodes";

export default definePlugin({
    id: "filmflow",
    name: "FilmFlow 领域节点",
    version: "1.1.0",
    description: "把 FilmFlow 的 World / Look / 资产 / 镜头作为领域节点接入画布：连线即语义，面板里生成关键帧、设 Hero、批准 Take。",
    nodes,
});
