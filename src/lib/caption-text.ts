/**
 * Geen streepjes tussen tekst: 'A — B' / 'A - B' → 'A, B'; '1–5' → '1 t/m 5'.
 * Koppeltekens binnen een woord (e-mail) en opsommingstekens aan het begin
 * van een regel blijven staan.
 */
export function stripDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 t/m $2")
    .replace(/(\S)[ \t]*[—–][ \t]*(?=\S)/g, "$1, ")
    .replace(/(\S)[ \t]+-[ \t]+(?=\S)/g, "$1, ")
    .replace(/[ \t]*[—–][ \t]*$/gm, "")
    .replace(/([.!?:;,]), /g, "$1 ")
    .replace(/,,/g, ",");
}
