export const AVATAR_FACES = ["face-0", "face-1", "face-2", "face-3"] as const;
export type AvatarFaceId = (typeof AVATAR_FACES)[number];

export const AVATAR_SHAPES = ["circle", "squircle", "rounded-star"] as const;
export type AvatarShapeId = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLOR_COUNT = 10;

export const AVATAR_SATURATION = 81;
export const AVATAR_LIGHTNESS = 56;

/** Hue endpoints on the long arc: index 0 = 354°, index 9 = 47°. */
export const AVATAR_HUE_START = 354;
export const AVATAR_HUE_END = 47;

/**
 * Legacy solid-dot palette (Figma). Kept so migration can map an old hashed
 * color to the nearest of the new 10 hues.
 */
export const LEGACY_BOT_COLORS: readonly string[] = [
  "#FF0000",
  "#1B73FF",
  "#E41BFF",
  "#63BE58",
  "#FF8800",
  "#00C2D8",
  "#FFD600",
  "#8C64FF",
];

/** Stored avatar. face/shape stay plain strings so unknown ids survive round-trips. */
export interface BotAvatar {
  readonly face: string;
  readonly color: number;
  readonly shape: string;
}

export interface KnownBotAvatar {
  readonly face: AvatarFaceId;
  readonly color: number;
  readonly shape: AvatarShapeId;
}

export function hashBotId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Long-arc step from 354° toward 47° (~307°, decreasing through magenta/blue/green),
 * equal across 10 indices — not the short 53° red/orange arc.
 */
export function avatarHue(index: number): number {
  const i = ((Math.floor(index) % AVATAR_COLOR_COUNT) + AVATAR_COLOR_COUNT) % AVATAR_COLOR_COUNT;
  const longArc = (AVATAR_HUE_START - AVATAR_HUE_END + 360) % 360;
  return (AVATAR_HUE_START - (longArc * i) / (AVATAR_COLOR_COUNT - 1) + 360) % 360;
}

export function avatarCssColor(index: number): string {
  const h = avatarHue(index);
  return `hsl(${h}, ${AVATAR_SATURATION}%, ${AVATAR_LIGHTNESS}%)`;
}

function clampColorIndex(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  if (n < 0) return 0;
  if (n >= AVATAR_COLOR_COUNT) return AVATAR_COLOR_COUNT - 1;
  return n;
}

function isKnownFace(face: string): face is AvatarFaceId {
  return (AVATAR_FACES as readonly string[]).includes(face);
}

function isKnownShape(shape: string): shape is AvatarShapeId {
  return (AVATAR_SHAPES as readonly string[]).includes(shape);
}

export function serializeBotAvatar(avatar: BotAvatar): string {
  return JSON.stringify({
    face: avatar.face,
    color: avatar.color,
    shape: avatar.shape,
  });
}

export function parseBotAvatar(value: string | null | undefined): BotAvatar | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.face !== "string" || typeof obj.shape !== "string") return null;
    if (typeof obj.color !== "number" || !Number.isFinite(obj.color)) return null;
    return { face: obj.face, color: Math.floor(obj.color), shape: obj.shape };
  } catch {
    return null;
  }
}

export type ValidatedBotAvatar =
  | { readonly valid: true; readonly value: KnownBotAvatar }
  | { readonly valid: false; readonly field: string; readonly message: string };

export function validateBotAvatar(value: unknown): ValidatedBotAvatar {
  if (value === null || typeof value !== "object") {
    return { valid: false, field: "avatar", message: "Avatar must be an object" };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.face !== "string" || !isKnownFace(obj.face)) {
    return { valid: false, field: "avatar.face", message: "Unknown avatar face" };
  }
  if (typeof obj.shape !== "string" || !isKnownShape(obj.shape)) {
    return { valid: false, field: "avatar.shape", message: "Unknown avatar shape" };
  }
  if (typeof obj.color !== "number" || !Number.isFinite(obj.color)) {
    return { valid: false, field: "avatar.color", message: "Avatar color must be a number" };
  }
  const color = Math.floor(obj.color);
  if (color < 0 || color >= AVATAR_COLOR_COUNT) {
    return {
      valid: false,
      field: "avatar.color",
      message: `Avatar color must be 0–${AVATAR_COLOR_COUNT - 1}`,
    };
  }
  return { valid: true, value: { face: obj.face, color, shape: obj.shape } };
}

export function resolveBotAvatar(avatar: BotAvatar | null | undefined): KnownBotAvatar | null {
  if (!avatar) return null;
  return {
    face: isKnownFace(avatar.face) ? avatar.face : AVATAR_FACES[0],
    color: clampColorIndex(avatar.color),
    shape: isKnownShape(avatar.shape) ? avatar.shape : AVATAR_SHAPES[0],
  };
}

export function avatarFromBotId(id: string): KnownBotAvatar {
  const h = hashBotId(id);
  return {
    face: AVATAR_FACES[h % AVATAR_FACES.length]!,
    color: h % AVATAR_COLOR_COUNT,
    shape: AVATAR_SHAPES[Math.floor(h / AVATAR_FACES.length) % AVATAR_SHAPES.length]!,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = hex.replace("#", "");
  return {
    r: Number.parseInt(n.slice(0, 2), 16),
    g: Number.parseInt(n.slice(2, 4), 16),
    b: Number.parseInt(n.slice(4, 6), 16),
  };
}

function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function nearestAvatarColorIndex(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const target = rgbToHue(r, g, b);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < AVATAR_COLOR_COUNT; i += 1) {
    const dist = hueDistance(target, avatarHue(i));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function legacyColorForBotId(id: string): string {
  return LEGACY_BOT_COLORS[hashBotId(id) % LEGACY_BOT_COLORS.length] ?? LEGACY_BOT_COLORS[0]!;
}

export function avatarForMigration(id: string): KnownBotAvatar {
  return {
    face: AVATAR_FACES[0],
    color: nearestAvatarColorIndex(legacyColorForBotId(id)),
    shape: "circle",
  };
}
