// Typed errors: callers decide on the class, never on the wording of a message.

export const NOT_INITIALIZED_MESSAGE = 'this machine has no identity yet: run `machine init --name <name>` first';

export class NotInitializedError extends Error {
  constructor() {
    super(NOT_INITIALIZED_MESSAGE);
    this.name = 'NotInitializedError';
  }
}

export class AliasConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AliasConflictError';
  }
}

export class NoSuchAliasError extends Error {
  constructor(alias: string) {
    super(`no alias "${alias}": see \`machine alias list\``);
    this.name = 'NoSuchAliasError';
  }
}

/** The machine name cannot be derived or normalised: the message names the fix (`--name`). */
export class MachineNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineNameError';
  }
}
