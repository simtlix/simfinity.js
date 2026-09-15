#!/usr/bin/env node

/**
 * Generates SVG placeholder images for the BarberBooking MVP.
 * Run: node frontend/scripts/generate-placeholders.js
 * Output: frontend/public/images/
 */

const fs = require("fs");
const path = require("path");

const BG = "#1B1B1D";
const ACCENT = "#C9A96E";
const TEXT = "#E5E1E4";
const OUTLINE = "#353437";

function svg(width, height, label, sub = "") {
  const fontSize = Math.min(width, height) * 0.08;
  const subSize = fontSize * 0.6;
  const subLine = sub
    ? `<text x="50%" y="${height / 2 + fontSize * 1.2}" font-family="Inter, sans-serif" font-size="${subSize}" fill="${OUTLINE}" text-anchor="middle">${sub}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BG}"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" stroke="${OUTLINE}" stroke-width="1"/>
  <text x="50%" y="${height / 2}" font-family="Newsreader, Georgia, serif" font-size="${fontSize}" fill="${ACCENT}" text-anchor="middle" dominant-baseline="middle" font-style="italic">${label}</text>
  ${subLine}
</svg>`;
}

const images = [
  // Barbershop logos (200x200)
  { dir: "barbershops", name: "heritage-club-logo.svg", w: 200, h: 200, label: "HC", sub: "Logo" },
  { dir: "barbershops", name: "barba-roja-logo.svg", w: 200, h: 200, label: "BR", sub: "Logo" },
  { dir: "barbershops", name: "noble-groomer-logo.svg", w: 200, h: 200, label: "NG", sub: "Logo" },

  // Barbershop covers (1920x820)
  { dir: "barbershops", name: "heritage-club-cover.svg", w: 1920, h: 820, label: "The Heritage Club", sub: "Cover Image" },
  { dir: "barbershops", name: "barba-roja-cover.svg", w: 1920, h: 820, label: "Barba Roja Studio", sub: "Cover Image" },
  { dir: "barbershops", name: "noble-groomer-cover.svg", w: 1920, h: 820, label: "El Noble Groomer", sub: "Cover Image" },

  // Professionals (400x400)
  { dir: "professionals", name: "julian-prieto.svg", w: 400, h: 400, label: "JP", sub: "Julián Prieto" },
  { dir: "professionals", name: "marcos-andrade.svg", w: 400, h: 400, label: "MA", sub: "Marcos Andrade" },
  { dir: "professionals", name: "eric-valdes.svg", w: 400, h: 400, label: "EV", sub: "Eric Valdés" },
  { dir: "professionals", name: "lucio-vero.svg", w: 400, h: 400, label: "LV", sub: "Lucio Vero" },
  { dir: "professionals", name: "marco-aurelio.svg", w: 400, h: 400, label: "MA", sub: "Marco Aurelio" },
  { dir: "professionals", name: "sofia-reyes.svg", w: 400, h: 400, label: "SR", sub: "Sofía Reyes" },

  // Services (600x400)
  { dir: "services", name: "corte-clasico.svg", w: 600, h: 400, label: "Corte Clásico", sub: "" },
  { dir: "services", name: "barba.svg", w: 600, h: 400, label: "Barba", sub: "" },
  { dir: "services", name: "facial.svg", w: 600, h: 400, label: "Tratamiento Facial", sub: "" },
  { dir: "services", name: "ritual-toalla.svg", w: 600, h: 400, label: "Ritual Toalla Caliente", sub: "" },
  { dir: "services", name: "tinte.svg", w: 600, h: 400, label: "Tinte", sub: "" },
  { dir: "services", name: "afeitado-navaja.svg", w: 600, h: 400, label: "Afeitado con Navaja", sub: "" },

  // Categories (600x400)
  { dir: "categories", name: "cabello.svg", w: 600, h: 400, label: "Cabello", sub: "" },
  { dir: "categories", name: "barba.svg", w: 600, h: 400, label: "Barba", sub: "" },
  { dir: "categories", name: "tratamientos.svg", w: 600, h: 400, label: "Tratamientos", sub: "" },

  // Defaults (various)
  { dir: "placeholder", name: "user-avatar.svg", w: 200, h: 200, label: "U", sub: "Avatar" },
  { dir: "placeholder", name: "barbershop-default.svg", w: 600, h: 400, label: "Barbería", sub: "Sin imagen" },
];

const outBase = path.resolve(__dirname, "../public/images");

let count = 0;
for (const img of images) {
  const dir = path.join(outBase, img.dir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, img.name);
  fs.writeFileSync(filePath, svg(img.w, img.h, img.label, img.sub));
  count++;
}

console.log(`Generated ${count} placeholder SVGs in ${outBase}`);
