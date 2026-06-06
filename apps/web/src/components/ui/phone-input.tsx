'use client';

import { useCallback, type ChangeEvent } from 'react';
import { Input, type InputProps } from './input';

// Formats raw input into +38 (0XX) XXX-XX-XX Ukrainian phone mask.
// Strips non-digits, normalises a leading 38/380 country code so we always
// work with a local 10-digit Ukrainian number (starts with 0).
//
// IMPORTANT: the mask is re-applied on every keystroke against the CURRENT
// DOM value which already contains the formatted prefix '+38 (' inserted by
// the previous mask call. If we naively pull digits from the whole string,
// the '38' from the prefix joins the user's typed digits → strip-2-then-slice
// double-counts country code as subscriber. (Bug #369: typing '3805...' gave
// '+38 (380) 501-23-45' instead of '+38 (050) 123-45-67'.)
//
// Fix: strip the locked '+38 (' prefix from `raw` BEFORE extracting digits, so
// we only mask the user-supplied portion. One-shot pastes (no prefix in raw)
// still hit the legacy 380/38 strip path.
function applyMask(raw: string): string {
  let rest = raw;
  if (rest.startsWith('+38 (')) rest = rest.slice(5);

  let digits = rest.replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(2);
  else if (digits.startsWith('38') && digits.length >= 11) digits = digits.slice(2);

  const d = digits.slice(0, 10);
  if (!d.length) return '';

  let r = '+38 (';
  if (d.length <= 3) return r + d;
  r += d.slice(0, 3) + ') ';
  if (d.length <= 6) return r + d.slice(3);
  r += d.slice(3, 6) + '-';
  if (d.length <= 8) return r + d.slice(6);
  r += d.slice(6, 8) + '-' + d.slice(8, 10);
  return r;
}

// Drop-in replacement for <Input> for phone fields.
// Mutates the underlying input's value before bubbling the original
// SyntheticEvent up — this preserves the event prototype (preventDefault,
// stopPropagation, persist…) so callers that read e.target.value get the
// masked string, and downstream React handlers behave normally.
export function PhoneInput(props: Omit<InputProps, 'type'>) {
  const { onChange, ...rest } = props;

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const masked = applyMask(e.target.value);
      // Direct DOM mutation: safe because the input is uncontrolled-from-React
      // until the parent re-renders with the new value prop.
      e.target.value = masked;
      onChange?.(e);
    },
    [onChange],
  );

  return (
    <Input
      {...rest}
      type="tel"
      inputMode="tel"
      placeholder="+38 (0__) ___-__-__"
      onChange={handleChange}
    />
  );
}
