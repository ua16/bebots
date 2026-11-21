import type { AvatarShapeId } from "@bebots/domain";

export function circlePath(): string {
  return "M 50 6 A 44 44 0 1 1 49.9 6 Z";
}

export function squirclePath(): string {
  return [
    "M 22 8",
    "C 35 4 65 4 78 8",
    "C 92 14 96 35 96 50",
    "C 96 65 92 86 78 92",
    "C 65 96 35 96 22 92",
    "C 8 86 4 65 4 50",
    "C 4 35 8 14 22 8",
    "Z",
  ].join(" ");
}

/** 8-point star: alternate radii, quadratic through each tip for soft points. */
export function roundedStarPath(): string {
  const cx = 50;
  const cy = 50;
  const outer = 46;
  const inner = 26;
  const verts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 16; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 8;
    verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const start = mid(verts[verts.length - 1]!, verts[0]!);
  const parts = [`M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`];
  for (let i = 0; i < verts.length; i += 1) {
    const tip = verts[i]!;
    const nextMid = mid(tip, verts[(i + 1) % verts.length]!);
    parts.push(
      `Q ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} ${nextMid.x.toFixed(2)} ${nextMid.y.toFixed(2)}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

export function shapePath(shape: AvatarShapeId | string): string {
  switch (shape) {
    case "squircle":
      return squirclePath();
    case "rounded-star":
      return roundedStarPath();
    case "circle":
    default:
      return circlePath();
  }
}
