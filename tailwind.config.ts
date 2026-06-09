import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/data/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#003F51",
        secondary: "#289DAE",
        accent: "#D2A436",
        bg: "#F8F7F4",
        muted: "#6B7280",
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 4px 24px -8px rgba(0, 63, 49, 0.15)",
      },
    },
  },
  plugins: [],
};

export default config;
