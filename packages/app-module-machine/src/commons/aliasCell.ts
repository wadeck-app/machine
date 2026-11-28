// The text of the Aliases cell of the Machines table (UX review 5): every alias a machine answers to, with its origin when the row has a network alias. BROWSER-SAFE (the
// scenario mock and the real route share it, so the two cannot drift).
//
// `aliases` is what the daemon list gives (local and network merged, the local one winning on this machine); `network` is the part that comes from the admin-signed list
// (`networkAliases` of the list, not shadowed). A row with local aliases only stays plain ("tc"); as soon as one alias is a network alias every alias says where it comes
// from ("tc (local), work (network)"), so a bare label is never read as the wrong kind. `network` absent (an older daemon): the origin is unknown, the labels stay plain.

export function aliasesCellText(aliases: readonly string[], network: readonly string[] | undefined): string {
  const fromNetwork = new Set(network ?? []);
  if (!aliases.some((a) => fromNetwork.has(a))) {
    return aliases.join(', ');
  }
  return aliases.map((a) => `${a} (${fromNetwork.has(a) ? 'network' : 'local'})`).join(', ');
}
