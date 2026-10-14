import { nextTick, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import axios from "axios";
import { ElMessage } from "element-plus";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { useWorkspaceStore } from "@/stores/workspace";
import { nextCanvasPosition } from "./arrangeCanvas";

type Lineage = {
  id: string;
  label?: string;
  kind: "image" | "video" | "audio";
  request: Record<string, unknown>;
  outputPaths: string[];
  referencePaths: string[];
  mimeTypes?: Record<string, string>;
};
type MediaJob = { id: string; label?: string; kind: Lineage["kind"]; status: string; inputRefs?: { sent?: boolean; mediaId?: string }[]; parameters?: { directory?: string; fingerprint?: string; request?: Record<string, unknown> }; outputs: string[]; files: { path: string; mimeType: string }[] };
type LineageSnapshot = { records: Lineage[]; mediaPaths: Record<string, string> };
type CanvasFlow = ReturnType<typeof useVueFlow>;
const active = new Map<string, () => void>();

export function applyCanvasLineage(flow: CanvasFlow, records: Lineage[]) {
  for (const edge of flow.edges.value) if (edge.data?.lineageKind || edge.type === "simple-bezier") edge.type = "default";
  const pathOf = (node: CanvasFlow["nodes"]["value"][number]) => node.data.sourcePath ?? Object.values(node.data.outputs ?? {}).map((output: any) => output?.value?.url).find(Boolean);
  let addedNodes = 0;
  let addedEdges = 0;
  for (const record of records) {
    for (const path of record.outputPaths) {
      let result = flow.nodes.value.find(node => node.type === `remote-${record.kind}Node` && pathOf(node) === path);
      const originId = path.split("/")[1];
      let generator = flow.nodes.value.find(node => node.type === `remote-${record.kind}GenerationNode` && node.data.generationLineage?.id === record.id)
        ?? flow.nodes.value.find(node => node.id === originId && node.type === `remote-${record.kind}GenerationNode`);
      if (!result && !generator && !flow.nodes.value.some(node => pathOf(node) === path)) continue;
      if (!result) {
        const existing = flow.nodes.value.find(node => pathOf(node) === path);
        const position = nextCanvasPosition(flow);
        const mimeType = record.mimeTypes?.[path] ?? (record.kind === "image" ? "image/png" : record.kind === "video" ? "video/mp4" : "audio/mpeg");
        const id = `result${record.id}${record.outputPaths.indexOf(path)}`;
        flow.addNodes({ id, type: `remote-${record.kind}Node`, position: { x: existing?.position.x ?? position.x + 460, y: existing ? existing.position.y + 260 : position.y }, data: { label: record.label ?? path.split("/").at(-1), sourcePath: path, outputs: { [record.kind]: { dataType: record.kind.toUpperCase(), value: { url: path, mimeType } } } } });
        result = flow.findNode(id)!;
        addedNodes++;
      }
      // ACT: 历史挂在结果上；仅清理未被编辑或手工连线的旧自动记录节点，不动真实生成节点。
      if (generator?.id === `generation${record.id}` && generator.data.label === `生成记录 · ${path.split("/").at(-1)}`
        && (!pathOf(generator) || pathOf(generator) === path)
        && Object.entries(record.request).every(([key, value]) => JSON.stringify(generator!.data[key]) === JSON.stringify(value))
        && !flow.edges.value.some(edge => (edge.source === generator!.id || edge.target === generator!.id) && !edge.data?.lineageKind)) {
        flow.removeNodes([generator.id]);
        generator = undefined;
      }
      if (record.label && (!result.data.label || result.data.label === path.split("/").at(-1) || result.data.label === result.data.lineageLabel || result.data.label === record.label)) {
        result.data.label = record.label;
        result.data.lineageLabel = record.label;
      }
      result.data.generationLineage = record;
      const connect = (source: string, target: string, kind: "reference" | "result") => {
        if (source === target || flow.edges.value.some(edge => edge.source === source && edge.target === target && (edge.data?.lineageKind === kind || kind === "reference"))) return;
        // ACT: 来源线只展示历史关系，不接入 in 端口，避免改变正在运行节点的输入和参考顺序。
        const sourceNode = flow.findNode(source)!;
        const sourceHandle = kind === "result" ? record.kind : Object.keys(sourceNode.data.outputs ?? {})[0];
        flow.addEdges({ id: `lineage${kind}${source}${target}`, source, target, sourceHandle, type: "default", label: kind === "reference" ? "参考素材" : "生成结果", updatable: false, data: { lineageKind: kind, generationId: record.id } });
        addedEdges++;
      };
      for (const referencePath of record.referencePaths) {
        const reference = flow.nodes.value.find(node => pathOf(node) === referencePath);
        if (reference) connect(reference.id, generator?.id ?? result.id, "reference");
      }
      if (generator) connect(generator.id, result.id, "result");
    }
  }
  return { addedNodes, addedEdges };
}

export function startCanvasLineage(flow: CanvasFlow) {
  active.get(flow.id)?.();
  const workspace = useWorkspaceStore();
  const boundDirectory = workspace.project?.directory;
  let busy = false;
  let again = false;
  let stopped = false;
  let loadedDirectory: string | undefined;
  let snapshot: LineageSnapshot = { records: [], mediaPaths: {} };
  const stop = watch(() => [workspace.project?.directory, workspace.project?.projectId, ...flow.nodes.value.map(node => `${node.id}:${node.data.sourcePath ?? JSON.stringify(node.data.outputs ?? {})}`)], async () => {
    if (busy) { again = true; return; }
    const project = workspace.project;
    if (stopped || !project?.projectId || !flow.nodes.value.length || boundDirectory && project.directory !== boundDirectory) return;
    busy = true;
    try {
      do {
        again = false;
        const files = useWorkspaceFiles(project.directory);
        if (loadedDirectory !== project.directory) {
          snapshot = await files.readJson<LineageSnapshot>(".agent/canvasLineage.json").catch(error => {
            if (axios.isAxiosError(error) && error.response?.status === 404) return { records: [], mediaPaths: {} };
            throw error;
          });
          loadedDirectory = project.directory;
        }
        const { data: jobs } = await axios.get<MediaJob[]>("/cloud/generations", { params: { projectId: project.projectId } });
        for (const job of jobs) for (const [index, output] of job.outputs.entries()) if (job.files[index]) snapshot.mediaPaths[output] = job.files[index]!.path;
        const completed = jobs.filter(job => job.status === "SUCCEEDED" && job.parameters?.directory === project.directory && job.files.length);
        let changed = false;
        for (const job of completed) {
          const request = job.parameters?.request ?? {};
          const references = [...(request.images as any[] ?? []), ...(request.videos as any[] ?? []), ...(request.audios as any[] ?? []), request.firstFrame, request.lastFrame].filter(Boolean).map((reference: any) => reference.path).filter((path: unknown): path is string => typeof path === "string");
          const referencePaths = [...new Set([...(job.inputRefs ?? []).filter(input => input.sent && input.mediaId).map(input => snapshot.mediaPaths[input.mediaId!]).filter(Boolean), ...references])];
          const saved = snapshot.records.find(record => record.id === job.id);
          if (saved) {
            if (job.label && saved.label !== job.label) { saved.label = job.label; changed = true; }
            const merged = [...new Set([...saved.referencePaths, ...referencePaths])];
            if (merged.length !== saved.referencePaths.length) { saved.referencePaths = merged; changed = true; }
          } else {
            snapshot.records.push({ id: job.id, label: job.label, kind: job.kind, request, outputPaths: job.files.map(file => file.path), mimeTypes: Object.fromEntries(job.files.map(file => [file.path, file.mimeType])), referencePaths });
            changed = true;
          }
        }
        if (stopped || workspace.project?.directory !== project.directory) break;
        applyCanvasLineage(flow, snapshot.records);
        if (changed) await files.writeJson(".agent/canvasLineage.json", snapshot);
        await nextTick();
      } while (again && !stopped && workspace.project?.directory === project.directory);
    } catch (error) {
      if (!stopped) ElMessage.error(`恢复生成来源失败：${error instanceof Error ? error.message : "读取失败"}`);
    } finally { busy = false; }
  }, { immediate: true, flush: "post" });
  const dispose = () => { stopped = true; stop(); active.delete(flow.id); };
  active.set(flow.id, dispose);
  return dispose;
}

export function restoreOpenCanvasLineage() {
  const seen = new Set<string>();
  const host = (window as typeof window & { toonflowNodeHost?: { vueFlow: { useVueFlow: typeof useVueFlow } } }).toonflowNodeHost;
  for (const element of document.querySelectorAll<HTMLElement>(".vue-flow__handle[data-id]")) {
    const suffix = `-${element.dataset.nodeid}-${element.dataset.handleid}-${element.classList.contains("source") ? "source" : "target"}`;
    const id = element.dataset.id?.slice(0, -suffix.length);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    active.get(id)?.();
    startCanvasLineage(host?.vueFlow.useVueFlow(id) ?? useVueFlow(id));
  }
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => { for (const stop of active.values()) stop(); });
  queueMicrotask(restoreOpenCanvasLineage);
}
