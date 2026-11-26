/** A refusal with its cause and fix in the message: printed as is by the command. Own module so that platform modules can extend it without an import cycle with install.ts. */
export class InstallError extends Error {}
