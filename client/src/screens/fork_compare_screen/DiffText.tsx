import { useMemo } from "react";
import { diffWords } from "utils/helper_functions/diff";

// One side of a comparison. The original shows what was taken out (red), the fork shows what was put in (green).
// The marks also differ in more than colour (underline or strike-through), so they can be told apart without seeing colour.
export const DiffText = ({ side, before, after, emptyNote = "Nothing was recorded." }: { side: "original" | "fork"; before: string; after: string; emptyNote?: string }) => {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  const text = side === "original" ? before : after;
  if (!text) return <p className="rounded-md border border-dashed border-line px-3 py-2 text-sm text-ink-faint">{emptyNote}</p>;
  return (
    <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper px-3 py-2 text-sm leading-relaxed">
      {parts.map((part, position) => {
        if (part.type === "same") return <span key={position}>{part.text}</span>;
        if (part.type === "removed" && side === "original") {
          return (
            <mark key={position} className="rounded-sm bg-refused-tint px-0.5 text-refused line-through decoration-refused/60">
              {part.text}
            </mark>
          );
        }
        if (part.type === "added" && side === "fork") {
          return (
            <mark key={position} className="rounded-sm bg-done-tint px-0.5 font-medium text-done underline decoration-done/50">
              {part.text}
            </mark>
          );
        }
        return null;
      })}
    </p>
  );
};
