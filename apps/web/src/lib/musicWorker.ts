import MusicTempo from "music-tempo";
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";
import * as tf from "@tensorflow/tfjs";
import modelJson from "@spotify/basic-pitch/model/model.json";
import weightsUrl from "@spotify/basic-pitch/model/group1-shard1of1.bin?url";
import type { MusicAnalysis } from "./musicAnalysis";

self.onmessage = async (event: MessageEvent<{ rhythm: Float32Array; pitch: Float32Array }>) => {
  const { rhythm, pitch } = event.data;
  const duration = rhythm.length / 44100;
  const result: MusicAnalysis = { duration, bpm: null, beats: [], energy: [], melody: [], warnings: [] };
  const round = (value: number) => Math.round(value * 1000) / 1000;
  try {
    self.postMessage({ progress: "正在检测节拍与能量…" });
    for (let start = 0; start < rhythm.length; start += 11025) {
      let sum = 0;
      const end = Math.min(start + 11025, rhythm.length);
      for (let i = start; i < end; i++) sum += rhythm[i]! ** 2;
      result.energy.push(round(Math.sqrt(sum / (end - start))));
    }
    if (Math.max(...result.energy) < 0.001) throw new Error("音频接近静音，无法可靠识别旋律与节拍");
    try {
      const tempo = new MusicTempo(rhythm);
      result.beats = tempo.beats.filter(time => Number.isFinite(time) && time >= 0 && time < duration).map(round);
      result.bpm = Number.isFinite(Number(tempo.tempo)) ? round(Number(tempo.tempo)) : null;
      if (result.beats.length < 2) throw new Error("节拍不足");
    } catch {
      result.beats = []; result.bpm = null;
      result.warnings.push("未检测到稳定节拍，不能生成自动卡点；可使用歌词时间码。");
    }
    self.postMessage({ progress: "正在加载本地旋律模型…" });
    await tf.setBackend("cpu");
    const response = await fetch(weightsUrl);
    if (!response.ok) throw new Error("旋律模型加载失败");
    const model = await tf.loadGraphModel({ load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs: modelJson.weightsManifest.flatMap(item => item.weights) as tf.io.WeightsManifestEntry[],
      weightData: await response.arrayBuffer(),
    }) });
    try {
      const basicPitch = new BasicPitch(Promise.resolve(model));
      // ACT: 每 20 秒独立推理，首尾加 1 秒上下文；每 250ms 取最强音符作为旋律候选，混音中不保证是主唱。
      // 不保存整曲神经网络张量，10 分钟上限下内存按单块约束；将来有分轨模型再替换候选选择。
      for (let start = 0; start < duration; start += 20) {
        const from = Math.max(0, start - 1), to = Math.min(duration, start + 21);
        const frames: number[][] = [], onsets: number[][] = [];
        tf.engine().startScope();
        try {
          await basicPitch.evaluateModel(pitch.subarray(Math.floor(from * 22050), Math.ceil(to * 22050)),
            (nextFrames, nextOnsets) => { frames.push(...nextFrames); onsets.push(...nextOnsets); },
            fraction => self.postMessage({ progress: `正在识别旋律 ${Math.min(99, Math.round((start + fraction * 20) / duration * 100))}%` }));
          const notes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
          for (let time = start; time < Math.min(start + 20, duration); time += 0.25) {
            const active = notes.filter(note => note.startTimeSeconds + from <= time && note.startTimeSeconds + from + note.durationSeconds > time)
              .sort((a, b) => b.amplitude - a.amplitude)[0];
            if (active) result.melody.push([round(time), active.pitchMidi, round(active.amplitude)]);
          }
        } finally { tf.engine().endScope(); }
      }
    } finally { model.dispose(); }
    if (!result.melody.length) result.warnings.push("未检测到可靠音符；强伴奏、打击乐或噪声可能影响旋律识别。");
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "音乐分析失败" });
  }
};
