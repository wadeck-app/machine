// A message of the core names a machine by the first eight characters of its uuid ("... machine "server" (33333333): ...", "... points to machine 33333333"): useful in a
// terminal, useless in a dialog, where it even reads as a message cut in the middle (UX review 5). This puts the machine NAME instead. It never guesses: a prefix that
// matches nothing or several machines stays as the core wrote it, unless the message quotes the name of one of them or the caller gives the uuid it knows.

export interface NamedMachine {
  uuid: string;
  name: string;
}

const SHORT = '[0-9a-f]{8}';

/**
 * `message` with every eight-character uuid prefix that identifies one of `machines` replaced by its name. `known`: full uuids the caller knows the message talks about
 * (the machine an alias points to, say): they settle a prefix that several machines share.
 */
export function nameShortIds(message: string, machines: readonly NamedMachine[], known: readonly string[] = []): string {
  const byShort = (short: string): NamedMachine[] => {
    const hinted = machines.filter((m) => known.includes(m.uuid) && m.uuid.startsWith(short));
    return hinted.length > 0 ? hinted : machines.filter((m) => m.uuid.startsWith(short));
  };
  const only = (short: string): NamedMachine | undefined => {
    const found = byShort(short);
    return found.length === 1 ? found[0] : undefined;
  };
  return (
    message
      // `machine "server" (33333333)`: the name is already there, the prefix only repeats it (it settles itself when several machines share the prefix).
      .replace(new RegExp(`("([^"]+)") \\((${SHORT})\\)`, 'g'), (whole, quoted: string, name: string, short: string) =>
        byShort(short).some((m) => m.name.toLowerCase() === name.toLowerCase()) ? quoted : whole,
      )
      // `of another machine (33333333)`
      .replace(new RegExp(` \\((${SHORT})\\)`, 'g'), (whole, short: string) => {
        const machine = only(short);
        return machine === undefined ? whole : ` "${machine.name}"`;
      })
      // `points to machine 33333333` (never the start of a whole uuid)
      .replace(new RegExp(`\\bmachine (${SHORT})\\b(?!-)`, 'g'), (whole, short: string) => {
        const machine = only(short);
        return machine === undefined ? whole : `machine "${machine.name}"`;
      })
  );
}
