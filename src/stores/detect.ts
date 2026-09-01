import type { StockResult } from '../types';

/**
 * Headers de un Chrome real. Varias tiendas devuelven HTML degradado o un muro
 * si falta el Accept-Language o el User-Agent no es coherente.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Upgrade-Insecure-Requests': '1',
};

const BLOCK_MARKERS = [
  'captcha',
  'are you a human',
  'robot check',
  'access denied',
  'unusual traffic',
  'px-captcha',
  'enter the characters',
];

/** Un muro anti-bot no es "sin stock". Distinguirlo es el punto de todo esto. */
export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return BLOCK_MARKERS.some((m) => head.includes(m));
}

export function blocked(detail: string): StockResult {
  return { status: 'BLOCKED', detail };
}

export function error(detail: string): StockResult {
  return { status: 'ERROR', detail };
}

/** fetch con timeout. Sin esto una tienda colgada consume el presupuesto del cron. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 12_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
