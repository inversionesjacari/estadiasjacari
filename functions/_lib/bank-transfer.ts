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
  accountName: "INMOBILIARIA JACARI S DE RL",
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

/** Mensaje con datos bancarios HNL para que el huésped transfiera. */
export function buildTransferMessageHNL(amountHnl: number): string {
  const fmt = `HNL ${amountHnl.toLocaleString("es-HN")}`;
  return `Perfecto, te paso los datos bancarios para la transferencia.

🏦 *${BANK_HNL.bank} — Cuenta en Lempiras*
Titular: *${BANK_HNL.accountName}*
Cuenta: *${BANK_HNL.accountNumber}* (${BANK_HNL.accountType})
Monto: *${fmt}*

Una vez hecha la transferencia, *mándame foto del comprobante por este chat* y un agente te confirma la reserva. 🙏

Si necesitás cuenta en dólares (transferencia internacional), avísame.`;
}

/** Mensaje con datos bancarios USD (solo si el huésped pide explícitamente). */
export function buildTransferMessageUSD(amountUsd: number): string {
  const fmt = `USD ${amountUsd.toFixed(2)}`;
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
