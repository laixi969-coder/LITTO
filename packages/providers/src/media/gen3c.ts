const rules = [
  { type: "input", field: "baseUrl" as const, title: "GEN3C 专用服务地址", value: "http://127.0.0.1:8000", props: { placeholder: "http://127.0.0.1:8000" } },
] as const;

function encodeArray(values: number[], shape: number[], integer = false) {
  const data = Buffer.alloc(values.length * (integer ? 4 : 8));
  values.forEach((value, i) => integer ? data.writeInt32LE(value, i * 4) : data.writeDoubleLE(value, i * 8));
  return { __gen3c_type__: "ndarray", dtype: integer ? "<i4" : "<f8", shape, value: data.toString("base64") };
}

function decodeArray(value: any, shape: number[]): number[] {
  if (value?.__gen3c_type__ !== "ndarray" || JSON.stringify(value.shape) !== JSON.stringify(shape) || !["<f8", "<f4", "<i4", "<i8"].includes(value.dtype) || typeof value.value !== "string" || value.value.length > 4096) throw new Error("GEN3C 返回的相机数组无效");
  const data = Buffer.from(value.value, "base64");
  const width = value.dtype.endsWith("8") ? 8 : 4;
  const count = shape.reduce((a, b) => a * b, 1);
  if (data.length !== count * width) throw new Error("GEN3C 相机数组字节数错误");
  const result = Array.from({ length: count }, (_, i) => value.dtype === "<f8" ? data.readDoubleLE(i * width) : value.dtype === "<f4" ? data.readFloatLE(i * width) : value.dtype === "<i4" ? data.readInt32LE(i * width) : Number(data.readBigInt64LE(i * width)));
  if (result.some(n => !Number.isFinite(n))) throw new Error("GEN3C 相机数组包含非有限值");
  return result;
}

function isRigidPose(pose: number[]) {
  if (pose.length !== 12 || pose.some(n => !Number.isFinite(n) || Math.abs(n) > 10000)) return false;
  const dot = (a: number, b: number) => [0, 1, 2].reduce((sum, i) => sum + pose[a * 4 + i]! * pose[b * 4 + i]!, 0);
  const determinant = pose[0]! * (pose[5]! * pose[10]! - pose[6]! * pose[9]!) - pose[1]! * (pose[4]! * pose[10]! - pose[6]! * pose[8]!) + pose[2]! * (pose[4]! * pose[9]! - pose[5]! * pose[8]!);
  return [0, 1, 2].every(a => [0, 1, 2].every(b => Math.abs(dot(a, b) - Number(a === b)) < 0.001)) && Math.abs(determinant - 1) < 0.001;
}

