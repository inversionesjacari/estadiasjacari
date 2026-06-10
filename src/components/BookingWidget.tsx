"use client";

import { useEffect, useMemo, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { DayPicker, type DateRange } from "react-day-picker";
import { es } from "date-fns/locale";
import {
  format,
  differenceInDays,
  addDays,
  addMonths,
  isWithinInterval,
  isSameDay,
} from "date-fns";
import "react-day-picker/style.css";

const PAYPAL_CLIENT_ID =
  "AQYfxeAZGvq-HZ4Fz7RdENtJjGRCWKzILQBXlqixS6LdJN5FF7njl3w4ofXnaTMpZw6GugYCYiKK05gy";

const WHATSAPP_NUMBER = "50488390145";

interface BookingWidgetProps {
  propertyName: string;
  propertySlug: string;
  pricePerNightUSD: number;
  cleaningFeeUSD: number;
  pricePerNightHNL: number;
  cleaningFeeHNL: number;
}

/** Ventana máxima de reservas hacia el futuro (calendario y cobro). */
const MAX_MONTHS_AHEAD = 6;

interface AvailabilityResponse {
  slug: string;
  blockedDates: string[]; // YYYY-MM-DD
  lastSync: string;
  /** "full" = todo OK, "partial" = algunas fuentes fallaron, "unavailable" = ninguna fuente Airbnb respondió. */
  airbnbSyncStatus?: "full" | "partial" | "unavailable";
  /** Mensajes de warning si alguna fuente falló (env var faltante o fetch error). */
  warnings?: string[];
}

interface ExchangeRateResponse {
  rate: number; // HNL por 1 USD
  date: string | null; // YYYY-MM-DD
  source: string;
  lastSync: string;
}

/**
 * Fecha mínima de check-in:
 *  - Si la hora actual en Honduras (America/Tegucigalpa) es < 18:00 → HOY
 *  - Si es ≥ 18:00 → MAÑANA
 *
 * Independiente de la zona horaria del cliente (Madrid, México, etc.) — siempre
 * se compara contra la hora de Tegucigalpa para que la regla sea consistente.
 */
function getMinCheckInDate(): Date {
  const hnHourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tegucigalpa",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  const hnHour = parseInt(hnHourStr, 10);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return hnHour < 18 ? today : addDays(today, 1);
}

/** Convierte "YYYY-MM-DD" en un Date local a las 00:00 (sin saltos de TZ). */
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ── Validadores de form (Auditoría Sesión 2 — M2) ──────────────────────────
// Devuelven undefined si el valor es válido, o un string de error en español.
//
// Reglas conservadoras: queremos rechazar inputs claramente malos sin generar
// fricción en casos válidos. PayPal hace validación adicional al pagar.

function validateName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Ingresa tu nombre.";
  if (trimmed.length < 2) return "Nombre muy corto.";
  // Permitir nombres de una sola palabra (ej. apellidos compuestos con guion).
  // Lo que rechazamos: caracteres no-letra (números, símbolos extraños).
  if (!/^[\p{L}\p{M} '\-.]+$/u.test(trimmed)) {
    return "Usa solo letras, espacios, apóstrofes o guiones.";
  }
  return undefined;
}

function validateEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Ingresa tu correo electrónico.";
  // Regex pragmático — no busca cumplir RFC 5322 al pie de la letra,
  // solo descarta basura obvia.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return "El correo no parece válido.";
  }
  return undefined;
}

function validatePhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "Ingresa tu teléfono o WhatsApp.";
  // Mínimo 8 dígitos = números móviles de Honduras sin código país (8 dígitos).
  // Aceptamos más largos para incluir códigos de país internacionales.
  if (digits.length < 8) return "Número muy corto (mínimo 8 dígitos).";
  if (digits.length > 15) return "Número muy largo.";
  return undefined;
}

