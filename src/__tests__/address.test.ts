import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../normalize/address.js';

describe('normalizeAddress', () => {
  it('lowercases and trims whitespace', () => {
    expect(normalizeAddress('  123 MAIN ST  ')).toBe('123 main street');
  });

  it('expands common abbreviations', () => {
    expect(normalizeAddress('100 Oak Ave')).toBe('100 oak avenue');
    expect(normalizeAddress('200 Pine Blvd')).toBe('200 pine boulevard');
    expect(normalizeAddress('300 Elm Dr')).toBe('300 elm drive');
    expect(normalizeAddress('400 Maple Ln')).toBe('400 maple lane');
    expect(normalizeAddress('500 Cedar Ct')).toBe('500 cedar court');
    expect(normalizeAddress('600 Birch Rd')).toBe('600 birch road');
    expect(normalizeAddress('700 Willow Pl')).toBe('700 willow place');
    expect(normalizeAddress('800 Spruce Cir')).toBe('800 spruce circle');
  });

  it('strips punctuation (commas, periods, hashes)', () => {
    expect(normalizeAddress('123 Main St., Apt. #4')).toBe(
      '123 main street apt 4',
    );
  });

  it('collapses multiple spaces to single space', () => {
    expect(normalizeAddress('123   Main    St')).toBe('123 main street');
  });

  it('produces consistent keys for equivalent addresses', () => {
    const a = normalizeAddress('123 Main St., Springfield, IL');
    const b = normalizeAddress('  123 MAIN ST  SPRINGFIELD  IL  ');
    expect(a).toBe(b);
  });

  it('handles address with no abbreviations', () => {
    expect(normalizeAddress('123 main street')).toBe('123 main street');
  });
});
