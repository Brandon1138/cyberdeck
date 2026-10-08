/** Quote one argument for a provider hook command line, which providers hand to a shell. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
