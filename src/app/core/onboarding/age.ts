/** Client-side age helpers. UX-only: the server (POST /profile/age) is the sole
 * authority and recomputes independently before any account change. */

/** Whole years between birthDate ("YYYY-MM-DD") and `now`, month/day-correct. */
export function computeAge(birthDate: string, now: Date = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = now.getFullYear() - y;
  const mo = now.getMonth() + 1;
  const day = now.getDate();
  if (mo < m || (mo === m && day < d)) age--;
  return age;
}

export function isAdult(birthDate: string, now: Date = new Date()): boolean {
  return computeAge(birthDate, now) >= 18;
}
