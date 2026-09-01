import type { Env, Store } from '../types';
import { checkPlayStation, PS_DIRECT_URL } from './playstation';
import { checkNewegg, NEWEGG_URL } from './newegg';
import { checkBestBuy, BESTBUY_URL } from './bestbuy';
import { checkViaHotstock } from './hotstock';

/**
 * Las tiendas, en orden de importancia para un drop de PS5 Pro.
 *
 * "directa" significa que consultamos la tienda (o su API oficial) nosotros.
 * "indirecta" significa que el dato viene de hotstock.io, con su latencia.
 */
export interface StoreMeta extends Store {
  direct: boolean;
  source: string;
}

export const STORES: StoreMeta[] = [
  {
    id: 'playstation',
    name: 'PlayStation Direct',
    url: PS_DIRECT_URL,
    intervalSec: 60,
    direct: true,
    source: 'api.direct.playstation.com (SAP Commerce)',
    check: (_env: Env, failStreak: number) => checkPlayStation(failStreak),
  },
  {
    id: 'bestbuy',
    name: 'Best Buy',
    url: BESTBUY_URL,
    intervalSec: 60,
    direct: true,
    source: 'API oficial de Best Buy',
    check: (env: Env) => checkBestBuy(env),
  },
  {
    id: 'newegg',
    name: 'Newegg',
    url: NEWEGG_URL,
    intervalSec: 60,
    direct: true,
    source: 'API ProductRealtime de Newegg',
    check: () => checkNewegg(),
  },
  {
    id: 'amazon',
    name: 'Amazon',
    url: 'https://www.amazon.com/PlayStation-5-Pro-Console-2TB/dp/B0FTMY4YZ2',
    intervalSec: 60,
    direct: false,
    source: 'hotstock.io',
    check: () => checkViaHotstock('Amazon'),
  },
  {
    id: 'walmart',
    name: 'Walmart',
    url: 'https://www.walmart.com/ip/PlayStation-5-Pro-Console-Disc-Drive-PS5-Digital-Edition-Consoles-Includes-PS5-Pro-Console-DualSense-Controller-16-GB-RAM-2-TB-SSD-Custom-Integrated/15249900540',
    intervalSec: 60,
    direct: false,
    source: 'hotstock.io',
    check: () => checkViaHotstock('Walmart'),
  },
  {
    id: 'target',
    name: 'Target',
    url: 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188',
    intervalSec: 60,
    direct: false,
    source: 'hotstock.io',
    check: () => checkViaHotstock('Target (Delivery)'),
  },
  {
    id: 'gamestop',
    name: 'GameStop',
    url: 'https://www.gamestop.com/consoles-hardware/playstation-5/consoles/products/sony-playstation-5-pro-console/20015604.html',
    intervalSec: 60,
    direct: false,
    source: 'hotstock.io',
    check: () => checkViaHotstock('GameStop'),
  },
];

export const STORE_BY_ID = new Map(STORES.map((s) => [s.id, s]));
