import { describe, it, expect } from "vitest";
import {
  guestIdKey,
  extForMime,
  GUEST_ID_ACCEPTED_MIMES,
  putGuestId,
  getGuestId,
  deleteGuestId,
} from "../guest-id-store";

//
// SEGURIDAD-VB11 Fase 2 (foto de ID en R2). El binario es PII → bucket privado.
// Estos tests fijan las partes puras (key/mime) y el fail-soft cuando el binding
// GUEST_IDS todavía no está configurado en el dashboard (no debe romper el inbox).
//

describe("guestIdKey / extForMime", () => {
  it("solo acepta JPG y PNG (Meta header image no acepta otros)", () => {
    expect(GUEST_ID_ACCEPTED_MIMES.has("image/jpeg")).toBe(true);
    expect(GUEST_ID_ACCEPTED_MIMES.has("image/png")).toBe(true);
    expect(GUEST_ID_ACCEPTED_MIMES.has("image/webp")).toBe(false);
    expect(GUEST_ID_ACCEPTED_MIMES.has("application/pdf")).toBe(false);
  });
  it("key estable por reserva con la extensión del mime", () => {
    expect(guestIdKey(42, "image/jpeg")).toBe("guest-ids/res-42.jpg");
    expect(guestIdKey(7, "image/png")).toBe("guest-ids/res-7.png");
  });
  it("extForMime cae a 'bin' para mimes desconocidos", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/gif")).toBe("bin");
  });
});

describe("fail-soft sin binding GUEST_IDS (bucket aún no creado)", () => {
  it("putGuestId devuelve false, getGuestId null, deleteGuestId no lanza", async () => {
    const env = {}; // sin GUEST_IDS
    expect(await putGuestId(env, "k", new Uint8Array([1]), "image/jpeg")).toBe(false);
    expect(await getGuestId(env, "k")).toBeNull();
    await expect(deleteGuestId(env, "k")).resolves.toBeUndefined();
  });
});

describe("con binding R2 (stub): guarda con content-type y recupera", () => {
  it("put → get devuelve los bytes + mime; delete borra", async () => {
    const store = new Map<string, { bytes: ArrayBuffer; mime: string }>();
    const env = {
      GUEST_IDS: {
        async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
          store.set(key, { bytes, mime: opts?.httpMetadata?.contentType ?? "" });
        },
        async get(key: string) {
          const v = store.get(key);
          if (!v) return null;
          return { arrayBuffer: async () => v.bytes, httpMetadata: { contentType: v.mime } };
        },
        async delete(key: string) {
          store.delete(key);
        },
      },
    } as unknown as { GUEST_IDS: R2Bucket };

    const key = guestIdKey(9, "image/png");
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    expect(await putGuestId(env, key, bytes, "image/png")).toBe(true);

    const got = await getGuestId(env, key);
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/png");
    expect(new Uint8Array(got!.bytes)).toEqual(new Uint8Array([1, 2, 3]));

    await deleteGuestId(env, key);
    expect(await getGuestId(env, key)).toBeNull();
  });
});
