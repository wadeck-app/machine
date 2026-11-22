import React from 'react';
import { MachineName } from './MachineName.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A sentence built elsewhere, with every occurrence of the given machine names shown as a MachineName. */
export function MachineText({ text, names }: { text: string; names: ReadonlyArray<string> }) {
  const known = names.filter((n) => n !== '').sort((a, b) => b.length - a.length);
  if (known.length === 0) {
    return <>{text}</>;
  }
  // A capturing split keeps the matched names at the odd indexes.
  const parts = text.split(new RegExp(`(${known.map(escapeRegExp).join('|')})`));
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <MachineName key={i} name={part} /> : part))}
    </>
  );
}