export default function BookingWidget({
  propertyName,
  propertySlug,
  pricePerNightUSD,
  cleaningFeeUSD,
  pricePerNightHNL,
  cleaningFeeHNL,
}: BookingWidgetProps) {
  // ── ESTADO DE DISPONIBILIDAD ────────────────────────────────────────────
  const [blockedDates, setBlockedDates] = useState<Date[]>([]);
  const [loadingAvailability, setLoadingAvailability] = useState(true);
  // `availabilityError` solo se setea si el endpoint falla COMPLETAMENTE
  // (network error, 5xx fatal). Para errores parciales (env vars faltantes o
  // fetches fallidos en algunas fuentes), usamos `availabilityWarning` que
  // muestra un banner amarillo sin bloquear el calendar.
  const [availabilityError, setAvailabilityError] = useState<string | null>(
    null,
  );
  const [availabilitySyncStatus, setAvailabilitySyncStatus] = useState<
    "full" | "partial" | "unavailable" | null
  >(null);

  // ── ESTADO DE TIPO DE CAMBIO USD/HNL ────────────────────────────────────
  // Si la API falla, queda en null y caemos al pricePerNightUSD hardcoded.
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [rateDate, setRateDate] = useState<string | null>(null);

  // ── ESTADO DE LA RESERVA ────────────────────────────────────────────────
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  // Calendario colapsable: arranca CERRADO (compacto, no abruma). Se abre al
  // tocar Llegada/Salida. En pantallas anchas muestra 2 meses (estilo Airbnb).
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [monthsToShow, setMonthsToShow] = useState(1);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => setMonthsToShow(mq.matches ? 2 : 1);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  // Errores de validación inline (Auditoría Sesión 2 — M2)
  const [formErrors, setFormErrors] = useState<{
    name?: string;
    email?: string;
    phone?: string;
  }>({});
  // Máquina de pasos: form → review → success
  // En "review", `paypalRevealed` controla si se muestran los botones
  // PayPal abajo (sin perder el resumen de arriba).
  const [step, setStep] = useState<"form" | "review" | "success">("form");
  const [paypalRevealed, setPaypalRevealed] = useState(false);
  const [orderId, setOrderId] = useState("");
  // Estado de revalidación pre-PayPal (Auditoría Sesión 2 — B1 frontend)
  const [revalidating, setRevalidating] = useState(false);
  // Mensaje cuando el usuario cancela el modal de PayPal (Auditoría — M1)
  const [paypalCancelMsg, setPaypalCancelMsg] = useState<string | null>(null);

  // ── EFECTO: cargar disponibilidad desde el endpoint ─────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadingAvailability(true);
    setAvailabilityError(null);

    fetch(`/api/availability/${propertySlug}`)
      .then(async (resp) => {
        if (!resp.ok) {
          const body = (await resp
            .json()
            .catch(() => ({}))) as { message?: string };
          throw new Error(
            body.message ||
              `Error HTTP ${resp.status} al consultar disponibilidad`,
          );
        }
        return resp.json() as Promise<AvailabilityResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setBlockedDates(data.blockedDates.map(parseIsoDate));
        setAvailabilitySyncStatus(data.airbnbSyncStatus ?? "full");
        setLoadingAvailability(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setAvailabilityError(err.message);
        setLoadingAvailability(false);
      });

    return () => {
      cancelled = true;
    };
  }, [propertySlug]);

  // ── EFECTO: cargar tipo de cambio USD/HNL del día ───────────────────────
  // Falla silenciosa — si no carga, usamos pricePerNightUSD hardcoded.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/exchange-rate`)
      .then((resp) => (resp.ok ? (resp.json() as Promise<ExchangeRateResponse>) : null))
      .then((data) => {
        if (cancelled || !data || typeof data.rate !== "number") return;
        setExchangeRate(data.rate);
        setRateDate(data.date);
      })
      .catch(() => {
        // Silencioso — fallback al hardcoded
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── CÁLCULOS DERIVADOS ──────────────────────────────────────────────────
  const minDate = useMemo(() => getMinCheckInDate(), []);
  // Fecha máxima reservable: 6 meses desde hoy. Después de esto el calendar
  // muestra todo bloqueado y el usuario debe consultar por WhatsApp.
  const maxDate = useMemo(() => {
    const max = addMonths(new Date(), MAX_MONTHS_AHEAD);
    max.setHours(0, 0, 0, 0);
    return max;
  }, []);

  const nights =
    range?.from && range?.to
      ? Math.max(0, differenceInDays(range.to, range.from))
      : 0;

  // Precio USD derivado: HNL / TC del día. Si el TC no cargó, fallback al
  // valor hardcoded en properties.ts (pricePerNightUSD, cleaningFeeUSD).
  const effectivePricePerNightUSD = exchangeRate
    ? pricePerNightHNL / exchangeRate
    : pricePerNightUSD;
  const effectiveCleaningFeeUSD = exchangeRate
    ? cleaningFeeHNL / exchangeRate
    : cleaningFeeUSD;

  const nightsTotalUSD = nights > 0 ? nights * effectivePricePerNightUSD : 0;
  const grandTotalUSD = nights > 0 ? nightsTotalUSD + effectiveCleaningFeeUSD : 0;
  const nightsTotalHNL = nights > 0 ? nights * pricePerNightHNL : 0;
  const grandTotalHNL = nights > 0 ? nightsTotalHNL + cleaningFeeHNL : 0;

  // Detecta si el rango seleccionado pisa una fecha bloqueada en medio.
  // react-day-picker previene clicks directos en disabled, pero un rango
  // que incluya un día bloqueado entre from y to debe rechazarse.
  const rangeHasBlockedDateInside = useMemo(() => {
    if (!range?.from || !range?.to) return false;
    return blockedDates.some((blocked) =>
      isWithinInterval(blocked, {
        start: range.from!,
        end: addDays(range.to!, -1), // checkout es exclusivo
      }) && !isSameDay(blocked, range.to!),
    );
  }, [range, blockedDates]);

  // ── Noche ocupada vs. día de recambio (check-out) ──────────────────────────
  // En hospedaje, una noche ocupada (ej. la noche del 11) NO impide salir ese
  // mismo día: quien llegó antes hace check-out por la mañana y el próximo
  // huésped entra por la tarde. Por eso el PRIMER día de cada bloque ocupado debe
  // poder elegirse como CHECK-OUT. Solo los días ocupados cuyo día ANTERIOR
  // también está ocupado (noches intermedias del bloque) se mantienen
  // deshabilitados — ahí sí tendrías que dormir una noche ya tomada.
  const isBlockedNight = (day: Date) =>
    blockedDates.some((b) => isSameDay(b, day));
  const disabledBlocked = useMemo(
    () => blockedDates.filter((b) => blockedDates.some((x) => isSameDay(x, addDays(b, -1)))),
    [blockedDates],
  );
  // Días "solo salida": el primer día de cada bloque ocupado (su noche está
  // tomada, pero sirve de check-out). Se marcan con la etiqueta "Solo salida".
  const checkoutOnlyDays = useMemo(
    () => blockedDates.filter((b) => !blockedDates.some((x) => isSameDay(x, addDays(b, -1)))),
    [blockedDates],
  );

  const handleProceed = () => {
    // Validación inline — sin alert(), errores junto a cada input
    const errors = {
      name: validateName(guestName),
      email: validateEmail(guestEmail),
      phone: validatePhone(guestPhone),
    };
    setFormErrors(errors);

    if (errors.name || errors.email || errors.phone) {
      return; // Los errores se muestran inline; usuario corrige.
    }

    if (nights <= 0 || rangeHasBlockedDateInside) {
      // Caso defensivo — el botón ya está disabled cuando esto pasa.
      return;
    }
    setStep("review");
  };

  // Revalida disponibilidad pegándole de nuevo al endpoint ANTES de mostrar
  // los botones PayPal. Evita doble booking en el window form → pago: alguien
  // pudo haber reservado las mismas fechas mientras este usuario llenaba el
  // form. Si el rango sigue libre → mostrar PayPal. Si está tomado → resetear.
  //
  // Fail-open: si la revalidación falla por red/server, mostramos PayPal igual
  // (mejor permitir un cobro que quede en cancelled vía detección server-side
  // que bloquear UX por bug nuestro).
  const handleConfirmAndShowPayPal = async () => {
    if (!range?.from || !range?.to) return;
    setRevalidating(true);
    setPaypalCancelMsg(null);
    try {
      const resp = await fetch(`/api/availability/${propertySlug}`, {
        cache: "no-store",
      });
      if (resp.ok) {
        const data = (await resp.json()) as AvailabilityResponse;
        const freshBlocked = data.blockedDates.map(parseIsoDate);
        const stillFree = !freshBlocked.some((blocked) =>
          isWithinInterval(blocked, {
            start: range.from!,
            end: addDays(range.to!, -1),
          }) && !isSameDay(blocked, range.to!),
        );
        if (!stillFree) {
          alert(
            "Lo sentimos — alguien acaba de reservar esas fechas. " +
              "Selecciona otras del calendario.",
          );
          setBlockedDates(freshBlocked);
          setRange(undefined);
          setStep("form");
          setRevalidating(false);
          return;
        }
      }
      // OK (resp.ok=true sin overlap, o resp.ok=false fail-open) → mostrar PayPal
      setPaypalRevealed(true);
    } catch {
      // Network error — fail-open
      setPaypalRevealed(true);
    } finally {
      setRevalidating(false);
    }
  };

  // ── PANTALLA DE CONFIRMACIÓN ────────────────────────────────────────────
  if (step === "success") {
    const checkInStr = range?.from ? format(range.from, "yyyy-MM-dd") : "";
    const checkOutStr = range?.to ? format(range.to, "yyyy-MM-dd") : "";
    const waText = encodeURIComponent(
      `¡Hola! Acabo de confirmar mi reserva en ${propertyName} del ${checkInStr} al ${checkOutStr}. ` +
        `Mi nombre es ${guestName}. Número de orden PayPal: ${orderId}`,
    );
    return (
      <div className="bg-white rounded-2xl border border-green-200 shadow-card p-6 text-center sticky top-24">
        <div className="text-5xl mb-3">✅</div>
        <h3 className="font-bold text-green-700 text-xl mb-2">
          ¡Reserva confirmada!
        </h3>
        <p className="text-gray-600 text-sm mb-4">
          Tu pago fue procesado exitosamente. Recibirás una confirmación de
          PayPal en tu correo.
        </p>
        <div className="bg-green-50 rounded-xl p-4 text-sm text-left space-y-1 mb-4">
          <p>
            <span className="font-semibold">Huésped:</span> {guestName}
          </p>
          <p>
            <span className="font-semibold">Propiedad:</span> {propertyName}
          </p>
          <p>
            <span className="font-semibold">Check-in:</span> {checkInStr}{" "}
            <span className="text-gray-500">(3:00 PM)</span>
          </p>
          <p>
            <span className="font-semibold">Check-out:</span> {checkOutStr}{" "}
            <span className="text-gray-500">(11:00 AM)</span>
          </p>
          <p>
            <span className="font-semibold">Noches:</span> {nights}
          </p>
          <p>
            <span className="font-semibold">Total pagado:</span> L.{" "}
            {grandTotalHNL.toLocaleString()}{" "}
            <span className="text-xs text-gray-500">
              (USD ${grandTotalUSD.toFixed(2)})
            </span>
          </p>
          <p>
            <span className="font-semibold">Orden:</span>{" "}
            <span className="text-xs text-gray-500">{orderId}</span>
          </p>
        </div>
        <a
          href={`https://wa.me/${WHATSAPP_NUMBER}?text=${waText}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block w-full bg-green-500 text-white py-3 rounded-xl font-semibold text-sm hover:bg-green-600 transition"
        >
          Confirmar llegada por WhatsApp →
        </a>
        <p className="text-xs text-gray-400 mt-3">
          Un día antes de tu check-in nos pondremos en contacto contigo.
        </p>
      </div>
    );
  }

  // ── FALLBACK: endpoint de disponibilidad falló ──────────────────────────
  if (availabilityError) {
    const waText = encodeURIComponent(
      `Hola, quiero reservar ${propertyName} pero el calendario del sitio no carga. ¿Pueden ayudarme?`,
    );
    return (
      <div className="bg-white rounded-2xl border border-red-200 shadow-card p-6 sticky top-24">
        <div className="mb-4">
          <h3 className="text-base font-bold text-primary mb-1">
            Reservar {propertyName}
          </h3>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-sm">
          <p className="font-semibold text-red-700 mb-2">
            ⚠️ Disponibilidad no disponible
          </p>
          <p className="text-red-600 mb-4 leading-relaxed">
            No pudimos verificar las fechas disponibles en este momento.
            Contáctanos por WhatsApp y te confirmamos disponibilidad y tarifas
            en menos de 1 hora.
          </p>
          <a
            href={`https://wa.me/${WHATSAPP_NUMBER}?text=${waText}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-accent w-full"
          >
            Consultar por WhatsApp
          </a>
          <p className="text-xs text-red-400 mt-3">
            Detalle técnico: {availabilityError}
          </p>
        </div>
      </div>
    );
  }

  // ── FORMULARIO PRINCIPAL ────────────────────────────────────────────────
  return (
    <PayPalScriptProvider
      options={{ clientId: PAYPAL_CLIENT_ID, currency: "USD", locale: "es_MX" }}
    >
      <div className="bg-white rounded-2xl border border-gray-200 shadow-card p-6 sticky top-24">
        {/* Precio */}
        <div className="mb-5">
          <h3 className="text-base font-bold text-primary mb-1">
            Reservar ahora
          </h3>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-primary">
              L. {pricePerNightHNL.toLocaleString()}
            </span>
            <span className="text-gray-500 text-sm">/ noche</span>
          </div>
        </div>

        {/* (Nota: cuando `availabilitySyncStatus !== "full"`, el sync con Airbnb
            está degradado y el calendar no refleja todas las fechas bloqueadas
            externas. No mostramos banner para no ensuciar la UI — el riesgo se
            mitiga porque el sitio acepta solo reservas con cobro directo y el
            staff puede gestionar conflictos manualmente vía WhatsApp.) */}

        {/* Fechas — COLAPSADO al inicio (no abruma); el calendario se despliega
            al tocar Llegada/Salida, estilo Airbnb (2 meses en desktop). */}
        <div className="mb-4 relative">
          <div className="grid grid-cols-2 rounded-xl border border-gray-300 overflow-hidden">
            <button
              type="button"
              onClick={() => setCalendarOpen((o) => !o)}
              className={`text-left px-3 py-2.5 transition ${calendarOpen ? "ring-2 ring-primary ring-inset" : "hover:bg-gray-50"}`}
            >
              <div className="text-[10px] font-bold text-primary tracking-wide">LLEGADA</div>
              <div className={`text-sm ${range?.from ? "text-primary font-medium" : "text-gray-400"}`}>
                {range?.from ? format(range.from, "EEE d MMM", { locale: es }) : "Agregar fecha"}
              </div>
            </button>
            <button
              type="button"
              onClick={() => setCalendarOpen(true)}
              className="text-left px-3 py-2.5 border-l border-gray-300 hover:bg-gray-50 transition"
            >
              <div className="text-[10px] font-bold text-primary tracking-wide">SALIDA</div>
              <div className={`text-sm ${range?.to ? "text-primary font-medium" : "text-gray-400"}`}>
                {range?.to ? format(range.to, "EEE d MMM", { locale: es }) : "Agregar fecha"}
              </div>
            </button>
          </div>

          {calendarOpen && (
            <>
              {/* backdrop: cerrar al tocar afuera */}
              <div className="fixed inset-0 z-30" onClick={() => setCalendarOpen(false)} aria-hidden />
              <div className="absolute z-40 top-full right-0 mt-2 bg-white rounded-2xl shadow-2xl border border-gray-200 p-4 w-[min(640px,calc(100vw-2rem))]">
                {loadingAvailability ? (
                  <div className="animate-pulse bg-gray-100 rounded-xl h-64" />
                ) : (
                  <DayPicker
                    mode="range"
                    selected={range}
                    onSelect={(r) => {
                      // Un día ocupado puede ser CHECK-OUT (recambio) pero NUNCA
                      // CHECK-IN. Si el inicio cae en una noche ocupada, descartar.
                      if (r?.from && isBlockedNight(r.from)) {
                        setRange(undefined);
                        return;
                      }
                      setRange(r);
                      setStep("form");
                      setPaypalRevealed(false);
                      if (r?.from && r?.to) setCalendarOpen(false); // rango completo → cerrar
                    }}
                    disabled={[
                      { before: minDate },
                      { after: maxDate },
                      ...disabledBlocked, // solo las noches intermedias de cada bloque
                    ]}
                    modifiers={{ checkoutOnly: checkoutOnlyDays }}
                    modifiersClassNames={{ checkoutOnly: "[&_button]:!text-gray-400 [&_button]:hover:!ring-gray-300" }}
                    components={{
                      DayButton: ({ day: _day, modifiers, ...buttonProps }) => (
                        <button
                          {...buttonProps}
                          title={modifiers.checkoutOnly ? "Solo salida (check-out)" : undefined}
                        />
                      ),
                    }}
                    startMonth={minDate}
                    endMonth={maxDate}
                    numberOfMonths={monthsToShow}
                    locale={es}
                    weekStartsOn={1}
                    showOutsideDays={false}
                    classNames={{
                      months: "flex gap-6 justify-center",
                      month_caption: "text-primary font-semibold text-sm mb-3 text-center capitalize",
                      caption_label: "text-primary",
                      chevron: "fill-primary",
                      weekday: "text-muted text-[11px] font-normal",
                      day: "text-sm",
                      day_button: "w-9 h-9 rounded-full font-medium text-primary hover:ring-1 hover:ring-primary/40 transition",
                      today: "font-bold",
                      selected: "!bg-primary !text-white",
                      range_start: "[&_button]:!bg-primary [&_button]:!text-white [&_button]:!rounded-full",
                      range_end: "[&_button]:!bg-primary [&_button]:!text-white [&_button]:!rounded-full",
                      range_middle: "[&_button]:!bg-secondary/15 [&_button]:!text-primary [&_button]:!rounded-none",
                      disabled: "[&_button]:line-through [&_button]:!text-gray-300 [&_button]:cursor-not-allowed [&_button]:hover:!ring-0",
                    }}
                  />
                )}
                <div className="flex justify-between items-center mt-3 pt-3 border-t border-gray-100">
                  <button type="button" onClick={() => setRange(undefined)} className="text-sm font-semibold text-primary underline">
                    Borrar fechas
                  </button>
                  <button type="button" onClick={() => setCalendarOpen(false)} className="bg-primary text-white text-sm font-semibold px-5 py-2 rounded-lg hover:bg-primary/90 transition">
                    Listo
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Aviso si el rango pisa fecha bloqueada */}
        {rangeHasBlockedDateInside && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-xs text-red-700">
            ⚠️ El rango seleccionado incluye fechas no disponibles. Escoge otro
            rango.
          </div>
        )}

        {/* Resumen de precio */}
        {nights > 0 && !rangeHasBlockedDateInside && (
          <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">
                L. {pricePerNightHNL.toLocaleString()} × {nights}{" "}
                {nights === 1 ? "noche" : "noches"}
              </span>
              <span className="font-medium">
                L. {nightsTotalHNL.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Costo de limpieza (único)</span>
              <span className="font-medium">
                L. {cleaningFeeHNL.toLocaleString()}
              </span>
            </div>
            <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-primary text-base">
              <span>Total</span>
              <span>L. {grandTotalHNL.toLocaleString()}</span>
            </div>
          </div>
        )}

        {/* Datos del huésped — validación inline (Auditoría M2) */}
        {step === "form" && (
          <div className="space-y-3 mb-4">
            <div>
              <input
                type="text"
                placeholder="Nombre completo"
                value={guestName}
                onChange={(e) => {
                  setGuestName(e.target.value);
                  if (formErrors.name) {
                    setFormErrors({ ...formErrors, name: undefined });
                  }
                }}
                onBlur={() =>
                  setFormErrors({
                    ...formErrors,
                    name: validateName(guestName),
                  })
                }
                aria-invalid={!!formErrors.name}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                  formErrors.name
                    ? "border-red-300 focus:ring-red-300"
                    : "border-gray-200 focus:ring-secondary"
                }`}
              />
              {formErrors.name && (
                <p className="text-xs text-red-600 mt-1">{formErrors.name}</p>
              )}
            </div>
            <div>
              <input
                type="email"
                placeholder="Correo electrónico"
                value={guestEmail}
                onChange={(e) => {
                  setGuestEmail(e.target.value);
                  if (formErrors.email) {
                    setFormErrors({ ...formErrors, email: undefined });
                  }
                }}
                onBlur={() =>
                  setFormErrors({
                    ...formErrors,
                    email: validateEmail(guestEmail),
                  })
                }
                aria-invalid={!!formErrors.email}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                  formErrors.email
                    ? "border-red-300 focus:ring-red-300"
                    : "border-gray-200 focus:ring-secondary"
                }`}
              />
              {formErrors.email && (
                <p className="text-xs text-red-600 mt-1">{formErrors.email}</p>
              )}
            </div>
            <div>
              <input
                type="tel"
                placeholder="Teléfono / WhatsApp"
                value={guestPhone}
                onChange={(e) => {
                  setGuestPhone(e.target.value);
                  if (formErrors.phone) {
                    setFormErrors({ ...formErrors, phone: undefined });
                  }
                }}
                onBlur={() =>
                  setFormErrors({
                    ...formErrors,
                    phone: validatePhone(guestPhone),
                  })
                }
                aria-invalid={!!formErrors.phone}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                  formErrors.phone
                    ? "border-red-300 focus:ring-red-300"
                    : "border-gray-200 focus:ring-secondary"
                }`}
              />
              {formErrors.phone && (
                <p className="text-xs text-red-600 mt-1">{formErrors.phone}</p>
              )}
            </div>
            <button
              onClick={handleProceed}
              disabled={nights <= 0 || rangeHasBlockedDateInside}
              className="w-full bg-accent text-white py-3 rounded-xl font-semibold text-sm hover:brightness-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nights > 0 && !rangeHasBlockedDateInside
                ? "Continuar →"
                : "Selecciona las fechas"}
            </button>

            {/* Nota única sobre el cobro */}
            <p className="text-xs text-gray-500 leading-relaxed mt-1">
              El cobro se procesa en dólares estadounidenses (USD) porque
              PayPal no acepta Lempiras. El monto exacto en tu tarjeta lo
              determinará tu banco según su tipo de cambio del día.
            </p>
          </div>
        )}

        {/* Pantalla de revisión — paso intermedio antes del pago */}
        {step === "review" && nights > 0 && !rangeHasBlockedDateInside && (
          <div className="space-y-4 mb-4">
            <h4 className="text-sm font-bold text-primary">
              Revisa tu reserva
            </h4>

            {/* Propiedad y fechas */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-3 text-sm">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">
                  Propiedad
                </p>
                <p className="font-semibold text-primary">{propertyName}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">
                    Check-in
                  </p>
                  <p className="font-medium text-primary">
                    {range?.from &&
                      format(range.from, "d 'de' MMM yyyy", { locale: es })}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">
                    Check-out
                  </p>
                  <p className="font-medium text-primary">
                    {range?.to &&
                      format(range.to, "d 'de' MMM yyyy", { locale: es })}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">
                  Noches
                </p>
                <p className="font-medium text-primary">
                  {nights} {nights === 1 ? "noche" : "noches"}
                </p>
              </div>
            </div>

            {/* Desglose de precio */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">
                Desglose
              </p>
              <div className="flex justify-between">
                <span className="text-gray-600">
                  L. {pricePerNightHNL.toLocaleString()} × {nights}{" "}
                  {nights === 1 ? "noche" : "noches"}
                </span>
                <span className="font-medium">
                  L. {nightsTotalHNL.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Costo de limpieza (único)</span>
                <span className="font-medium">
                  L. {cleaningFeeHNL.toLocaleString()}
                </span>
              </div>
              <div className="border-t border-gray-200 pt-2 mt-1 flex justify-between font-bold text-primary text-base">
                <span>Total</span>
                <span>L. {grandTotalHNL.toLocaleString()}</span>
              </div>
              <p className="text-xs text-gray-500 text-right">
                ≈ USD ${grandTotalUSD.toFixed(2)}
              </p>
            </div>

            {/* Datos del huésped */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-1 text-sm">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-2">
                Datos del huésped
              </p>
              <p className="font-semibold text-primary">{guestName}</p>
              <p className="text-gray-600 text-xs">{guestEmail}</p>
              <p className="text-gray-600 text-xs">{guestPhone}</p>
            </div>

            {/* Disclaimer USD */}
            <p className="text-xs text-gray-500 leading-relaxed">
              El cobro se procesa en dólares estadounidenses (USD) porque
              PayPal no acepta Lempiras. El monto exacto en tu tarjeta lo
              determinará tu banco según su tipo de cambio del día.
            </p>

            {/* Mensaje si el usuario canceló el modal de PayPal (Auditoría M1) */}
            {paypalCancelMsg && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                {paypalCancelMsg}
              </div>
            )}

            {/* Botones / PayPal */}
            {!paypalRevealed ? (
              <div className="space-y-2">
                <button
                  onClick={handleConfirmAndShowPayPal}
                  disabled={revalidating}
                  className="w-full bg-accent text-white py-3 rounded-xl font-semibold text-sm hover:brightness-95 transition disabled:opacity-60 disabled:cursor-wait"
                >
                  {revalidating
                    ? "Verificando disponibilidad..."
                    : `Confirmar y pagar L. ${grandTotalHNL.toLocaleString()}`}
                </button>
                <button
                  onClick={() => {
                    setStep("form");
                    setPaypalCancelMsg(null);
                  }}
                  disabled={revalidating}
                  className="w-full text-gray-500 text-xs py-2 hover:text-gray-700 transition disabled:opacity-60"
                >
                  ← Volver a editar
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <PayPalButtons
                  style={{
                    layout: "vertical",
                    color: "gold",
                    shape: "rect",
                    label: "pay",
                  }}
                  createOrder={(_data, actions) => {
                    const checkInIso = format(range!.from!, "yyyy-MM-dd");
                    const checkOutIso = format(range!.to!, "yyyy-MM-dd");
                    // Garantizar consistencia matemática: item_total + handling == total.
                    // PayPal rechaza el order si el breakdown no suma exactamente al
                    // value total con 2 decimales (causa de "Hubo un error con el pago").
                    const itemTotalStr = nightsTotalUSD.toFixed(2);
                    const handlingStr = effectiveCleaningFeeUSD.toFixed(2);
                    const grandTotalStr = (
                      parseFloat(itemTotalStr) + parseFloat(handlingStr)
                    ).toFixed(2);
                    // Phone normalizado (solo dígitos) para incluir en custom_id —
                    // el webhook lo usa para generar el link wa.me en el email de
                    // confirmación, y futuro WhatsApp push automático (Fase 5).
                    const phoneDigits = guestPhone.replace(/\D/g, "");
                    // Args del order tipados localmente — el tipo del SDK
                    // (`Parameters<typeof actions.order.create>[0]`) es muy
                    // restrictivo y no incluye `intent` ni `application_context`
                    // (ambos válidos en la REST API real). Definimos el shape
                    // exacto que necesitamos y lo casteamos UNA sola vez al
                    // tipo que espera el SDK.
                    type PayPalOrderRequest = {
                      intent: "CAPTURE";
                      application_context?: {
                        shipping_preference?: "NO_SHIPPING";
                      };
                      purchase_units: Array<{
                        amount: {
                          currency_code: string;
                          value: string;
                          breakdown?: {
                            item_total: { currency_code: string; value: string };
                            handling: { currency_code: string; value: string };
                          };
                        };
                        description?: string;
                        custom_id?: string;
                      }>;
                    };
                    const args: PayPalOrderRequest = {
                      intent: "CAPTURE",
                      application_context: { shipping_preference: "NO_SHIPPING" },
                      purchase_units: [
                        {
                          amount: {
                            currency_code: "USD",
                            value: grandTotalStr,
                            breakdown: {
                              item_total: {
                                currency_code: "USD",
                                value: itemTotalStr,
                              },
                              handling: {
                                currency_code: "USD",
                                value: handlingStr,
                              },
                            },
                          },
                          description: `Reserva ${propertyName} — ${nights} noches (${checkInIso} al ${checkOutIso})`,
                          // Formato: slug|checkIn|checkOut|email|phone (5 partes).
                          // El webhook (functions/api/paypal-webhook.ts) parsea este string.
                          custom_id: `${propertySlug}|${checkInIso}|${checkOutIso}|${guestEmail}|${phoneDigits}`,
                        },
                      ],
                    };
                    type CreateArgs = Parameters<typeof actions.order.create>[0];
                    return actions.order.create(args as unknown as CreateArgs);
                  }}
                  onApprove={async (data, actions) => {
                    await actions.order?.capture();
                    setOrderId(data.orderID);
                    setStep("success");
                  }}
                  onCancel={() => {
                    // Auditoría M1 — usuario cerró modal PayPal sin pagar.
                    // Volvemos a la pantalla de revisión con mensaje claro
                    // y permitimos reintentar. Las fechas siguen seleccionadas.
                    setPaypalRevealed(false);
                    setPaypalCancelMsg(
                      "Cancelaste el pago. Tus fechas siguen seleccionadas — puedes reintentar cuando quieras.",
                    );
                  }}
                  onError={(err) => {
                    // Log detallado en consola para debug; alert simple para el usuario.
                    console.error("PayPal onError:", err);
                    alert(
                      "Hubo un error con el pago. Por favor intenta de nuevo o contáctanos por WhatsApp al +504 8839-0145.",
                    );
                  }}
                />
                <button
                  onClick={() => setPaypalRevealed(false)}
                  className="w-full text-gray-500 text-xs py-2 hover:text-gray-700 transition"
                >
                  ← Volver a editar
                </button>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-gray-400 text-center mt-4">
          🔒 Pago 100% seguro vía PayPal · Sin cargos ocultos
        </p>
      </div>
    </PayPalScriptProvider>
  );
}
