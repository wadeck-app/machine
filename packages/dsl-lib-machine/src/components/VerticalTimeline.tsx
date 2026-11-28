import React from 'react';
import { Check, Circle, Minus } from 'lucide-react';
import { CodeText } from './CommandNotice.js';
import { InfoTip } from './InfoTip.js';

/**
 * `skipped`: the step does not apply to this approval (shown as "Not needed": neither done nor current).
 * `unrecorded`: the step may well be done, but nothing this page holds proves it (shown as "Not recorded by this page": not "To do", which would claim it is still ahead).
 */
export type TimelineStatus = 'done' | 'current' | 'todo' | 'skipped' | 'unrecorded';

export interface TimelineStep {
  /** Unique within the timeline. */
  id: string;
  title: string;
  status: TimelineStatus;
  /** One line under the title. */
  description?: string;
  /** Text of the "i" tooltip. A step without it has no "i" button. */
  info?: string;
}

export interface VerticalTimelineProps {
  steps: TimelineStep[];
}

const STATUS_LABEL: Record<TimelineStatus, string> = { done: 'Done', current: 'Current', todo: 'To do', skipped: 'Not needed', unrecorded: 'Not recorded by this page' };

// Semantic tokens of the app only (dsl-ui theme): they follow the theme and the palette. The marker border of a step still to do is `muted`, not
// `border`: the border token is a hairline (1.25:1 on the page), a marker must reach 3:1.
// @formatter:off
const MARKER_BASE = 'relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2';
const MARKER_CLASS: Record<TimelineStatus, string> = {
  done: 'border-success bg-success text-on-solid',
  current: 'border-primary bg-surface text-primary',
  todo: 'border-muted bg-surface text-muted',
  skipped: 'border-muted bg-muted-bg text-muted',
  unrecorded: 'border-dashed border-muted bg-surface text-muted',
};
const STATUS_TEXT_CLASS: Record<TimelineStatus, string> = {
  done: 'text-success-text',
  current: 'text-primary',
  todo: 'text-muted',
  skipped: 'text-muted',
  unrecorded: 'text-muted',
};
const LIST = 'relative flex flex-col gap-0';
const ITEM = 'relative flex gap-3 pb-6 last:pb-0';
const CONNECTOR = 'absolute left-3 top-6 -ml-px h-full w-0.5 bg-border';
const CONNECTOR_DONE = 'absolute left-3 top-6 -ml-px h-full w-0.5 bg-success';
const TITLE = 'flex items-center gap-1 text-sm font-medium text-content';
const DESCRIPTION = 'break-words text-xs text-content';
const ERROR = 'text-sm text-danger-text';
// @formatter:on

function problem(steps: TimelineStep[]): string | undefined {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'VerticalTimeline: no step given. Pass a non-empty "steps" list (id, title, status).';
  }
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      return `VerticalTimeline: duplicate step id "${step.id}". Give every step its own id.`;
    }
    seen.add(step.id);
    if (!(step.status in STATUS_LABEL)) {
      return `VerticalTimeline: step "${step.id}" has status "${String(step.status)}". Use one of: done, current, todo, skipped, unrecorded.`;
    }
  }
  return undefined;
}

/**
 * Vertical timeline, one step per line, an "i" tooltip per step.
 *
 * @dsl-view-candidate status: incubating
 * @registryCategory atomic
 * @registryTags timeline steps progress
 */
export function VerticalTimeline({ steps }: VerticalTimelineProps) {
  const error = problem(steps);
  if (error) {
    return <div role="alert" className={ERROR}>{error}</div>;
  }
  return (
    <ol className={LIST}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-status={step.status}
          aria-current={step.status === 'current' ? 'step' : undefined}
          className={ITEM}
        >
          {index < steps.length - 1 && <span aria-hidden="true" data-part="connector" className={step.status === 'done' ? CONNECTOR_DONE : CONNECTOR} />}
          <span aria-hidden="true" data-part="marker" className={`${MARKER_BASE} ${MARKER_CLASS[step.status]}`}>
            {step.status === 'done' ? <Check size={14} strokeWidth={3} /> : step.status === 'current' ? <Circle size={8} className="fill-current" /> : step.status === 'skipped' ? <Minus size={12} strokeWidth={3} /> : null}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className={TITLE}>
              {step.title}
              {step.info !== undefined && <InfoTip label={`About: ${step.title}`} text={step.info} />}
            </span>
            <span data-part="status" className={`text-xs ${STATUS_TEXT_CLASS[step.status]}`}>{STATUS_LABEL[step.status]}</span>
            {step.description !== undefined && <span className={DESCRIPTION}><CodeText text={step.description} /></span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
