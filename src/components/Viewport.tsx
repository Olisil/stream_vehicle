import { useEffect, useRef } from "react";
import type { Engine } from "../lib/engine";
import { FOV, type Orbit } from "../lib/render/camera";

/**
 * The 3D view: a canvas the engine draws into, with orbit (left drag), pan (right or middle
 * drag, or Shift+drag), zoom (wheel or pinch) and double-click to go back to the 3D view.
 */
export function Viewport(props: {
  engine: Engine | null;
  orbit: Orbit;
  onOrbit: (o: Orbit, done: boolean) => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const orbitRef = useRef(props.orbit);
  orbitRef.current = props.orbit;
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const engine = props.engine;
    const canvas = ref.current;
    if (!engine || !canvas) return;
    engine.attach(canvas);
    const ro = new ResizeObserver(() => engine.invalidate());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      engine.detach();
    };
  }, [props.engine]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "orbit" | "pan" | null = null;
    let pinch: { d: number; cx: number; cy: number } | null = null;

    const pan = (dx: number, dy: number, o: Orbit): Orbit => {
      const y = (o.yaw * Math.PI) / 180;
      const p = (o.pitch * Math.PI) / 180;
      // camera right and up in world space
      const right = [-Math.sin(y), Math.cos(y), 0];
      const fwd = [-Math.cos(p) * Math.cos(y), -Math.cos(p) * Math.sin(y), -Math.sin(p)];
      const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
      const s = (2 * o.distance * Math.tan(FOV / 2)) / Math.max(1, canvas.clientHeight);
      return {
        ...o,
        target: [o.target[0] - (right[0] * dx - up[0] * dy) * s, o.target[1] - (right[1] * dx - up[1] * dy) * s, o.target[2] - (right[2] * dx - up[2] * dy) * s],
      };
    };

    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) mode = e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "orbit";
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        mode = null;
      }
      if (e.button === 1) e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      let o = orbitRef.current;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        o = { ...o, distance: Math.max(2, (o.distance * pinch.d) / Math.max(1, d)) };
        o = pan(cx - pinch.cx, cy - pinch.cy, o);
        pinch = { d, cx, cy };
      } else if (mode === "orbit") {
        o = { ...o, yaw: o.yaw - dx * 0.35, pitch: Math.max(-85, Math.min(89, o.pitch + dy * 0.3)) };
      } else if (mode === "pan") {
        o = pan(dx, dy, o);
      } else return;
      orbitRef.current = o;
      cb.current.onOrbit(o, false);
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        mode = null;
        cb.current.onOrbit(orbitRef.current, true);
      }
    };
    let wheelTimer = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const o = orbitRef.current;
      const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY) * 0.0012);
      const n = { ...o, distance: Math.max(2, Math.min(5000, o.distance * k)) };
      orbitRef.current = n;
      cb.current.onOrbit(n, false);
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => cb.current.onOrbit(orbitRef.current, true), 250);
    };
    const menu = (e: Event) => e.preventDefault();
    const dbl = () => cb.current.onReset();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("contextmenu", menu);
    canvas.addEventListener("dblclick", dbl);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("contextmenu", menu);
      canvas.removeEventListener("dblclick", dbl);
      clearTimeout(wheelTimer);
    };
  }, []);

  return <canvas ref={ref} className="tunnel-canvas" aria-label="Wind tunnel view. Drag to turn, right-drag to move, scroll to zoom." />;
}
