/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/bot-qa-run
//
// Corre el análisis de QA del bot (revisa conversaciones, detecta fallos,
// guarda hallazgos). Lo dispara:
//   - el botón "Analizar" del Centro de Control → cookie de sesión del inbox.
//   - el cron diario → Authorization: Bearer <CRON_SECRET>.
//
// El panel "QA del bot" del dashboard lee los hallazgos vía /api/inbox/metrics.
//

import { requireInboxAuth } from "../../_lib/inbox-auth";
import { requireBearerAuth } from "../../_lib/admin-auth";
import { runQaAnalysis, type QaEnv } from "../../_lib/bot-qa";

interface Env extends QaEnv {
  INBOX_PASSWORD?: string;
  CRON_SECRET?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Auth flexible: cookie del inbox (botón) o Bearer CRON_SECRET (cron).
  const cookieAuth = await requireInboxAuth(request, env);
  let trigger: "boton" | "cron";
  if (cookieAuth.ok) {
    trigger = "boton";
  } else {
    const bearer = requireBearerAuth(request, env.CRON_SECRET, "CRON_SECRET");
    if (!bearer.ok) return cookieAuth.response!;
    trigger = "cron";
  }

  const result = await runQaAnalysis(env, trigger);
  return json({ ok: !result.error, analyzed: result.analyzed, found: result.found, error: result.error });
};
