import { describe, expect, it } from 'vitest';
import { MODULE_HEADER, checkModuleHeader } from './guard.js';

describe('checkModuleHeader', () => {
  it('accepts a request that carries x-machine-module: 1', () => {
    expect(checkModuleHeader({ headers: { 'x-machine-module': '1' } })).toBeUndefined();
  });

  it('refuses a request without the header, naming the header and the value', () => {
    const refusal = checkModuleHeader({ headers: {} });
    expect(refusal?.status).toBe(403);
    expect(refusal?.error).toContain(MODULE_HEADER);
    expect(refusal?.error).toContain('1');
  });

  it('refuses a header with another value', () => {
    expect(checkModuleHeader({ headers: { 'x-machine-module': '0' } })?.status).toBe(403);
    expect(checkModuleHeader({ headers: { 'x-machine-module': ['1', '1'] } })?.status).toBe(403);
  });

  it('refuses a request object without headers instead of throwing', () => {
    expect(checkModuleHeader({})?.status).toBe(403);
    expect(checkModuleHeader(undefined)?.status).toBe(403);
  });
});
