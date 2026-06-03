const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

export const kyivToday = (): Date => new Date(KYIV_YMD.format(new Date()));

export const kyivOffsetMs = (d: Date): number => {
  const kyivStr = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
  const kyivDate = new Date(kyivStr + ' UTC');
  return (kyivDate.getTime() - d.getTime()) / 60_000;
};