async function readJson(response: Response, limit: number): Promise<any> {
  if (!response.ok || !response.body) throw new Error(`GEN3C 请求失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new Error("GEN3C 响应超过大小限制");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

export default {
  id: "gen3c", label: "GEN3C · 数值相机轨迹", version: "1.0.0",
  readme: "连接官方 GEN3C JSON API（db2ffe12ced12ddafcec5e0422ee46ce8520746b）。专用单客户端 GPU 服务，PNG 1280×704 首帧，24fps、121帧单镜头；只接收图像与相机轨迹，不执行逐请求文本或音频指导。必须显式设置 imageAndCameraOnly。取消或异常后服务可能仍在运行，须同时重启 GEN3C 与 LITTO 才可重新使用此端点。部署、尺度校准和限制见 docs/masterShotsIntegration.md。",
  rules,
  models: [{ id: "gen3c", label: "GEN3C · 121帧轨迹生成", type: "video", mode: ["singleImage"], audio: false, durationResolutionMap: [{ duration: [5.041666666666667], resolution: ["1280x704"] }], cameraTrajectory: true, promptControl: "imageAndCameraOnly" }] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const trajectory = request.cameraTrajectory;
    if (request.model !== "gen3c" || !trajectory || trajectory.version !== 1 || trajectory.coordinateSystem !== "opencvRelative" || trajectory.fps !== 24 || trajectory.frames.length !== 121 || request.imageAndCameraOnly !== true) throw new Error("GEN3C 需要 121 帧、24fps 的相对相机轨迹和 imageAndCameraOnly:true");
    if (!Number.isFinite(trajectory.translationScale) || trajectory.translationScale <= 0 || trajectory.translationScale > 100 || trajectory.frames.some(frame => !isRigidPose(frame.pose) || !Number.isFinite(frame.fov) || frame.fov < 10 || frame.fov > 120) || trajectory.frames[0]!.pose.some((n, i) => Math.abs(n - ([0, 5, 10].includes(i) ? 1 : 0)) > 0.0001)) throw new Error("GEN3C 轨迹包含无效位姿、FOV 或尺度");
    if (request.mode !== "singleImage" || !request.firstFrame || request.images?.length || request.videos?.length || request.audios?.length || request.lastFrame || request.generateAudio || request.watermark) throw new Error("GEN3C 只接受一个首帧，不支持其他参考、声音或水印");
    if (request.duration !== undefined && Math.abs(request.duration - 121 / 24) > 0.000001 || request.resolution && request.resolution !== "1280x704" || request.ratio && request.ratio !== "20:11") throw new Error("GEN3C 输出固定为 121/24 秒、1280×704（20:11）");
    const input = request.firstFrame;
    if (input.type === "url" || input.mimeType !== "image/png") throw new Error("GEN3C 首帧须为工作区 PNG");
    const png = input.type === "binary" ? Buffer.from(input.data) : Buffer.from(input.data.replace(/^data:image\/png;base64,/, ""), "base64");
    if (png.length < 33 || png.length > 20 * 1024 * 1024 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(16) !== 1280 || png.readUInt32BE(20) !== 704) throw new Error("请先将首帧裁切/导出为 1280×704 PNG，并重新核对构图");
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("GEN3C 地址必须是无凭据和查询参数的 HTTP 地址");
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(1800000)]) : AbortSignal.timeout(1800000);
    const metadata = await readJson(await this.tool.fetch(`${baseUrl}/metadata`, { signal }), 65536);
    if (metadata.model_name !== "CosmosModel" || metadata.default_framerate !== 24 || metadata.min_frames_per_request > 121 || metadata.max_frames_per_request < 121 || !metadata.inference_resolution?.some((size: number[]) => size[0] === 1280 && size[1] === 704)) throw new Error("GEN3C 服务规格不兼容，请检查官方 JSON API 与模型配置");
    const post = async (path: string, type: string, fields: object, limit: number) => readJson(await this.tool.fetch(`${baseUrl}/${path}`, { method: "POST", headers: { "Content-Type": "application/vnd.gen3c.api+json" }, body: JSON.stringify({ type, fields }), signal }), limit);
    const seedId = crypto.randomUUID();
    const firstFocal = 352 / Math.tan(trajectory.frames[0]!.fov * Math.PI / 360);
    const seed = await post("seed-model", "CompressedSeedingRequest", {
      request_id: seedId, cameras_to_world: encodeArray([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [1, 3, 4]),
      focal_lengths: encodeArray([firstFocal, firstFocal], [1, 2]), principal_points: encodeArray([0.5, 0.5], [1, 2]), resolutions: encodeArray([1280, 704], [1, 2], true),
      images: null, depths: null, masks: null, images_compressed: [{ __gen3c_type__: "bytes", value: png.toString("base64") }],
      images_format: { __gen3c_type__: "enum", enum: "CompressionFormat", value: "png" }, depths_compressed: null, depths_format: null, masks_compressed: null, masks_format: null,
    }, 32 * 1024 * 1024);
    if (seed.type !== "SeedingResult" || seed.fields?.request_id !== seedId) throw new Error("GEN3C 首帧任务不匹配");
    const origin = decodeArray(seed.fields.cameras_to_world, [1, 3, 4]);
    if (!isRigidPose(origin)) throw new Error("GEN3C 返回的种子相机不是有效刚体变换");
    const focal = decodeArray(seed.fields.focal_lengths, [1, 2]);
    const principal = decodeArray(seed.fields.principal_points, [1, 2]);
    const resolution = decodeArray(seed.fields.resolutions, [1, 2]);
    if (focal.some(n => n <= 0) || principal.some(n => n < 0 || n > 1) || resolution[0] !== 1280 || resolution[1] !== 704) throw new Error("GEN3C 改变了种子图规格，请重新校准相机");
    // 相对初始相机的轨迹重定位到服务估计的种子相机；尺度必须由用户校准。
    const poses = trajectory.frames.flatMap(frame => Array.from({ length: 12 }, (_, i) => {
      const row = Math.floor(i / 4), column = i % 4;
      const value = [0, 1, 2].reduce((sum, k) => sum + origin[row * 4 + k]! * frame.pose[k * 4 + column]!, 0);
      return column === 3 ? value * trajectory.translationScale + origin[row * 4 + 3]! : value;
    }));
    const focals = trajectory.frames.flatMap(frame => {
      const ratio = Math.tan(trajectory.frames[0]!.fov * Math.PI / 360) / Math.tan(frame.fov * Math.PI / 360);
      return focal.map(n => n * ratio);
    });
    const requestId = crypto.randomUUID();
    const result = await post("request-inference?sync=1", "InferenceRequest", {
      request_id: requestId, cameras_to_world: encodeArray(poses, [121, 3, 4]), focal_lengths: encodeArray(focals, [121, 2]),
      principal_points: encodeArray(trajectory.frames.flatMap(() => principal), [121, 2]), resolutions: encodeArray(trajectory.frames.flatMap(() => [1280, 704]), [121, 2], true),
      timestamps: encodeArray(trajectory.frames.map((_, i) => i / 24), [121]), framerate: 24, return_depths: false, video_encoding_quality: 8, show_cache_renderings: false,
    }, 140 * 1024 * 1024);
    const output = result.fields;
    if (result.type !== "CompressedInferenceResult" || output?.request_id !== requestId || output.images_format?.value !== "mp4" || output.images_compressed?.length !== 1 || output.images_compressed[0]?.__gen3c_type__ !== "bytes" || typeof output.images_compressed[0]?.value !== "string") throw new Error("GEN3C 没有返回本任务的 MP4");
    if (JSON.stringify(output.resolutions?.shape) !== "[121,2]") throw new Error("GEN3C 返回的帧数不同于请求，请检查服务配置");
    if (decodeArray(output.resolutions, [121, 2]).some((value, index) => value !== (index % 2 ? 704 : 1280))) throw new Error("GEN3C 返回的画面尺寸不同于请求");
    const video = Buffer.from(output.images_compressed[0].value, "base64");
    if (video.length < 12 || video.length > 100 * 1024 * 1024 || video.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error("GEN3C 视频为空、格式错误或超过 100 MB");
    return [{ type: "binary", data: video, mimeType: "video/mp4", mediaType: "video" }];
  },
} satisfies ProviderDefinition<typeof rules>;
