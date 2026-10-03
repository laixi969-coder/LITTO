import { useEffect, useRef, useState } from "react";

import { api, mediaSrc } from "@/services/api/litto";
import type { Edit } from "./use-edit";

/** Preview of the video clip under the playhead (real video via <video>, stills/SVG via <img>). Audio tracks are mixed only at render time. */
export function Preview({ edit, t, playing }: { edit: Edit; t: number; playing: boolean }) {
    const [urls, setUrls] = useState<Record<string, { url: string; mime: string } | null>>({});
    const ref = useRef<HTMLVideoElement>(null);
    const vtracks = new Set(edit.tracks.filter((x) => x.kind === "video" && !x.muted).map((x) => x.id));
    // top-most video track wins
    const order = edit.tracks.filter((x) => x.kind === "video").map((x) => x.id);
    const here = edit.clips.filter((c) => vtracks.has(c.trackId) && t >= c.start && t < c.start + c.duration).sort((a, b) => order.indexOf(b.trackId) - order.indexOf(a.trackId))[0];
    const mid = here?.source.mediaId ?? null;
    useEffect(() => {
        if (!mid || mid in urls) return;
        api.get(`/media/${mid}`).then((m) => setUrls((u) => ({ ...u, [mid]: { url: m.proxyUrl ?? m.url, mime: m.mime } }))).catch(() => setUrls((u) => ({ ...u, [mid]: null })));
    }, [mid]);
    const src = mid ? urls[mid] : null;
    const local = here ? here.in + (t - here.start) * here.speed : 0;
    useEffect(() => { const v = ref.current; if (v && here && Math.abs(v.currentTime - local) > 0.25) v.currentTime = local; }, [local, here?.id]);
    useEffect(() => { const v = ref.current; if (v) v.playbackRate = here?.speed ?? 1; }, [here?.speed]);
    useEffect(() => { const v = ref.current; if (!v) return; if (playing) void v.play().catch(() => {}); else v.pause(); }, [playing, here?.id, src]);
    if (!here) return <div className="flex aspect-video items-center justify-center rounded bg-black text-xs text-white/50">黑场（无视频片段）</div>;
    if (!src) return <div className="flex aspect-video items-center justify-center rounded bg-black text-xs text-white/60">{here.source.kind === "missing" ? "该镜头还没有已批准的 Take" : "加载中…"}</div>;
    return src.mime.startsWith("video/")
        ? <video key={here.id} ref={ref} src={mediaSrc(src.url)} className="aspect-video w-full rounded bg-black" muted playsInline preload="auto" />
        : <img src={mediaSrc(src.url)} className="aspect-video w-full rounded bg-black object-contain" alt="" draggable={false} />;
}
