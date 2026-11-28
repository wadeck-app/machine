import React from 'react';
import { Collapsible, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import { CommandNotice } from './CommandNotice.js';
import { loadFailureView, type SourceError } from '../lib/loadFailure.js';

/**
 * The failed load of a page source, above its table: one alert with the cause and the exact command, the whole message folded under it. Not a registry component:
 * the tables of the module render it.
 */
export function LoadFailureNotice({ what, error }: { what: string; error: SourceError }) {
  const view = loadFailureView(what, error);
  return (
    <VerticalStack gap="gap-1">
      <CommandNotice variant="danger" label={view.label} />
      <Collapsible title="Details">
        <div className="break-words">
          <Text mono size="xs" text={view.details} />
        </div>
      </Collapsible>
    </VerticalStack>
  );
}
