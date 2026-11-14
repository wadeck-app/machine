import React from 'react';
import { Tooltip } from '@wadeck-app/dsl-ui';
import { Check, Circle, Info } from 'lucide-react';

export type TimelineStatus = 'done' | 'current' | 'todo';

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

const STATUS_LABEL: Record<TimelineStatus, string> = { done: 'Done', current: 'Current', todo: 'To do' };

const MARKER_CLASS: Record<TimelineStatus, string> = {
  done: 'bg-green-600 text-white border-green-600',
  current: 'bg-white text-blue-700 border-blue-600',
  todo: 'bg-white text-gray-400 border-gray-300',
};

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
      return `VerticalTimeline: step "${step.id}" has status "${String(step.status)}". Use one of: done, current, todo.`;
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
    return <div role="alert" className="text-sm text-red-700">{error}</div>;
  }
  return (
    <ol className="relative flex flex-col gap-0">
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-status={step.status}
          aria-current={step.status === 'current' ? 'step' : undefined}
          className="relative flex gap-3 pb-6 last:pb-0"
        >
          {index < steps.length - 1 && <span aria-hidden="true" className="absolute left-3 top-6 -ml-px h-full w-px bg-gray-300" />}
          <span aria-hidden="true" className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${MARKER_CLASS[step.status]}`}>
            {step.status === 'done' ? <Check size={14} /> : <Circle size={8} />}
          </span>
          <div className="flex flex-col">
            <span className="flex items-center gap-1 text-sm font-medium">
              {step.title}
              {step.info !== undefined && (
                <Tooltip content={step.info}>
                  <button type="button" aria-label={`About: ${step.title}`} className="text-gray-500 hover:text-gray-800">
                    <Info size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </span>
            <span className="text-xs text-gray-500">{STATUS_LABEL[step.status]}</span>
            {step.description !== undefined && <span className="text-xs text-gray-700">{step.description}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
