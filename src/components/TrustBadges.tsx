const badges = [
  {
    label: "Pago 100% seguro con PayPal",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M9 12l2 2 4-4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Te respondemos por WhatsApp en menos de 24 horas",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M21 11.5c0 4.694-4.03 8.5-9 8.5a9.5 9.5 0 0 1-3.4-.625L4 21l1.4-3.85A8.18 8.18 0 0 1 3 11.5C3 6.806 7.03 3 12 3s9 3.806 9 8.5Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: "Propiedades verificadas, administradas por nosotros",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 12l5 5L20 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export default function TrustBadges() {
  return (
    <div className="border-y border-gray-100 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid sm:grid-cols-3 gap-4 sm:gap-6">
          {badges.map((b) => (
            <div
              key={b.label}
              className="flex items-center gap-3 text-sm text-gray-700"
            >
              <span className="text-secondary flex-shrink-0">{b.icon}</span>
              {b.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
