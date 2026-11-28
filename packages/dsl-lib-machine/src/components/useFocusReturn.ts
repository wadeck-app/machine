import { useEffect, useRef, type RefObject } from 'react';

// Where the focus goes when a dialog opened from a row closes (UX review 4): the dialogs of the module are mounted when opened and unmounted when closed, so the Dialog of
// dsl-ui cannot give the focus back to the button that opened it and it fell to the page body (a keyboard user lost their place). The table remembers the button by its
// accessible name (the node can be replaced when the list reloads) and, when the row is gone (the list reloaded without it), the focus goes to the list itself.
//
// UX review 5: a rename changes the accessible name of the row's buttons ("Rename laptop" becomes "Rename box") once the list has reloaded. `leave` then takes the name the
// button will have; until the list reloads the focus rests on the list, and the button takes it when it appears (as long as the person has not moved the focus themselves).

/**
 * `root`: the element of the list (focusable with tabIndex -1), `watch`: what changes when the list reloads (its rows).
 * `leave(label, laterLabel?)` is called when the dialog closes with the accessible name of the button that opened it: the focus goes back to it on the next frame, and to `root`
 * when the list no longer has it or loses it afterwards. `laterLabel`: the name that button has after the list reloaded, when the action changed it.
 */
export function useFocusReturn(root: RefObject<HTMLElement | null>, watch: unknown): { leave: (buttonLabel: string, laterLabel?: string) => void } {
  // The list may reload after the dialog closed (the row is then removed): the focus must not stay on a node that left the page.
  const settling = useRef(false);
  // The button the focus belongs on once the list is the daemon's own again.
  const wanted = useRef<string | undefined>(undefined);

  const buttonNamed = (label: string): HTMLElement | undefined =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('button') ?? []).find((b) => b.getAttribute('aria-label') === label);

  const toRoot = (): void => {
    root.current?.focus();
  };

  const lost = (): boolean => document.activeElement === null || document.activeElement === document.body || !document.activeElement.isConnected;

  useEffect(() => {
    if (!settling.current) {
      return;
    }
    const later = wanted.current === undefined ? undefined : buttonNamed(wanted.current);
    if (later !== undefined && (lost() || document.activeElement === root.current)) {
      settling.current = false;
      later.focus();
    } else if (lost()) {
      settling.current = false;
      toRoot();
    }
    // `watch` is the only trigger: the helpers read refs and the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);

  return {
    leave: (buttonLabel: string, laterLabel?: string) => {
      settling.current = true;
      wanted.current = laterLabel ?? buttonLabel;
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
        // The list may already be the reloaded one (the page refreshes as soon as the daemon answered): the button then has its later name.
        const button = buttonNamed(buttonLabel) ?? (laterLabel === undefined ? undefined : buttonNamed(laterLabel));
        if (button !== undefined) {
          button.focus();
        } else if (lost()) {
          toRoot();
        }
      });
    },
  };
}
