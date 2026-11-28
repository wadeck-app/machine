import React from 'react';
import { Notice, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import { splitCommandText } from '../lib/commandText.js';

// The texts of the module (and of the daemon) write a command between backticks. They are shown with the Text atom in monospace, never with their backticks (UX review).
// A Notice takes plain text only: the prose stays in its box and the sentences that hold a command follow it (lib/commandText.ts).

/** Inline text where every `command` between backticks is monospace. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="break-words">
            <Text mono text={part} />
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

export interface CommandNoticeProps {
  /** The message; a command is between backticks. */
  label: string;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

/** A Notice whose commands are monospace: the sentences with a command are shown under the box, the box keeps the rest. No box when there is no prose. */
export function CommandNotice({ label, variant = 'info' }: CommandNoticeProps) {
  const { prose, withCommands } = splitCommandText(label);
  if (withCommands.length === 0) {
    return <Notice label={label} variant={variant} />;
  }
  return (
    <VerticalStack gap="gap-1">
      {prose !== '' && <Notice label={prose} variant={variant} />}
      {withCommands.map((sentence, i) => (
        <p key={i} className="m-0 text-sm">
          <CodeText text={sentence} />
        </p>
      ))}
    </VerticalStack>
  );
}
