// Deterministic JSON for signatures: sorted keys, no whitespace, safe integers only.
// Floats, undefined, functions and __proto__ keys are refused loudly, never dropped or rounded.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function walk(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new Error(`canonicalize: ${path} is not a safe integer (${String(value)}); only safe integers are signed`);
      }
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new Error(`canonicalize: ${path} is undefined; remove the key or give it a value`);
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new Error(`canonicalize: ${path} is a ${typeof value}, which cannot be signed`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => walk(item, `${path}[${i}]`)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(key => {
    if (key === '__proto__') {
      throw new Error(`canonicalize: ${path} has a __proto__ key, which is refused`);
    }
    return `${JSON.stringify(key)}:${walk(record[key], path === '$' ? key : `${path}.${key}`)}`;
  });
  return `{${parts.join(',')}}`;
}

export function canonicalize(value: Json): string {
  return walk(value, '$');
}

// Bytes that are actually signed: domain, one zero byte, canonical document.
// The domain prevents a signature made for one document type from being replayed as another.
export function signingInput(domain: string, document: Json): Uint8Array {
  if (domain.length === 0 || domain.includes('\u0000')) {
    throw new Error('signingInput: the domain must be a non-empty string without a zero byte');
  }
  return new TextEncoder().encode(`${domain}\u0000${canonicalize(document)}`);
}
