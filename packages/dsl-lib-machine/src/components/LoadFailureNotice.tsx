import React from 'react';
import { Collapsible, Notice, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import { loadFailureView, type SourceError } from '../lib/loadFailure.js';

/**
 * The failed load of a page source, above its table: one alert with the cause and the exact command, the whole message folded under it. Not a registry component:
 * the tables of the module render it.
 */
export function LoadFailureNotice({ what, error }: { what: string; error: SourceError }) {
  const view = loadFailureView(what, error);
  return (
    <VerticalStack gap="gap-1">
      <Notice variant="danger" label={view.label} />
      <Collapsible title="Details">
        <div className="break-words">
          <Text mono size="xs" text={view.details} />
        </div>
      </Collapsible>
    </VerticalStack>
  );
}
