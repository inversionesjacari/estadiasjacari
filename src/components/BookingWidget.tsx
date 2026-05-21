'use client';

import { useState } from 'react';
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';

const PAYPAL_CLIENT_ID =
  'AQYfxeAZGvq-HZ4Fz7RdENtJjGRCWKzILQBXlqixS6LdJN5FF7njl3w4ofXnaTMpZw6GugYCYiKK05gy';

interface BookingWidgetProps {
  propertyName: string;
  propertySlug: string;
  pricePerNightUSD: number;
  cleaningFeeUSD: number;
  pricePerNightHNL: number;
}

export default function BookingWidget({
  propertyName,
  propertySlug,
  pricePerNightUSD,
  cleaningFeeUSD,
  pricePerNightHNL,
}: BookingWidgetProps) {
  const today = new Date().toISOString().split('T')[0];

  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [showPayPal, setShowPayPal] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [orderId, setOrderId] = useState('');

  const nights =
    checkIn && checkOut
      ? Math.ceil(
          (new Date(checkOut).getTime() - new Date(checkIn).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;

  const nightsTotal = nights > 0 ? nights * pricePerNightUSD : 0;
  const grandTotal = nights > 0 ? nightsTotal + cleaningFeeUSD : 0;

  const handleProceed = () => {
    if (!guestName.trim() || !guestEmail.trim() || !guestPhone.trim()) {
      alert('Por favor completa tu nombre, correo y teléfono.');
      return;
    }
    if (nights <= 0) {
      alert('Por favor selecciona fechas válidas.');
      return;
    }
    setShowPayPal(true);
  };

  // ── PANTALLA DE CONFIRMACIÓN ──────────────────────────────────────────────
  if (paymentSuccess) {
    const waText = encodeURIComponent(
      `¡Hola! Acabo de confirmar mi reserva en ${propertyName} del ${checkIn} al ${checkOut}. ` +
        `Mi nombre es ${guestName}. Número de orden PayPal: ${orderId}`
    );
    return (
      <div className="bg-white rounded-2xl border border-green-200 shadow-md p-6 text-center sticky top-24">
        <div className="text-5xl mb-3">✅</div>
        <h3 className="font-bold text-green-700 text-xl mb-2">¡Reserva confirmada!</h3>
        <p className="text-gray-600 text-sm mb-4">
          Tu pago fue procesado exitosamente. Recibirás una confirmación de PayPal en tu correo.
        </p>
        <div className="bg-green-50 rounded-xl p-4 text-sm text-left space-y-1 mb-4">
          <p>
            <span className="font-semibold">Propiedad:</span> {propertyName}
          </p>
          <p>
            <span className="font-semibold">Check-in:</span> {checkIn}
          </p>
          <p>
            <span className="font-semibold">Check-out:</span> {checkOut}
          </p>
          <p>
            <span className="font-semibold">Noches:</span> {nights}
          </p>
          <p>
            <span className="font-semibold">Total pagado:</span> ${grandTotal.toFixed(2)} USD
          </p>
          <p>
            <span className="font-semibold">Orden:</span>{' '}
            <span className="text-xs text-gray-500">{orderId}</span>
          </p>
        </div>
        <a
          href={`https://wa.me/50488390145?text=${waText}`}
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

  // ── FORMULARIO PRINCIPAL ──────────────────────────────────────────────────
  return (
    <PayPalScriptProvider options={{ clientId: PAYPAL_CLIENT_ID, currency: 'USD' }}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-md p-6 sticky top-24">
        {/* Precio */}
        <div className="mb-5">
          <h3 className="text-base font-bold text-[#003F31] mb-1">Reservar ahora</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#003F31]">${pricePerNightUSD}</span>
            <span className="text-gray-500 text-sm">USD / noche</span>
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            L. {pricePerNightHNL.toLocaleString()} / noche
          </p>
        </div>

        {/* Fechas */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">Check-in</label>
            <input
              type="date"
              min={today}
              value={checkIn}
              onChange={(e) => {
                setCheckIn(e.target.value);
                setShowPayPal(false);
                if (checkOut && e.target.value >= checkOut) setCheckOut('');
              }}
              className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B9DAE]"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 font-medium block mb-1">Check-out</label>
            <input
              type="date"
              min={checkIn || today}
              value={checkOut}
              onChange={(e) => {
                setCheckOut(e.target.value);
                setShowPayPal(false);
              }}
              className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B9DAE]"
            />
          </div>
        </div>

        {/* Resumen de precio */}
        {nights > 0 && (
          <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">
                ${pricePerNightUSD} × {nights} {nights === 1 ? 'noche' : 'noches'}
              </span>
              <span className="font-medium">${nightsTotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Costo de limpieza (único)</span>
              <span className="font-medium">${cleaningFeeUSD.toFixed(2)}</span>
            </div>
            <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-[#003F31]">
              <span>Total</span>
              <span>${grandTotal.toFixed(2)} USD</span>
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
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B9DAE]"
            />
            <input
              type="email"
              placeholder="Correo electrónico"
              value={guestEmail}
              onChange={(e) => setGuestEmail(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B9DAE]"
            />
            <input
              type="tel"
              placeholder="Teléfono / WhatsApp"
              value={guestPhone}
              onChange={(e) => setGuestPhone(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B9DAE]"
            />
            <button
              onClick={handleProceed}
              disabled={nights <= 0}
              className="w-full bg-[#D0A436] text-white py-3 rounded-xl font-semibold text-sm hover:bg-[#b8912e] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nights > 0
                ? `Pagar $${grandTotal.toFixed(2)} USD`
                : 'Selecciona las fechas'}
            </button>
          </div>
        )}

        {/* Botón PayPal */}
        {showPayPal && nights > 0 && (
          <div>
            <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm">
              <p className="font-semibold text-[#003F31]">{guestName}</p>
              <p className="text-gray-500 text-xs">
                {guestEmail} · {guestPhone}
              </p>
              <p className="text-gray-500 text-xs mt-1">
                {checkIn} → {checkOut} · {nights} {nights === 1 ? 'noche' : 'noches'}
              </p>
            </div>

            <PayPalButtons
              style={{ layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' }}
              createOrder={(_data, actions) =>
                actions.order.create({
                  intent: 'CAPTURE',
                  purchase_units: [
                    {
                      amount: {
                        currency_code: 'USD',
                        value: grandTotal.toFixed(2),
                        breakdown: {
                          item_total: {
                            currency_code: 'USD',
                            value: nightsTotal.toFixed(2),
                          },
                          handling: {
                            currency_code: 'USD',
                            value: cleaningFeeUSD.toFixed(2),
                          },
                        },
                      },
                      description: `Reserva ${propertyName} — ${nights} noches (${checkIn} al ${checkOut})`,
                      custom_id: `${propertySlug}|${checkIn}|${checkOut}|${guestEmail}`,
                    },
                  ],
                })
              }
              onApprove={async (data, actions) => {
                await actions.order?.capture();
                setOrderId(data.orderID);
                setPaymentSuccess(true);
              }}
              onError={() => {
                alert(
                  'Hubo un error con el pago. Por favor intenta de nuevo o contáctanos por WhatsApp.'
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
