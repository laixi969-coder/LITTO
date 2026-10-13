import { nextTick, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import axios from "axios";
import { ElMessage } from "element-plus";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { useWorkspaceStore } from "@/stores/workspace";

type Lineage = {
  id: string;
  kind: "image" | "video" | "audio";
  request: Record<string, unknown>;
  outputPaths: string[];
  referencePaths: string[];
  mimeTypes?: Record<string, string>;
};
type MediaJob = { id: string; kind: Lineage["kind"]; status: string; parameters?: { directory?: string; fingerprint?: string; request?: Record<string, unknown> }; outputs: string[]; files: { path: string; mimeType: string }[] };
type LineageSnapshot = { records: Lineage[]; mediaPaths: Record<string, string> };
type CanvasFlow = ReturnType<typeof useVueFlow>;
const active = new Map<string, () => void>();

export function applyCanvasLineage(flow: CanvasFlow, records: Lineage[]) {
  for (const edge of flow.edges.value) if (edge.data?.lineageKind) edge.type = "default";
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
        const right = Math.max(0, ...flow.nodes.value.map(node => node.position.x + (node.dimensions.width || 400)));
        const mimeType = record.mimeTypes?.[path] ?? (record.kind === "image" ? "image/png" : record.kind === "video" ? "video/mp4" : "audio/mpeg");
        const id = `result${record.id}${record.outputPaths.indexOf(path)}`;
        flow.addNodes({ id, type: `remote-${record.kind}Node`, position: { x: existing?.position.x ?? right + 80, y: (existing?.position.y ?? 0) + 260 }, data: { label: path.split("/").at(-1), sourcePath: path, outputs: { [record.kind]: { dataType: record.kind.toUpperCase(), value: { url: path, mimeType } } } } });
        result = flow.findNode(id)!;
        addedNodes++;
      }
      if (!generator) {
        const id = `generation${record.id}`;
        const prompt = typeof record.request.prompt === "string" ? record.request.prompt : "";
        flow.addNodes({ id, type: `remote-${record.kind}GenerationNode`, position: { x: result.position.x - 460, y: result.position.y - 220 }, data: { ...record.request, label: `生成记录 · ${path.split("/").at(-1)}`, model: JSON.stringify([record.request.providerId, record.request.modelId]), prompt, promptModel: prompt.split("\n").map(text => [{ type: "Write", text }]), generationLineage: record } });
        generator = flow.findNode(id)!;
        addedNodes++;
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
        if (reference) connect(reference.id, generator.id, "reference");
      }
      connect(generator.id, result.id, "result");
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
        const unknown = jobs.filter(job => job.status === "SUCCEEDED" && job.parameters?.directory === project.directory && job.files.length && !snapshot.records.some(record => record.id === job.id));
        const compilations = new Map<string, string[]>();
        if (unknown.some(job => job.parameters?.fingerprint)) {
          const { entries } = await files.list(".agent/sessions");
          for (const entry of entries.filter(entry => entry.type === "file" && entry.name.endsWith(".jsonl"))) {
            for (const line of (await files.readText(entry.path)).split("\n").filter(Boolean)) {
              const event = JSON.parse(line);
              if (event.message?.role !== "toolResult" || event.message.toolName !== "productionSpec") continue;
              for (const part of event.message.content ?? []) {
                let value;
                try { value = JSON.parse(part.text ?? ""); } catch { continue; }
                if (typeof value.fingerprint !== "string" || !Array.isArray(value.compiled?.inputs)) continue;
                compilations.set(value.fingerprint, value.compiled.inputs.filter((input: any) => input.sent).map((input: any) => snapshot.mediaPaths[input.mediaId]).filter(Boolean));
              }
            }
          }
        }
        for (const job of unknown) {
          const request = job.parameters?.request ?? {};
          const references = [...(request.images as any[] ?? []), ...(request.videos as any[] ?? []), ...(request.audios as any[] ?? []), request.firstFrame, request.lastFrame].filter(Boolean).map((reference: any) => reference.path).filter((path: unknown): path is string => typeof path === "string");
          snapshot.records.push({ id: job.id, kind: job.kind, request, outputPaths: job.files.map(file => file.path), mimeTypes: Object.fromEntries(job.files.map(file => [file.path, file.mimeType])), referencePaths: [...new Set([...(compilations.get(job.parameters?.fingerprint ?? "") ?? []), ...references])] });
        }
        if (stopped || workspace.project?.directory !== project.directory) break;
        applyCanvasLineage(flow, snapshot.records);
        if (unknown.length) await files.writeJson(".agent/canvasLineage.json", snapshot);
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
