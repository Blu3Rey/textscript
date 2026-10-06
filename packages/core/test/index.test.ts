import { describe, expect, it } from 'vitest';
import { IR_SCHEMA_VERSION } from '../src/index';

describe('IR_SCHEMA_VERSION', () => {
  it('is a non-negative integer', () => {
    expect(Number.isInteger(IR_SCHEMA_VERSION)).toBe(true);
    expect(IR_SCHEMA_VERSION).toBeGreaterThanOrEqual(0);
  });
});
