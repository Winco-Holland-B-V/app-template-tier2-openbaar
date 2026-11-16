/**
 * Bedragen staan overal in hele centen; alleen op het scherm worden het euro's. Rekenen met
 * kommagetallen (14.95 * 3) geeft afrondfouten, rekenen met centen niet.
 */
const EURO = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });

export function euro(centen: number): string {
  return EURO.format(centen / 100);
}
