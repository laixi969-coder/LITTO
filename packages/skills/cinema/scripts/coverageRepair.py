#!/usr/bin/env python3
"""覆盖不足的后期补救：不重生成，把画外说话人的已有素材插回去，声音保持原轨。

剪辑表 JSON：
{
  "master": "原片.mp4",
  "cuts": [
    {"from": "替补.mp4", "in": 0.0, "out": 1.9},
    {"from": "原片.mp4", "in": 1.9, "out": 5.9}
  ]
}
每段按顺序铺满整条片；画面按 cuts 重排，音轨整条用 master 的。
"""
import json, subprocess, sys

FF = "/Users/caiwenbin/LITTO/data/ffmpeg/darwin-arm64/ffmpeg"


def build(spec_path, out_path, cwd=None):
    spec = json.load(open(spec_path))
    master = spec["master"]
    cuts = spec["cuts"]
    args = [FF, "-y", "-v", "error"]
    for c in cuts:
        args += ["-ss", str(c["in"]), "-t", str(round(c["out"] - c["in"], 3)), "-i", c["from"]]
    args += ["-i", master]
    audio_index = len(cuts)
    chains = []
    labels = []
    for i in range(len(cuts)):
        chains.append(f"[{i}:v]fps=24,scale=2560:1440,setsar=1,format=yuv420p[v{i}]")
        labels.append(f"[v{i}]")
    chains.append(f"{''.join(labels)}concat=n={len(cuts)}:v=1:a=0[vout]")
    chains.append(f"[{audio_index}:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
    args += ["-filter_complex", ";".join(chains), "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_path]
    print("segments", len(cuts), "->", out_path)
    subprocess.run(args, check=True, cwd=cwd)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
