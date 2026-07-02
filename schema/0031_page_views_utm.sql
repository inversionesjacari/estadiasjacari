-- 0031_page_views_utm.sql
--
-- Atribución REAL de tráfico vía parámetros UTM. El `referrer` (document.referrer)
-- es poco confiable: Instagram/Facebook y sus apps ocultan el origen → la mayoría
-- cae como "(directo)". La solución estándar es que la pauta etiquete sus links con
-- ?utm_source=instagram&utm_medium=paid&utm_campaign=<nombre>, y acá los guardamos.
--
-- Columnas nuevas (nullable → no rompe inserts viejos ni datos existentes).

ALTER TABLE page_views ADD COLUMN utm_source   TEXT;
ALTER TABLE page_views ADD COLUMN utm_medium   TEXT;
ALTER TABLE page_views ADD COLUMN utm_campaign TEXT;
