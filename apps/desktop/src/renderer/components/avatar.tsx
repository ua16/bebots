/**
 * Figma palette: bot avatar dots color-code bots across sidebar and threads.
 * A stable hash of the bot id keeps each bot's color fixed across reloads.
 */
const BOT_COLORS: readonly string[] = [
  "#FF0000",
  "#1B73FF",
  "#E41BFF",
  "#63BE58",
  "#FF8800",
  "#00C2D8",
  "#FFD600",
  "#8C64FF",
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

function botColor(id: string | null | undefined): string {
  if (id === null || id === undefined) return "#5A5A5A";
  return BOT_COLORS[hashId(id) % BOT_COLORS.length] ?? "#5A5A5A";
}

export function BotAvatar({
  id,
  size,
  title,
}: {
  id: string | null | undefined;
  size: number;
  title?: string | undefined;
}) {
  return (
    <span
      className="bot-avatar"
      style={{ width: size, height: size, backgroundColor: botColor(id) }}
      title={title}
      aria-hidden={title === undefined ? true : undefined}
    />
  );
}
