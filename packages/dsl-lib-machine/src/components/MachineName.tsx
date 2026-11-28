import React from 'react';
import { Text } from '@wadeck-app/dsl-ui';

/** A machine name, in monospace (the Text atom of dsl-ui). Text only: a name is never interpreted as markup. */
export function MachineName({ name }: { name: string }) {
  return <Text mono text={name} />;
}
