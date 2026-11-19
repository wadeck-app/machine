// `machine wake-info <machine>` (decision 62, D-wake-2): the checklist that prepares THE TARGET for Wake-on-LAN, with what this machine knows about it.
// Text only; the command reads local files and sends nothing.

export interface WakeInfoData {
  name: string;
  uuid: string;
  /** `host:port` of the addresses pinned with `machine peer connect --address`. */
  pinned: string[];
  /** `host:port` of the last signed address record seen from the relay (not authoritative: the relay is untrusted for this). */
  remembered: string[];
  /** The MAC configured on this machine, normalised. */
  mac: string | undefined;
}

const DEFAULT_PEER_PORT = 47921;

const list = (values: string[]): string => (values.length === 0 ? 'none' : values.join(', '));

/** The checklist, plain text with blank lines. Linux commands are the usual ones; every macOS and Windows line says UNVERIFIED. */
export function wakeInfoText(data: WakeInfoData): string {
  const { name, uuid, pinned, remembered, mac } = data;
  const address = pinned[0] ?? `<ip>:${DEFAULT_PEER_PORT}`;
  const macArgument = mac ?? '<aa:bb:cc:dd:ee:ff>';
  const lines: string[] = [];
  const add = (...more: string[]): void => {
    lines.push(...more);
  };

  add(
    `Wake-on-LAN checklist for "${name}" (${uuid})`,
    '',
    `Prepare the TARGET ("${name}"), not this machine. Nothing here was checked on the target: this command reads local files only, sends no packet and opens no connection. Lines marked UNVERIFIED were not checked against that system.`,
    '',
    'What this machine knows',
    `  pinned address   ${list(pinned)}${pinned.length === 0 ? '  (pin one with: machine peer connect ' + name + ' --address <ip>:<port>)' : ''}`,
    `  relay record     ${list(remembered)}${remembered.length > 0 ? '  (last record seen; a pinned address wins over it)' : ''}`,
    `  wake MAC         ${mac ?? 'not configured  (see "Find the MAC address" below)'}`,
    '',
    'Set Wake-on-LAN on the target',
    '',
    'Linux',
    '  - BIOS/UEFI: enable "Wake on LAN" (also named "Wake on PCI-E" or "Power on by PCI-E"; the name varies by vendor).',
    '  - `ethtool <interface>` shows "Wake-on: g" when magic packets wake the machine ("d" means disabled).',
    '  - `sudo ethtool -s <interface> wol g` enables it until the next reboot.',
    '  - To keep it: `nmcli connection modify <connection> 802-3-ethernet.wake-on-lan magic`, then reconnect that connection.',
    '',
    'macOS',
    '  - System Settings > Battery (laptop) or Energy (desktop) > "Wake for network access" (UNVERIFIED: the name and the place change between macOS versions).',
    '  - Keep the Mac on its power adapter while it sleeps (UNVERIFIED).',
    '',
    'Windows',
    '  - Device Manager > Network adapters > your adapter > Properties > Power Management: tick "Allow this device to wake the computer" and "Only allow a magic packet to wake the computer" (UNVERIFIED).',
    '  - Disable Fast Startup: Control Panel > Power Options > Choose what the power buttons do (UNVERIFIED).',
    '  - BIOS/UEFI: enable the same "Wake on LAN" setting as for Linux (UNVERIFIED).',
    '',
    'Machine side (any system)',
    '  - The target must SUSPEND (sleep), not shut down. A machine woken from power-off has no logged-in session, so its daemon (started at login) does not listen, unless the system logs in by itself.',
    '  - Its daemon must start at login: on the target run `machine startup enable` (check with `machine startup status`).',
    '  - It must be on the same LAN as the machine that sends the wake: the packets go out from the machine that runs the command, to the directed broadcast of the network it shares with the target. They do not cross a router, a VPN or the Internet.',
    '',
    'Find the MAC address (run it on the target, for the network card that is connected to the LAN)',
    '  - Linux: `ip link` (the "link/ether" line of the interface)',
    '  - macOS: `ifconfig` (the "ether" line of the interface)',
    '  - Windows: `getmac` or `ipconfig /all` ("Physical Address")',
    '',
  );

  if (mac === undefined) {
    add(
      `Then, on this machine (the one that will send the wake)`,
      `  machine peer connect ${name} --address ${address} --wake-mac ${macArgument}`,
      `  machine peer wake ${name}        (after putting the target to sleep: prints each step and the measured time)`,
    );
  } else {
    add(
      'Then, on this machine (the one that will send the wake)',
      `  machine peer connect ${name} --show      (the MAC ${mac} is configured; this prints every setting)`,
      `  machine peer wake ${name}        (after putting the target to sleep: prints each step and the measured time)`,
    );
  }
  add('');
  return lines.join('\n');
}
