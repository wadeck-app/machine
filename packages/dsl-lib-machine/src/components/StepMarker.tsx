import React from 'react';
import { Check, Circle, Loader, X } from 'lucide-react';
import type { StepState } from '../lib/allowProgress.js';

/** The icon of one step of the progress after Allow; decorative: the state is said in words next to it. */
export function StepMarker({ state }: { state: StepState }) {
  if (state === 'done') {
    return <Check size={14} aria-hidden="true" />;
  }
  if (state === 'failed') {
    return <X size={14} aria-hidden="true" />;
  }
  if (state === 'active') {
    return <Loader size={14} aria-hidden="true" />;
  }
  return <Circle size={14} aria-hidden="true" />;
}
