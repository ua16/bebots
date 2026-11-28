/** Append footnote lines below a user prompt for the model. */
export function appendPromptNotes(
  prompt: string,
  notes: readonly string[],
): string {
  const body = prompt.trimEnd();
  const lines = notes.map((n) => n.trim()).filter((n) => n.length > 0);
  if (lines.length === 0) return body;
  if (body.length === 0) return lines.join("\n");
  return `${body}\n\n${lines.join("\n")}`;
}
