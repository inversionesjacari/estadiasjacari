/// <reference types="@cloudflare/workers-types" />
//
// POST /api/inbox/logout — expira el cookie de sesión.
//

import { buildLogoutCookie } from "../../_lib/inbox-auth";

export const onRequestPost: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": buildLogoutCookie(),
    },
  });
};
