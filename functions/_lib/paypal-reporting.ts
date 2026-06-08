/// <reference types="@cloudflare/workers-types" />
//
// Cliente PayPal Transaction Search API (Reporting) — lee transacciones de una
// cuenta PayPal para capturar los PAYOUTS DE AIRBNB.
//
// Por qué: el dinero de Airbnb cae en cuenta(s) PayPal (Cacejau y/o Jacarí),
// NO en la base de datos. Airbnb no tiene API de earnings para hosts, pero los
// payouts SÍ aparecen como transacciones entrantes en PayPal. Esta API
// (`/v1/reporting/transactions`) lista todas las transacciones de la cuenta en
// un rango de fechas; filtramos las que vienen de "Airbnb" y sumamos.
//
// Requiere, en la app REST de cada cuenta (PayPal Developer dashboard):
//   - Feature "Transaction Search" ACTIVADA.
//   - CLIENT_ID + SECRET (creds Live), agregados como secretos en Cloudflare.
//
// Límites de la API: rango máximo 31 días por llamada; los datos pueden
// tardar hasta ~3 h en aparecer (T+3h). Por eso esto corre por cron (cacheado),
// no en cada poll del dashboard.
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.
//

import { fetchWithTimeout, TIMEOUT } from "./fetch";

export interface PayPalAccountCreds {
  /** Etiqueta legible (p.ej. "jacari", "cacejau") — solo para logs/debug. */
  label: string;
  clientId: string;
  secret: string;
}

export interface AirbnbTxn {
  /** Fecha ISO de la transacción. */
  date: string;
  /** Monto recibido (positivo). */
  amount: number;
  /** Moneda (esperado USD). */
  currency: string;
  /** Nombre/eMail del remitente (para verificar que es Airbnb). */
  payer: string;
  /** Cuenta donde cayó (label). */
  account: string;
}

/** Obtiene access_token de una cuenta PayPal (client_credentials). */
async function getToken(apiBase: string, creds: PayPalAccountCreds): Promise<{ token?: string; error?: string }> {
  try {
    const resp = await fetchWithTimeout(
      `${apiBase}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${creds.clientId}:${creds.secret}`),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      },
      TIMEOUT.CRITICAL,
    );
    if (!resp.ok) {
      const t = await resp.text();
      return { error: `[${creds.label}] token HTTP ${resp.status}: ${t.slice(0, 150)}` };
    }
    const data = (await resp.json()) as { access_token?: string };
    return data.access_token ? { token: data.access_token } : { error: `[${creds.label}] sin access_token` };
  } catch (err) {
    return { error: `[${creds.label}] red token: ${(err as Error).message}` };
  }
}

/** ¿El remitente de la transacción es Airbnb? (nombre o email contiene "airbnb"). */
function isAirbnbPayer(payer: string): boolean {
  return /airbnb/i.test(payer);
}

interface TxnInfo {
  transaction_amount?: { currency_code?: string; value?: string };
  transaction_status?: string;
  transaction_initiation_date?: string;
  transaction_updated_date?: string;
}
interface PayerInfo {
  email_address?: string;
  payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string };
}
interface TxnDetail { transaction_info?: TxnInfo; payer_info?: PayerInfo }
interface ReportResp { transaction_details?: TxnDetail[]; total_pages?: number }

/**
 * Lee las transacciones entrantes de Airbnb de UNA cuenta entre dos fechas.
 * Pagina hasta cubrir todo el rango (cap defensivo de 20 páginas).
 */
export async function fetchAirbnbTxns(
  apiBase: string,
  creds: PayPalAccountCreds,
  startIso: string,
  endIso: string,
): Promise<{ txns: AirbnbTxn[]; error?: string }> {
  const tok = await getToken(apiBase, creds);
  if (!tok.token) return { txns: [], error: tok.error };

  const txns: AirbnbTxn[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url =
      `${apiBase}/v1/reporting/transactions` +
      `?start_date=${encodeURIComponent(startIso)}&end_date=${encodeURIComponent(endIso)}` +
      `&fields=transaction_info,payer_info&page_size=500&page=${page}`;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${tok.token}`, Accept: "application/json" } }, TIMEOUT.CRITICAL);
    } catch (err) {
      return { txns, error: `[${creds.label}] red reporting: ${(err as Error).message}` };
    }
    if (!resp.ok) {
      const t = await resp.text();
      return { txns, error: `[${creds.label}] reporting HTTP ${resp.status}: ${t.slice(0, 200)}` };
    }
    const data = (await resp.json()) as ReportResp;
    totalPages = data.total_pages ?? 1;
    for (const d of data.transaction_details ?? []) {
      const info = d.transaction_info;
      const amt = info?.transaction_amount;
      const value = amt?.value ? parseFloat(amt.value) : 0;
      // Solo entrantes exitosas (status 'S') con monto positivo.
      if (info?.transaction_status !== "S" || !(value > 0)) continue;
      const pn = d.payer_info?.payer_name;
      const payer = [pn?.alternate_full_name, pn?.given_name, pn?.surname, d.payer_info?.email_address]
        .filter(Boolean).join(" ").trim();
      if (!isAirbnbPayer(payer)) continue;
      txns.push({
        date: info.transaction_initiation_date ?? info.transaction_updated_date ?? "",
        amount: value,
        currency: amt?.currency_code ?? "USD",
        payer,
        account: creds.label,
      });
    }
    page++;
  } while (page <= totalPages && page <= 20);

  return { txns };
}

/** Construye la lista de cuentas configuradas desde el entorno (creds presentes). */
export function configuredAccounts(env: Record<string, string | undefined>): PayPalAccountCreds[] {
  const accts: PayPalAccountCreds[] = [];
  // Cuenta Cacejau — Airbnb de La Florida 1A/1B + Casa Lara.
  if (env.PAYPAL_CACEJAU_CLIENT_ID && env.PAYPAL_CACEJAU_CLIENT_SECRET) {
    accts.push({ label: "cacejau", clientId: env.PAYPAL_CACEJAU_CLIENT_ID, secret: env.PAYPAL_CACEJAU_CLIENT_SECRET });
  }
  // Cuenta Jacarí — Airbnb del resto de propiedades + cobros de la web. Usamos
  // creds DEDICADAS de reporting (`PAYPAL_JACARI_*`), separadas de las del
  // checkout (`PAYPAL_CLIENT_*`) para no arriesgar los cobros. Si no están las
  // dedicadas, cae a las del checkout (que entonces necesita Transaction Search).
  const jId = env.PAYPAL_JACARI_CLIENT_ID || env.PAYPAL_CLIENT_ID;
  const jSecret = env.PAYPAL_JACARI_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET;
  if (jId && jSecret) {
    accts.push({ label: "jacari", clientId: jId, secret: jSecret });
  }
  return accts;
}
