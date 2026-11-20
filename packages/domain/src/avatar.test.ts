import { describe, expect, it } from "vitest";
import {
  AVATAR_COLOR_COUNT,
  AVATAR_FACES,
  AVATAR_HUE_END,
  AVATAR_HUE_START,
  AVATAR_SHAPES,
  avatarCssColor,
  avatarForMigration,
  avatarFromBotId,
  avatarHue,
  hashBotId,
  nearestAvatarColorIndex,
  parseBotAvatar,
  resolveBotAvatar,
  serializeBotAvatar,
  validateBotAvatar,
} from "./avatar.js";

describe("avatarHue", () => {
  it("starts at 354 and ends at 47", () => {
    expect(avatarHue(0)).toBeCloseTo(AVATAR_HUE_START, 5);
    expect(avatarHue(AVATAR_COLOR_COUNT - 1)).toBeCloseTo(AVATAR_HUE_END, 5);
  });

  it("steps equally along the long arc", () => {
    const longArc = (AVATAR_HUE_START - AVATAR_HUE_END + 360) % 360;
    const step = longArc / (AVATAR_COLOR_COUNT - 1);
    for (let i = 0; i < AVATAR_COLOR_COUNT; i += 1) {
      expect(avatarHue(i)).toBeCloseTo((AVATAR_HUE_START - step * i + 360) % 360, 5);
    }
  });

  it("uses the long arc (~307°), not the short red/orange arc", () => {
    const longArc = (AVATAR_HUE_START - AVATAR_HUE_END + 360) % 360;
    expect(longArc).toBeGreaterThan(180);
    expect(longArc).toBeCloseTo(307, 0);
  });
});

describe("avatarCssColor", () => {
  it("emits hsl with shared S/L", () => {
    expect(avatarCssColor(0)).toBe(`hsl(${avatarHue(0)}, 81%, 56%)`);
  });
});

describe("serialize / parse", () => {
  it("round-trips a valid avatar", () => {
    const avatar = { face: "face-1", color: 3, shape: "squircle" };
    expect(parseBotAvatar(serializeBotAvatar(avatar))).toEqual(avatar);
  });

  it("returns null for empty or invalid JSON", () => {
    expect(parseBotAvatar("")).toBeNull();
    expect(parseBotAvatar(null)).toBeNull();
    expect(parseBotAvatar("{")).toBeNull();
    expect(parseBotAvatar(JSON.stringify({ face: 1 }))).toBeNull();
  });
});

describe("validateBotAvatar", () => {
  it("accepts catalog values", () => {
    const result = validateBotAvatar({ face: "face-2", color: 9, shape: "rounded-star" });
    expect(result).toEqual({
      valid: true,
      value: { face: "face-2", color: 9, shape: "rounded-star" },
    });
  });

  it("rejects unknown face/shape/color", () => {
    expect(validateBotAvatar({ face: "face-99", color: 0, shape: "circle" }).valid).toBe(false);
    expect(validateBotAvatar({ face: "face-0", color: 0, shape: "hexagon" }).valid).toBe(false);
    expect(validateBotAvatar({ face: "face-0", color: 10, shape: "circle" }).valid).toBe(false);
  });
});

describe("resolveBotAvatar", () => {
  it("falls back unknown face/shape/color for display without rewriting identity of known fields", () => {
    expect(resolveBotAvatar({ face: "face-99", color: 2, shape: "circle" })).toEqual({
      face: "face-0",
      color: 2,
      shape: "circle",
    });
    expect(resolveBotAvatar({ face: "face-1", color: 99, shape: "blob" })).toEqual({
      face: "face-1",
      color: AVATAR_COLOR_COUNT - 1,
      shape: "circle",
    });
  });

  it("returns null for unassigned", () => {
    expect(resolveBotAvatar(null)).toBeNull();
    expect(resolveBotAvatar(undefined)).toBeNull();
  });
});

describe("avatarFromBotId", () => {
  it("is deterministic and samples catalogs", () => {
    const a = avatarFromBotId("bot-abc");
    const b = avatarFromBotId("bot-abc");
    expect(a).toEqual(b);
    expect(AVATAR_FACES).toContain(a.face);
    expect(AVATAR_SHAPES).toContain(a.shape);
    expect(a.color).toBeGreaterThanOrEqual(0);
    expect(a.color).toBeLessThan(AVATAR_COLOR_COUNT);
  });

  it("varies across ids", () => {
    const samples = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => JSON.stringify(avatarFromBotId(id))),
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("avatarForMigration", () => {
  it("uses face-0 and circle", () => {
    const a = avatarForMigration("any-bot");
    expect(a.face).toBe("face-0");
    expect(a.shape).toBe("circle");
  });

  it("maps legacy hashed color to nearest hue", () => {
    const id = "migrate-me";
    const a = avatarForMigration(id);
    const legacyHexIndex = hashBotId(id) % 8;
    const legacyHexes = [
      "#FF0000",
      "#1B73FF",
      "#E41BFF",
      "#63BE58",
      "#FF8800",
      "#00C2D8",
      "#FFD600",
      "#8C64FF",
    ];
    expect(a.color).toBe(nearestAvatarColorIndex(legacyHexes[legacyHexIndex]!));
  });
});

describe("nearestAvatarColorIndex", () => {
  it("picks a close hue for pure red", () => {
    expect(nearestAvatarColorIndex("#FF0000")).toBe(0);
  });
});
