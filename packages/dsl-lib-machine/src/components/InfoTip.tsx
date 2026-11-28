import React from 'react';
import { IconButton } from '@wadeck-app/dsl-ui';
import { Info } from 'lucide-react';

// The "i" button and its explanation: dsl-ui's IconButton with its tooltip card (drawn on hover and on keyboard focus, closed with Escape; the text is the
// accessible description of the button).

export interface InfoTipProps {
  /** Accessible name of the button, e.g. "About: Details checked". */
  label: string;
  /** The explanation: the accessible description of the button and the content of the card. */
  text: string;
}

export function InfoTip({ label, text }: InfoTipProps) {
  return <IconButton icon={<Info size={14} aria-hidden="true" />} aria-label={label} size="icon-xs" tooltip={text} />;
}
