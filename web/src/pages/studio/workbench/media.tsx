import { mediaSrc } from "@/services/api/ovia";

/** Keyframes/takes from real providers are png/mp4; the offline mock renders SVG (animated for takes) — <img> handles both. */
export function Media({ media, className = "", controls }: { media?: { url: string; mime: string } | null; className?: string; controls?: boolean }) {
    if (!media) return <div className={`flex items-center justify-center bg-black/5 text-xs opacity-50 dark:bg-white/5 ${className}`}>无</div>;
    if (media.mime.startsWith("video/")) return <video src={mediaSrc(media.url)} className={className} controls={controls} muted loop autoPlay playsInline />;
    return <img src={mediaSrc(media.url)} className={`object-cover ${className}`} alt="" draggable={false} />;
}
