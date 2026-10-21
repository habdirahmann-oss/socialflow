/**
 * Geen enkel streepje (-, –, —) in captions:
 * - '1–5' → '1 t/m 5'
 * - 'A — B' / 'A - B' → 'A, B'
 * - opsommingstekens ('- punt') aan het begin van een regel vervallen
 * - koppeltekens binnen een woord: 'e-mail' → 'email', 'AI-taal' → 'AI taal'
 */
export function stripDashes(text: string): string {
  return text
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 t/m $2")
    .replace(/^([ \t]*)[-–—][ \t]*/gm, "$1")
    .replace(/(\S)[ \t]*[—–][ \t]*(?=\S)/g, "$1, ")
    .replace(/(\S)[ \t]+-[ \t]+(?=\S)/g, "$1, ")
    .replace(/(\p{Ll})-(?=\p{Ll})/gu, "$1")
    .replace(/(\S)[-–—](?=\S)/g, "$1 ")
    .replace(/[ \t]*[-–—][ \t]*$/gm, "")
    .replace(/([.!?:;,]), /g, "$1 ")
    .replace(/,,/g, ",");
}
