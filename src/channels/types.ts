import type { Env } from '../types';

/**
 * Un canal de aviso.
 *
 * La alerta se considera entregada si la acepta AL MENOS UNO. Depender de un
 * solo proveedor era el ultimo punto unico de falla que quedaba: los tres
 * vigilantes detectan el problema, pero si el unico canal esta caido, ninguno
 * te lo puede contar.
 */
export interface Channel {
  /** Nombre corto para el registro y el dashboard. */
  name: string;
  /** Si esta configurado. Un canal sin credenciales se saltea, no falla. */
  configured(env: Env): boolean;
  send(env: Env, msg: AlertMessage): Promise<ChannelResult[]>;
}

export interface AlertMessage {
  subject: string;
  /** Cuerpo para canales que renderizan HTML rico (correo). */
  html: string;
  /** Cuerpo plano para canales de mensajeria. Admite <b> y <a> de Telegram. */
  text: string;
}

export interface ChannelResult {
  /** A donde se mando: una direccion de correo, un chat de Telegram. */
  to: string;
  ok: boolean;
  detail: string;
}

/** Intentos por destino antes de darlo por perdido. */
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [600, 1800];

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Un 4xx no se reintenta: la credencial es invalida o el destino es rechazado,
 * y repetir da el mismo error. 408 y 429 si, porque son transitorios, igual que
 * cualquier 5xx o un fallo de red.
 */
export function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** Evita que un precio o un detalle con `<` rompa el HTML del mensaje. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
