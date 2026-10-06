import { z } from "zod";
import { relative } from "node:path";
import { chainMethods, executeRemoteFfmpeg, queryMethods, runMethods } from "@toonflow/ffmpeg/remote";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.strictObject({});
const probeSchema = z.strictObject({
  path: z.string().min(1).describe("工作区媒体文件，相对路径或工作区内的绝对路径"),
  options: z.array(z.string()).optional().describe("原生 ffprobe 选项，按参数数组原样传递"),
});
const processSchema = z.strictObject({
  publishToCanvas: z.boolean().default(true).describe("成功输出的视频默认自动挂到当前画布供播放和下载；中间文件可设为 false"),
  options: z.strictObject({
    source: z.string().optional(),
    cwd: z.string().optional(),
    niceness: z.number().optional(),
    priority: z.number().optional(),
    stdoutLines: z.number().optional(),
    timeout: z.number().optional(),
  }).optional().describe("原生 fluent 构造选项；不设置固定超时"),
  steps: z.array(z.strictObject({
    method: z.enum(chainMethods),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional().describe("需要传 undefined 的参数位置，其他参数保持原值"),
  })).default([]).describe("按 fluent-ffmpeg 顺序配置，方法及其别名沿用宿主；选项、滤镜和文件序列原样传递"),
  operation: z.strictObject({
    method: z.enum([...runMethods, ...queryMethods]),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional(),
  }).default({ method: "run", args: [] }).describe("最后执行的方法，默认 run；也可 save、screenshots、concat 或查询编码器、格式、滤镜等"),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools(context) {
    async function execute(request: z.infer<typeof processSchema>, signal?: AbortSignal) {
      const canvasId = context.canvas?.id;
      const ffmpeg = await context.ffmpeg(signal);
      let details: unknown;
      let error: Error | undefined;
      let filenames: unknown;
      // ACT: 复用节点已有的 JSON 调用桥接，不在工具层重写参数、输出位置或原生执行规则。
      await executeRemoteFfmpeg(ffmpeg, {
        directory: context.cwd,
        requestId: crypto.randomUUID(),
        options: request.options ?? {},
        calls: request.steps,
        operation: request.operation,
      }, event => {
        if (event.event === "error") {
          const failure = event.args[0] as { message?: string };
          error = Object.assign(new Error(failure.message ?? "FFmpeg 执行失败"), failure);
          // ACT: 保留末尾 8 KB 原生诊断，避免完整媒体日志撑满对话上下文。
          const stderr = typeof event.args[2] === "string" ? event.args[2].trim().slice(-8000) : "";
          if (stderr) error.message += `\nFFmpeg 诊断：\n${stderr}`;
        } else if (event.event === "result") details = event.args[0];
        else if (event.event === "filenames") filenames = event.args[0];
        else if (event.event === "end") details = { stdout: event.args[0], stderr: event.args[1], ...(filenames ? { filenames } : {}) };
      }, signal ?? new AbortController().signal);
      signal?.throwIfAborted();
      if (error) throw error;
      if (request.publishToCanvas && context.canvas && runMethods.includes(request.operation.method as typeof runMethods[number])) {
        const paths = request.steps.filter(step => ["output", "addOutput"].includes(step.method)).map(step => step.args[0]);
        if (["save", "saveToFile", "mergeToFile", "concatenate", "concat"].includes(request.operation.method)) paths.push(request.operation.args[0]);
        const videos = [...new Set(paths.filter((path): path is string => typeof path === "string" && /\.(mp4|mov|webm|m4v|mkv)$/i.test(path)))];
        const published = [];
        for (const output of videos) {
          try {
            const absolute = await context.resolvePath(output);
            const path = relative(context.cwd, absolute).replaceAll("\\", "/");
            const stat = await context.files.stat(path);
            if (!stat.isFile() || !stat.size) throw new Error("输出视频不存在或为空");
            published.push({ path, result: await context.canvas.call({ name: "publishVideo", args: { path, canvasId } }, signal) });
          } catch (cause) {
            // 导出已成功：展示失败不能冒充渲染失败，避免 Agent 重渲染或覆盖文件。
            published.push({ path: output, error: `视频已导出，画布展示失败，请仅重试 publishVideo：${cause instanceof Error ? cause.message : String(cause)}` });
          }
        }
        details = { processing: details, published };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    return [{
      name: "ffprobe",
      label: "查询媒体信息",
      description: "使用本机 FFprobe 读取工作区媒体的格式、时长、尺寸、帧率和音轨等信息，支持原生探测选项。",
      parameters: z.toJSONSchema(probeSchema, { io: "input", target: "draft-07" }),
      execute(_id, params, signal) {
        const { path, options } = probeSchema.parse(params);
        return execute({ publishToCanvas: false, steps: [{ method: "input", args: [path] }], operation: { method: "ffprobe", args: options ? [options] : [] } }, signal);
      },
    }, {
      name: "ffmpeg",
      label: "处理媒体",
      description: "通过宿主 fluent-ffmpeg 处理工作区媒体。steps 原样传入链式方法及 args，支持全部宿主配置方法和别名、原始 inputOptions/outputOptions、复杂滤镜、多输入、多输出、文件序列及分片。operation 默认 run，也支持 save、screenshots、concat 和能力查询。不自动重命名输出、不限制执行时长；输出目录需已存在，文件覆盖遵循原生规则。",
      promptSnippet: "使用 ffmpeg 处理本地媒体，ffprobe 查询媒体信息；按用户要求选择输出位置，成功的视频自动挂到画布供播放与下载，published 返回节点或展示失败原因。",
      promptGuidelines: [
        '截帧示例：{"steps":[{"method":"input","args":["assets/input.mp4"]},{"method":"seekInput","args":[1]},{"method":"frames","args":[1]},{"method":"output","args":["assets/frame.png"]}]}。',
        'inputOptions/outputOptions 按 fluent 原生语法传参，不额外拆分空格。含空格的元数据使用 args:["-metadata","title=a b"]，不要再嵌套数组。先用 operation={"method":"availableEncoders","args":[]} 等查询实际能力，不猜测本机编码器。',
        "除非用户要求覆盖，否则使用新文件名；所有显式路径及参数、滤镜和媒体清单中引用的文件都应位于当前工作区。",
        "合成中间文件设置 publishToCanvas=false；最终视频沿用默认 true 自动展示到画布。读取 published 的结果，已有节点不要重复创建；展示失败仅调用 publishVideo 恢复，不重渲染。",
        '文字叠加、字幕烧录前先用 operation={"method":"availableFilters","args":[]} 确认 drawtext、subtitles 或 ass 是否可用。缺少滤镜时说明需要安装包含对应滤镜的 FFmpeg，不要反复试运行或用不存在的字幕文件探测。input 只接受工作区文件，不接受 color 等 lavfi 虚拟输入；滤镜验证复用已有素材。',
      ],
      parameters: z.toJSONSchema(processSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      execute(_id, params, signal) {
        return execute(processSchema.parse(params), signal);
      },
    }];
  },
};

export default plugin;
