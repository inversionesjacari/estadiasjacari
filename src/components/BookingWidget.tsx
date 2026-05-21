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
  const [availabilityError, setAvailabilityError] = useState<string | null>(
    null,
  );
  const [lastSync, setLastSync] = useState<string | null>(null);

  // ── ESTADO DE TIPO DE CAMBIO USD/HNL ────────────────────────────────────
  // Si la API falla, queda en null y caemos al pricePerNightUSD hardcoded.
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [rateDate, setRateDate] = useState<string | null>(null);

  // ── ESTADO DE LA RESERVA ────────────────────────────────────────────────
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [showPayPal, setShowPayPal] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [orderId, setOrderId] = useState("");

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
        setLastSync(data.lastSync);
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

  const handleProceed = () => {
    if (!guestName.trim() || !guestEmail.trim() || !guestPhone.trim()) {
      alert("Por favor completa tu nombre, correo y teléfono.");
      return;
    }
    if (nights <= 0) {
      alert("Por favor selecciona fechas válidas.");
      return;
    }
    if (rangeHasBlockedDateInside) {
      alert(
        "El rango seleccionado incluye fechas no disponibles. Por favor escoge otro.",
      );
      setRange(undefined);
      return;
    }
    setShowPayPal(true);
  };

  // ── PANTALLA DE CONFIRMACIÓN ────────────────────────────────────────────
  if (paymentSuccess) {
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
            <span className="font-semibold">Propiedad:</span> {propertyName}
          </p>
          <p>
            <span className="font-semibold">Check-in:</span> {checkInStr}
          </p>
          <p>
            <span className="font-semibold">Check-out:</span> {checkOutStr}
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
          Nos pondremos en contacto contigo en menos de 24 horas.
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
      options={{ clientId: PAYPAL_CLIENT_ID, currency: "USD" }}
    >
      <div className="bg-white rounded-2xl border border-gray-200 shadow-card p-6 sticky top-24">
        {/* Precio */}
        <div className="mb-4">
          <h3 className="text-base font-bold text-primary mb-1">
            Reservar ahora
          </h3>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-primary">
              L. {pricePerNightHNL.toLocaleString()}
            </span>
            <span className="text-gray-500 text-sm">/ noche</span>
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            ≈ USD ${effectivePricePerNightUSD.toFixed(2)}
            {exchangeRate && ` · referencia TC L. ${exchangeRate.toFixed(2)}`}
          </p>
        </div>

        {/* Disclaimer: cómo funciona el cobro */}
        <div className="bg-secondary/5 border border-secondary/20 rounded-xl p-3 mb-5 text-xs text-gray-600 leading-relaxed">
          <p className="flex items-start gap-1.5">
            <span aria-hidden className="text-secondary flex-shrink-0 mt-0.5">
              ℹ️
            </span>
            <span>
              <span className="font-semibold text-primary">
                Sobre el cobro:
              </span>{" "}
              PayPal procesa pagos en dólares estadounidenses (USD), no en
              Lempiras. La tasa de cambio que mostramos
              {exchangeRate ? ` (L. ${exchangeRate.toFixed(2)} = $1 USD)` : ""}{" "}
              es{" "}
              <span className="font-semibold">solo una referencia del día</span>
              . El monto final en Lempiras que verás en tu tarjeta lo
              determinará el banco emisor según su propio tipo de cambio, por
              lo que puede variar ligeramente del valor mostrado aquí.
            </span>
          </p>
        </div>

        {/* Calendario de fechas */}
        <div className="mb-4">
          <label className="text-xs text-gray-500 font-medium block mb-2">
            Selecciona tus fechas
          </label>

          {loadingAvailability ? (
            <div className="animate-pulse bg-gray-100 rounded-xl h-72" />
          ) : (
            <div className="overflow-x-auto -mx-2 px-2">
              <DayPicker
                mode="range"
                selected={range}
                onSelect={(r) => {
                  setRange(r);
                  setShowPayPal(false);
                }}
                disabled={[
                  { before: minDate },
                  { after: maxDate },
                  ...blockedDates,
                ]}
                startMonth={minDate}
                endMonth={maxDate}
                numberOfMonths={1}
                locale={es}
                weekStartsOn={1}
                showOutsideDays={false}
                classNames={{
                  month_caption:
                    "text-primary font-display text-base mb-2 capitalize",
                  caption_label: "text-primary",
                  chevron: "fill-primary",
                  weekday: "text-muted text-xs font-medium uppercase",
                  day: "text-sm",
                  day_button:
                    "w-9 h-9 rounded-md hover:bg-secondary/10 transition",
                  today: "font-bold text-accent",
                  selected: "!bg-primary !text-white",
                  range_start:
                    "rounded-l-md [&_button]:!bg-primary [&_button]:!text-white",
                  range_end:
                    "rounded-r-md [&_button]:!bg-primary [&_button]:!text-white",
                  range_middle:
                    "[&_button]:bg-secondary/20 [&_button]:!text-primary",
                  disabled:
                    "line-through text-gray-300 cursor-not-allowed opacity-50",
                }}
              />
            </div>
          )}

          {lastSync && !loadingAvailability && (
            <p className="text-xs text-gray-400 mt-2 text-center">
              Disponibilidad actualizada{" "}
              {new Date(lastSync).toLocaleString("es-HN", {
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "short",
              })}
            </p>
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
            <div className="border-t border-gray-200 pt-2 space-y-1">
              <div className="flex justify-between font-bold text-primary text-base">
                <span>Total</span>
                <span>L. {grandTotalHNL.toLocaleString()}</span>
              </div>
              <p className="text-xs text-gray-400 text-right">
                ≈ USD ${grandTotalUSD.toFixed(2)} (referencia)
              </p>
            </div>
          </div>
        )}

        {/* Datos del huésped */}
        {!showPayPal && (
          <div className="space-y-3 mb-4">
            <input
              type="text"
              placeholder="Nombre completo"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary"
            />
            <input
              type="email"
              placeholder="Correo electrónico"
              value={guestEmail}
              onChange={(e) => setGuestEmail(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary"
            />
            <input
              type="tel"
              placeholder="Teléfono / WhatsApp"
              value={guestPhone}
              onChange={(e) => setGuestPhone(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-secondary"
            />
            <button
              onClick={handleProceed}
              disabled={nights <= 0 || rangeHasBlockedDateInside}
              className="w-full bg-accent text-white py-3 rounded-xl font-semibold text-sm hover:brightness-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nights > 0 && !rangeHasBlockedDateInside
                ? `Pagar L. ${grandTotalHNL.toLocaleString()}`
                : "Selecciona las fechas"}
            </button>
          </div>
        )}

        {/* Botón PayPal */}
        {showPayPal && nights > 0 && !rangeHasBlockedDateInside && (
          <div>
            <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm">
              <p className="font-semibold text-primary">{guestName}</p>
              <p className="text-gray-500 text-xs">
                {guestEmail} · {guestPhone}
              </p>
              <p className="text-gray-500 text-xs mt-1">
                {range?.from && format(range.from, "dd MMM yyyy", { locale: es })}{" "}
                →{" "}
                {range?.to && format(range.to, "dd MMM yyyy", { locale: es })} ·{" "}
                {nights} {nights === 1 ? "noche" : "noches"}
              </p>
            </div>

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
                return actions.order.create({
                  intent: "CAPTURE",
                  purchase_units: [
                    {
                      amount: {
                        currency_code: "USD",
                        value: grandTotalUSD.toFixed(2),
                        breakdown: {
                          item_total: {
                            currency_code: "USD",
                            value: nightsTotalUSD.toFixed(2),
                          },
                          handling: {
                            currency_code: "USD",
                            value: cleaningFeeUSD.toFixed(2),
                          },
                        },
                      },
                      description: `Reserva ${propertyName} — ${nights} noches (${checkInIso} al ${checkOutIso})`,
                      custom_id: `${propertySlug}|${checkInIso}|${checkOutIso}|${guestEmail}`,
                    },
                  ],
                });
              }}
              onApprove={async (data, actions) => {
                await actions.order?.capture();
                setOrderId(data.orderID);
                setPaymentSuccess(true);
              }}
              onError={() => {
                alert(
                  "Hubo un error con el pago. Por favor intenta de nuevo o contáctanos por WhatsApp.",
                );
              }}
            />

            <button
              onClick={() => setShowPayPal(false)}
              className="w-full text-gray-400 text-xs mt-2 hover:text-gray-600 transition"
            >
              ← Editar información
            </button>
          </div>
        )}

        <p className="text-xs text-gray-400 text-center mt-4">
          🔒 Pago 100% seguro vía PayPal · Sin cargos ocultos
        </p>
      </div>
    </PayPalScriptProvider>
  );
}
