import React from 'react';
import { MONO_STYLE } from '../lib/styleTokens.js';

/** A machine name, in the monospace font of the module (one stack: styleTokens). Text only: a name is never interpreted as markup. */
export function MachineName({ name }: { name: string }) {
  return <span style={MONO_STYLE}>{name}</span>;
}
