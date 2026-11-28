import { useEffect, useRef, type RefObject } from 'react';

// Where the focus goes when a dialog opened from a row closes (UX review 4): the dialogs of the module are mounted when opened and unmounted when closed, so the Dialog of
// dsl-ui cannot give the focus back to the button that opened it and it fell to the page body (a keyboard user lost their place). The table remembers the button by its
// accessible name (the node can be replaced when the list reloads) and, when the row is gone (the list reloaded without it), the focus goes to the list itself.

/**
 * `root`: the element of the list (focusable with tabIndex -1), `watch`: what changes when the list reloads (its rows).
 * `leave(label)` is called when the dialog closes with the accessible name of the button that opened it: the focus goes back to it on the next frame, and to `root`
 * when the list no longer has it or loses it afterwards.
 */
export function useFocusReturn(root: RefObject<HTMLElement | null>, watch: unknown): { leave: (buttonLabel: string) => void } {
  // The list may reload after the dialog closed (the row is then removed): the focus must not stay on a node that left the page.
  const settling = useRef(false);

  const buttonNamed = (label: string): HTMLElement | undefined =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('button') ?? []).find((b) => b.getAttribute('aria-label') === label);

  const toRoot = (): void => {
    root.current?.focus();
  };

  const lost = (): boolean => document.activeElement === null || document.activeElement === document.body || !document.activeElement.isConnected;

  useEffect(() => {
    if (settling.current && lost()) {
      settling.current = false;
      toRoot();
    }
    // `watch` is the only trigger: the helpers read refs and the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);

  return {
    leave: (buttonLabel: string) => {
      settling.current = true;
      // The list reloads within seconds; the person's next key or click is theirs: from then on the focus is never moved for them.
      const done = (): void => {
        settling.current = false;
        document.removeEventListener('pointerdown', done, true);
        document.removeEventListener('keydown', done, true);
      };
      document.addEventListener('pointerdown', done, true);
      document.addEventListener('keydown', done, true);
      // After the dialog left the page (its unmount runs before the next frame).
      requestAnimationFrame(() => {
        const button = buttonNamed(buttonLabel);
        if (button !== undefined) {
          button.focus();
        } else if (lost()) {
          toRoot();
        }
      });
    },
  };
}
