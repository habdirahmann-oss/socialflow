/**
 * Kleine fetch-helper voor de browser: controleert status én content-type
 * vóór .json() en geeft leesbare Nederlandse fouten terug.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Vaste meldingen per HTTP-status (los van wat de server zegt). */
export function httpErrorMessage(status: number, serverError?: string): string {
  if (status === 413) return "Bestand te groot voor directe verzending";
  if (status === 401) return "Je bent uitgelogd — log opnieuw in";
  if (status === 504) {
    return "Server-timeout: controleer in Planning wat al geplaatst is voordat je opnieuw post";
  }
  // 4xx met een eigen (Nederlandse) melding van onze API: die is het nuttigst.
  if (serverError && status >= 400 && status < 500) return serverError;
  return `Serverfout (HTTP ${status})`;
}

export const NETWORK_ERROR =
  "Geen verbinding met de server — controleer je internet";

/**
 * JSON-request naar onze eigen API. Gooit een HttpError met een leesbare
 * melding bij netwerkfouten, niet-2xx-statussen of een niet-JSON-antwoord.
 */
export async function postJson<T = Record<string, unknown>>(
  url: string,
  body?: unknown,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new HttpError(NETWORK_ERROR, 0);
  }

  const isJson = (res.headers.get("content-type") || "").includes(
    "application/json",
  );
  let data: unknown = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const serverError =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined;
    throw new HttpError(httpErrorMessage(res.status, serverError), res.status);
  }
  if (!isJson || data === null) {
    throw new HttpError(`Onverwacht antwoord van de server (HTTP ${res.status})`, res.status);
  }
  return data as T;
}
