/**
 * Gedeelde app-configuratie (server-side).
 *
 * APP_URL = publieke basis-URL van de app, zonder slash op het eind. Wordt
 * gebruikt voor OAuth-redirect-URI's, terugkeer naar /verbindingen en
 * publieke media-links (/api/media/...).
 */
export const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
