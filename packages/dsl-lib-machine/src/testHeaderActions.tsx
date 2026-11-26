import React from 'react';
import { HeaderActionsProvider, HeaderActionsSlot } from '@wadeck-app/dsl-ui';

// Test host of the header actions: what app-core mounts around a page (the provider and the slot of the breadcrumb row). A component that writes
// <HeaderActions> shows nothing without it, so the tests of such a component render inside this wrapper.
export function HeaderActionsHost({ children }: { children: React.ReactNode }) {
  return (
    <HeaderActionsProvider>
      <HeaderActionsSlot />
      {children}
    </HeaderActionsProvider>
  );
}
