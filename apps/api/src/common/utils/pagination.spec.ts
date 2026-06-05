import { describe, it, expect } from 'vitest';
import { calculatePagination, MAX_PAGE_SIZE } from './pagination';

describe('calculatePagination', () => {
  it('page=1, limit=20 → skip=0, take=20', () => {
    expect(calculatePagination({ page: 1, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('page=2, limit=20 → skip=20, take=20', () => {
    expect(calculatePagination({ page: 2, limit: 20 })).toEqual({ skip: 20, take: 20 });
  });

  it('page=3, limit=10 → skip=20, take=10', () => {
    expect(calculatePagination({ page: 3, limit: 10 })).toEqual({ skip: 20, take: 10 });
  });

  it('page=0 → skip=0 (clamp to page 1)', () => {
    expect(calculatePagination({ page: 0, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('page=-1 → skip=0 (clamp to page 1)', () => {
    expect(calculatePagination({ page: -1, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it(`limit=999 → take=${MAX_PAGE_SIZE} (cap at MAX_PAGE_SIZE)`, () => {
    const { take } = calculatePagination({ page: 1, limit: 999 });
    expect(take).toBe(MAX_PAGE_SIZE);
  });

  it('limit=0 → take=1 (clamp to minimum)', () => {
    expect(calculatePagination({ page: 1, limit: 0 })).toEqual({ skip: 0, take: 1 });
  });

  it('limit=-5 → take=1 (clamp negative)', () => {
    expect(calculatePagination({ page: 1, limit: -5 })).toEqual({ skip: 0, take: 1 });
  });

  it('undefined page → defaults to 1', () => {
    expect(calculatePagination({ page: undefined, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('undefined limit → defaults to 20', () => {
    expect(calculatePagination({ page: 1, limit: undefined })).toEqual({ skip: 0, take: 20 });
  });

  it('кастомний maxLimit використовується замість MAX_PAGE_SIZE', () => {
    const { take } = calculatePagination({ page: 1, limit: 1000, maxLimit: 500 });
    expect(take).toBe(500);
  });

  it('дробові значення floor-уються', () => {
    expect(calculatePagination({ page: 1.9, limit: 20.7 })).toEqual({ skip: 0, take: 20 });
  });
});
