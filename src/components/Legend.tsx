import type { ReactElement } from "react";
import type { Look } from "../lib/types";

/* The same colour ramps as the shaders, as CSS gradients. */
const SPEED = "linear-gradient(90deg, #08212f 0%, #0abed7 40%, #bad70a 70%, #e6ff4c 88%, #ffffff 100%)";
const cp = (neutral: string) => `linear-gradient(90deg, #05386b 0%, #0abed7 27%, ${neutral} 54.5%, #f0a12b 77%, #f0592b 100%)`;

function Bar({ title, gradient, left, mid, right }: { title: string; gradient: string; left: string; mid?: string; right: string }) {
  return (
    <div className="legend-row">
      <div className="legend-title">{title}</div>
      <div className="legend-bar" style={{ background: gradient }} />
      <div className="legend-ends">
        <span>{left}</span>
        {mid && <span>{mid}</span>}
        <span>{right}</span>
      </div>
    </div>
  );
}

export function Legend({ look, speed, dark }: { look: Look; speed: number; dark: boolean }) {
  const rows: ReactElement[] = [];
  const top = Math.round(speed * 1.35);
  const showSpeed = (look.smoke && look.smokeColor === "speed") || look.slice === "speed";
  if (look.surface === "pressure" || look.slice === "pressure")
    rows.push(<Bar key="cp" title="Pressure (Cp)" gradient={cp(dark ? "#8f9294" : "#a7aaad")} left="−1.2 suction" mid="0" right="+1 pushing" />);
  if (showSpeed) rows.push(<Bar key="speed" title="Air speed" gradient={SPEED} left="Still" right={`${top} km/h`} />);
  if (look.slice === "vorticity") rows.push(<Bar key="swirl" title="Swirl" gradient="linear-gradient(90deg, transparent 0%, #0abed7 25%, #bad70a 60%, #ffffff 100%)" left="Calm" right="Spinning" />);
  if (!rows.length) return null;
  return <div className="legend">{rows}</div>;
}
