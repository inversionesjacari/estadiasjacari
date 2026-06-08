/// <reference types="@cloudflare/workers-types" />
//
// Datos bancarios + templates para pagos por transferencia.
//
// Política de transferencias:
//   - Default: solo cuenta HNL (BAC, Inmobiliaria Jacarí).
//   - Si el huésped solicita explícitamente cuenta USD para transferencia
//     internacional, mostrar también la cuenta USD.
//
// Cualquier rotación de cuentas se hace acá. NO copiar valores a otros lados.
//
// Carpeta `_lib/` (con prefijo underscore) NO es ruteable como endpoint.
//

export const BANK_HNL = {
  bank: "BAC",
  currency: "HNL",
  accountName: "INVERSIONES JACARI S DE RL", // tal cual aparece en el banco (verificado por Eduardo)
  accountNumber: "745467931",
  accountType: "Ahorro",
} as const;

export const BANK_USD = {
  bank: "BAC",
  currency: "USD",
  accountName: "CESAR JAUREGUI ALVARADO",
  accountNumber: "743826861",
  accountType: "Ahorro",
} as const;

import type { Lang } from "./i18n";

/** Mensaje con datos bancarios HNL para que el huésped transfiera. */
export function buildTransferMessageHNL(amountHnl: number, lang: Lang = "es"): string {
  const fmt = `HNL ${amountHnl.toLocaleString("es-HN")}`;
  if (lang === "en") {
    return `Perfect, here are the bank details for the transfer.

🏦 *${BANK_HNL.bank} — Lempira account*
Holder: *${BANK_HNL.accountName}*
Account: *${BANK_HNL.accountNumber}* (Savings)
Amount: *${fmt}*

Once you've made the transfer, *send me a photo of the receipt in this chat* and an agent will confirm your booking. 🙏

If you need a US dollar account (international transfer), let me know.`;
  }
  return `Perfecto, te paso los datos bancarios para la transferencia.

🏦 *${BANK_HNL.bank} — Cuenta en Lempiras*
Titular: *${BANK_HNL.accountName}*
Cuenta: *${BANK_HNL.accountNumber}* (${BANK_HNL.accountType})
Monto: *${fmt}*

Una vez hecha la transferencia, *mándame foto del comprobante por este chat* y un agente te confirma la reserva. 🙏

Si necesitás cuenta en dólares (transferencia internacional), avísame.`;
}

/** Mensaje con datos bancarios USD (solo si el huésped pide explícitamente). */
export function buildTransferMessageUSD(amountUsd: number, lang: Lang = "es"): string {
  const fmt = `USD ${amountUsd.toFixed(2)}`;
  if (lang === "en") {
    return `Here are the details for a US dollar transfer.

🏦 *${BANK_USD.bank} — US Dollar account*
Holder: *${BANK_USD.accountName}*
Account: *${BANK_USD.accountNumber}* (Savings)
Amount: *${fmt}*

Send us a photo of the receipt once it's done. 🙏`;
  }
  return `Te paso también los datos para transferencia en dólares.

🏦 *${BANK_USD.bank} — Cuenta en Dólares*
Titular: *${BANK_USD.accountName}*
Cuenta: *${BANK_USD.accountNumber}* (${BANK_USD.accountType})
Monto: *${fmt}*

Mándanos foto del comprobante cuando lo realices. 🙏`;
}

/** Detecta si el cliente está pidiendo la cuenta en USD/dólares. */
export function isUsdRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(usd|dolares|dólares|d[oó]lar|cuenta usd|cuenta en d[oó]lares|internacional)\b/.test(
    t,
  );
}
