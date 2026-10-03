import { useEffect, useRef } from "react";

export type PanoView = { yaw: number; pitch: number; fov: number };

const VS = "attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}";
// Fullscreen quad: each pixel becomes a ray, rotated by pitch then yaw, sampled from the equirect texture (yaw 0 = image centre, + = right).
const FS = `precision highp float;varying vec2 v;uniform sampler2D t;uniform float yaw,pitch,fov,asp;
void main(){float f=tan(radians(fov)*.5);vec3 d=normalize(vec3(v.x*f*asp,v.y*f,1.));
float cp=cos(pitch),sp=sin(pitch);d=vec3(d.x,d.y*cp+d.z*sp,-d.y*sp+d.z*cp);
float cy=cos(yaw),sy=sin(yaw);d=vec3(d.x*cy+d.z*sy,d.y,-d.x*sy+d.z*cy);
float lon=atan(d.x,d.z),lat=asin(clamp(d.y,-1.,1.));
gl_FragColor=texture2D(t,vec2(.5+lon/6.2831853,.5-lat/3.1415927));}`;

/** Lightweight WebGL equirectangular 360° viewer: drag to look around, wheel to zoom. No dependencies. */
export function PanoViewer({ src, view, onChange, className = "" }: { src: string; view: PanoView; onChange: (v: PanoView) => void; className?: string }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const state = useRef(view);
    const draw = useRef<() => void>(() => {});
    state.current = view;

    useEffect(() => {
        const c = canvas.current!;
        const gl = c.getContext("webgl");
        if (!gl) return;
        const sh = (type: number, code: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, code); gl.compileShader(s); return s; };
        const prog = gl.createProgram()!;
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 40, 40, 255]));
        const u = (n: string) => gl.getUniformLocation(prog, n);
        const render = () => {
            const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
            c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr); gl.viewport(0, 0, c.width, c.height);
            const s = state.current;
            gl.uniform1f(u("yaw"), (s.yaw * Math.PI) / 180); gl.uniform1f(u("pitch"), (s.pitch * Math.PI) / 180); gl.uniform1f(u("fov"), s.fov); gl.uniform1f(u("asp"), c.width / c.height);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        };
        draw.current = render;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            // equirect images are rarely power-of-two: clamp + linear (no mipmaps) is valid in WebGL1
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            render();
        };
        img.src = src;
        const ro = new ResizeObserver(render); ro.observe(c);
        return () => { ro.disconnect(); draw.current = () => {}; };
    }, [src]);
    useEffect(() => draw.current(), [view.yaw, view.pitch, view.fov]);

    const drag = useRef<null | { x: number; y: number }>(null);
    const norm = (y: number) => ((((y + 180) % 360) + 360) % 360) - 180;
    return (
        <canvas ref={canvas} className={`block w-full cursor-grab touch-none rounded bg-black/10 active:cursor-grabbing ${className}`} style={{ aspectRatio: "16/9" }}
            onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => {
                if (!drag.current) return;
                const k = state.current.fov / e.currentTarget.clientHeight; // degrees per pixel
                const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
                drag.current = { x: e.clientX, y: e.clientY };
                onChange({ ...state.current, yaw: Math.round(norm(state.current.yaw - dx * k * 1.2) * 10) / 10, pitch: Math.round(Math.max(-90, Math.min(90, state.current.pitch + dy * k)) * 10) / 10 });
            }}
            onPointerUp={() => (drag.current = null)}
            onWheel={(e) => onChange({ ...state.current, fov: Math.round(Math.max(10, Math.min(140, state.current.fov + e.deltaY * 0.05))) })} />
    );
}
