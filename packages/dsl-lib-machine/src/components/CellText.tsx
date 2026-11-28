import React from 'react';

// The text of a table cell that must never push the action of its row out of view (UX review 4): one line, cut at a fixed width with an ellipsis, the WHOLE text as the
// tooltip (the row expansion repeats it, a tooltip is not reachable from the keyboard). The cell itself stays `nowrap`: the cap is on this element, so a name of 70
// characters takes the same room as one of 12 and the actions column keeps its place whatever the text.

/** The widths (Tailwind scale) the tables use: at 1024 px the Machines and Candidacies rows still fit with their actions. */
export type CellWidth = 'max-w-32' | 'max-w-40';

export interface CellTextProps {
  text: string;
  width: CellWidth;
}

export function CellText({ text, width }: CellTextProps) {
  return (
    <span className={`block truncate ${width}`} title={text === '' ? undefined : text}>
      {text}
    </span>
  );
}

/** Text that wraps at its spaces and never inside a word (a long word stays whole: the column then takes its width instead of cutting it). For the cells that give way first. */
export function WrapText({ text }: { text: string }) {
  return <span className="break-normal">{text}</span>;
}
