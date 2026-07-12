// catalog-trace.ts — Instrumentación del envío de la TARJETA NATIVA del catálogo
// de WhatsApp (Commerce Manager, `sendProductMessage`).
//
// Problema que resuelve: cuando la tarjeta nativa no sale (catálogo no listo,
// producto no subido, o falta el env `WHATSAPP_CATALOG_ID`), el webhook cae al
// texto+fotos EN SILENCIO — el bot nunca queda mudo, pero tampoco sabemos si el
// catálogo de Meta de verdad se está compartiendo. La auditoría del bot (doc 11
// §3) lo dejó marcado como "verificar en producción" justamente por eso.
//
// Este helper NO envía nada: decide, dado el resultado del intento, QUÉ dejar
// escrito en `bot_trace` (mismo mecanismo que usó B8-ALERTAS para cazar el error
// de Meta en 25 s). Al ser una función pura `entrada → {stage, detail}` se testea
// al instante y el webhook solo la llama y hace el INSERT best-effort.
//
// Carpeta `_lib/` (prefijo underscore) NO es ruteable como endpoint.

/** Etapa que se escribe en `bot_trace.stage` para el envío de la tarjeta nativa. */
export type CatalogTraceStage = "CATALOG_CARD_SENT" | "CATALOG_CARD_FALLBACK";

export interface CatalogSendOutcome {
  /** true SOLO si la tarjeta nativa salió de verdad (no hubo fallback a texto). */
  sent: boolean;
  stage: CatalogTraceStage;
  /** Texto para `bot_trace.detail`: retailerId + messageId o el motivo del fallback. */
  detail: string;
}

export interface CatalogSendInput {
  /** content ID del producto en el catálogo (= slug de la propiedad). */
  retailerId: string;
  /** ¿está seteado `env.WHATSAPP_CATALOG_ID` en prod? */
  hasCatalogId: boolean;
  /** Resultado de `sendProductMessage`. `null` = no se intentó (falta el env). */
  sendOk: boolean | null;
  /** messageId de Meta cuando salió bien (para rastrear el envío). */
  messageId?: string | null;
  /** Error de `sendProductMessage` cuando falló. */
  error?: string | null;
}

/**
 * Clasifica el resultado del intento de mandar la tarjeta nativa en una de dos
 * cámaras de `bot_trace`. Cubre los TRES caminos por los que hoy se cae al texto:
 *   1. no hay `WHATSAPP_CATALOG_ID` en prod            → FALLBACK (el que la
 *      auditoría sospechaba que estaba tapado en silencio),
 *   2. hay catalog_id pero `sendProductMessage` falló  → FALLBACK (con el error),
 *   3. hay catalog_id y el envío salió bien            → SENT (la nativa se compartió).
 */
export function classifyCatalogSend(input: CatalogSendInput): CatalogSendOutcome {
  const { retailerId, hasCatalogId, sendOk, messageId, error } = input;

  if (!hasCatalogId) {
    return {
      sent: false,
      stage: "CATALOG_CARD_FALLBACK",
      detail: `${retailerId} · falta env WHATSAPP_CATALOG_ID → fallback a texto+fotos`,
    };
  }

  if (sendOk) {
    return {
      sent: true,
      stage: "CATALOG_CARD_SENT",
      detail: messageId ? `${retailerId} · msg ${messageId}` : retailerId,
    };
  }

  return {
    sent: false,
    stage: "CATALOG_CARD_FALLBACK",
    detail: `${retailerId} · ${error || "error desconocido"} → fallback a texto+fotos`,
  };
}
