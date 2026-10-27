/**
 * Chiamate HTTP per le valutazioni locali (`ask:eval`): solo script, mai importato dall'app servita ai visitatori
 * (lo verifica test/eval-fetch.test.ts).
 *
 * Il `fetch` di Node aspetta l'inizio della risposta (le intestazioni) per 5 minuti al massimo, poi chiude con un
 * generico «fetch failed» (codice UND_ERR_HEADERS_TIMEOUT). Un server locale come Ollama, senza streaming, manda le
 * intestazioni solo a risposta finita: con un modello lento su un portatile si superano i 5 minuti, e `--timeout-ms`
 * oltre 300000 non avrebbe effetto. Qui si usa `node:http` / `node:https`, che non hanno quel limite: decide solo il
 * segnale della richiesta (AbortSignal.timeout del tempo concesso).
 *
 * In produzione il tempo massimo è 50 s (ASK_TIMEOUT_MS): la route usa il `fetch` normale.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

/** Stati che per lo standard non hanno corpo: `new Response` li rifiuta con un corpo. */
const NO_BODY = new Set([101, 204, 205, 304]);

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/** Come `fetch(url, init)` per le richieste dell'adattatore compatibile OpenAI, senza il limite di 5 minuti. */
export function fetchWithoutHeaderLimit(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason);
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return reject(new TypeError(`protocollo non ammesso: ${target.protocol}`));
    if (init.body != null && typeof init.body !== "string") return reject(new TypeError("corpo della richiesta non supportato: solo testo"));
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(target, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => reject(signal?.aborted ? signal.reason : error));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        try {
          resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? "", headers: toHeaders(res.headers) }));
        } catch (error) {
          reject(error);
        }
      });
    });
    // Con il segnale scaduto si riporta il suo motivo (TimeoutError), come fa fetch: l'adattatore lo legge come «timeout».
    req.on("error", (error) => reject(signal?.aborted ? signal.reason : error));
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}
