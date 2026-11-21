import { useMemo } from "react";
import rough from "roughjs/bundled/rough.esm.js";
import {
  avatarCssColor,
  hashBotId,
  resolveBotAvatar,
  type AvatarShapeId,
  type BotAvatar as BotAvatarModel,
} from "@bebots/domain";
import { AVATAR_FACE_PATHS } from "./bot-avatar-faces";
import { shapePath } from "./bot-avatar-shapes";

const UNASSIGNED_FILL = "#5A5A5A";
const generator = rough.generator();

type RoughPath = { d: string; stroke: string; strokeWidth: number; fill?: string };

function roughShapePaths(shape: AvatarShapeId, fill: string, seed: number): readonly RoughPath[] {
  const d = shapePath(shape);
  const drawable = generator.path(d, {
    seed,
    fill,
    fillStyle: "solid",
    stroke: fill,
    strokeWidth: 1.25,
    roughness: 1.15,
    bowing: 0.9,
  });
  return generator.toPaths(drawable) as RoughPath[];
}

/** Optical bump so dense black faces stay readable at tiny sizes. */
function faceScaleForSize(size: number): number {
  if (size <= 18) return 1.18;
  if (size <= 24) return 1.1;
  return 1;
}

export function BotAvatar({
  avatar,
  size,
  title,
}: {
  avatar: BotAvatarModel | null | undefined;
  size: number;
  title?: string | undefined;
}) {
  const resolved = resolveBotAvatar(avatar ?? null);

  const roughPaths = useMemo(() => {
    if (!resolved) return null;
    const fill = avatarCssColor(resolved.color);
    const seed = hashBotId(`${resolved.face}:${resolved.color}:${resolved.shape}`) || 1;
    return roughShapePaths(resolved.shape, fill, seed);
  }, [resolved]);

  const facePaths = resolved
    ? (AVATAR_FACE_PATHS[resolved.face] ?? AVATAR_FACE_PATHS["face-0"]!)
    : null;
  const faceScale = faceScaleForSize(size);

  return (
    <span
      className="bot-avatar"
      style={{ width: size, height: size }}
      title={title}
      aria-hidden={title === undefined ? true : undefined}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible">
        {!resolved ? (
          <circle cx={50} cy={50} r={44} fill={UNASSIGNED_FILL} />
        ) : (
          <>
            <g className="bot-avatar-shape">
              {roughPaths?.map((p, i) => (
                <path
                  key={i}
                  d={p.d}
                  fill={p.fill && p.fill !== "none" ? p.fill : "none"}
                  stroke={p.stroke === "none" ? "none" : p.stroke}
                  strokeWidth={p.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
            <g
              className="bot-avatar-face"
              transform={`translate(50 50) scale(${faceScale}) translate(-50 -50)`}
            >
              {facePaths?.map((d, i) => (
                <path key={i} d={d} fill="#000000" />
              ))}
            </g>
          </>
        )}
      </svg>
    </span>
  );
}
