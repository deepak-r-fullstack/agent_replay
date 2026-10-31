// Finds the words that differ between two texts, so the compare screen can highlight them.
// A simple "longest common run of words" comparison, written here because it is small and avoids a new dependency.

export type DiffPart = { type: "same" | "removed" | "added"; text: string };

// Past this size the comparison is skipped (it would be slow), and the two texts are simply shown as different.
const MAX_CELLS = 1_500_000;

// Words and the spaces between them are kept as separate pieces, so nothing is lost when the text is put back together.
const tokenize = (text: string) => text.split(/(\s+)/).filter((piece) => piece.length > 0);

export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "same", text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_CELLS) {
    return [...(before ? [{ type: "removed" as const, text: before }] : []), ...(after ? [{ type: "added" as const, text: after }] : [])];
  }

  // table[i][j] = length of the longest shared run of words in a[i..] and b[j..]
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      push("removed", a[i++]);
    } else {
      push("added", b[j++]);
    }
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return parts;
}
