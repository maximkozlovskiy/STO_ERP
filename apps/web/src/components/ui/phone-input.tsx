'use client';

import { useCallback } from 'react';
import { Input, type InputProps } from './input';

// Formats raw input into +38 (0XX) XXX-XX-XX Ukrainian phone mask.
function applyMask(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  // Normalise: strip leading 38 so we work with local 10-digit number (starts with 0)
  let d = digits.startsWith('380')
    ? digits.slice(2)
    : digits.startsWith('38')
      ? digits.slice(2)
      : digits;
  d = d.slice(0, 10);
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
// onChange fires with a synthetic-like event so callers need no changes.
export function PhoneInput(props: Omit<InputProps, 'type'>) {
  const { onChange, ...rest } = props;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const masked = applyMask(e.target.value);
      // Mutate the event value so callers that do e.target.value get the masked string
      const syntheticEvent = {
        ...e,
        target: { ...e.target, value: masked },
        currentTarget: { ...e.currentTarget, value: masked },
      } as React.ChangeEvent<HTMLInputElement>;
      onChange?.(syntheticEvent);
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
