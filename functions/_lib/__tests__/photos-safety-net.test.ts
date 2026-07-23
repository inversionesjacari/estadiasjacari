import { describe, it, expect } from "vitest";
import { T } from "../i18n";
import { getGalleryUrl, getCatalogUrl } from "../property-photos";

//
// Red de fotos (2026-07-23, casos Soler/gregorio con el cerebro degradado): el
// prompt hace que el LLM diga "¡Claro! Te mando algunas fotos 📸" confiando en
// que el código adjunte la galería. Cuando NO había galería (o el intent llegaba
// sin propiedad válida), la promesa se fugaba como texto suelto y el cliente se
// quedaba esperando fotos que nunca llegaban → pedía humano, lead perdido.
//
// Regla dura: si el bot NO adjunta fotos, la respuesta manda un LINK (a la ficha
// o al catálogo) — nunca la promesa a secas. Estos tests fijan esa garantía en
// las cadenas de fallback (la parte pura; el ruteo por intent se valida e2e).
//
describe("red de fotos — sin adjunto va un link, jamás la promesa vacía", () => {
  it("photosViaLink lleva la URL de la ficha de la propiedad", () => {
    const url = getGalleryUrl("casa-brisa");
    const msg = T.photosViaLink("es", url);
    expect(msg).toContain(url);
    expect(msg).toContain("estadiasjacari.com/propiedades/casa-brisa");
  });

  it("photosCatalog lleva la URL del catálogo y pregunta de cuál mostrar", () => {
    const url = getCatalogUrl();
    expect(url).toBe("https://estadiasjacari.com/propiedades");
    const msg = T.photosCatalog("es", url);
    expect(msg).toContain(url);
    expect(msg.toLowerCase()).toContain("propiedades");
  });

  it("los fallbacks SIEMPRE traen un link http (es y en) — nunca solo el 'te mando fotos'", () => {
    for (const lang of ["es", "en"] as const) {
      expect(T.photosViaLink(lang, getGalleryUrl("villa-b11-palma-real"))).toMatch(/https?:\/\//);
      expect(T.photosCatalog(lang, getCatalogUrl())).toMatch(/https?:\/\//);
    }
  });
});
