"use client";

import { useState } from "react";
import { CITIES } from "@/data/properties";

export default function HeroSearch() {
  const [value, setValue] = useState<string>("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = document.getElementById("propiedades");
    if (target) target.scrollIntoView({ behavior: "smooth" });
    if (value) {
      // dispatch a custom event the property grid listens to
      window.dispatchEvent(
        new CustomEvent("filter-city", { detail: value })
      );
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white/95 backdrop-blur p-3 sm:p-4 rounded-2xl shadow-2xl flex flex-col sm:flex-row gap-3 items-stretch sm:items-center w-full max-w-2xl"
    >
      <label className="flex-1 flex flex-col text-left">
        <span className="text-xs text-muted px-1">¿A dónde vas?</span>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="bg-transparent text-primary font-medium text-base focus:outline-none px-1 py-1.5"
        >
          <option value="">Todas las ubicaciones</option>
          {CITIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-accent whitespace-nowrap">
        Buscar
      </button>
    </form>
  );
}
