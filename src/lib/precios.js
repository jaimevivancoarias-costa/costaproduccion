// Precio de venta del camarón por gramaje — portado de la hoja PRECIOS del Excel
// de estimación (lista AQUAGOLD 5-ago-2026). La pesca se reparte entre tallas con
// una campana normal (media = gramaje, σ = gramaje × CV) y se promedia el precio.
// $/lb EN USO ya incluye el rendimiento (entero 0,92 · cola 0,65) y el selector de
// lista; son constantes editables si cambia la lista de precios.
export const CV = 0.18            // dispersión de talla en la pesca
export const REND_COLA = 0.65     // peso de la cola respecto al entero

// ENTERO: bordes en GRAMOS por pieza (grande→chico) y $/lb EN USO por talla
// (10/20, 20/30, 30/40, 40/50, 50/60, 60/70, 70/80, 80/100).
const ENT_EDGES = [100, 50, 33.3333, 25, 20, 16.6667, 14.2857, 12.5, 10]
const ENT_PRECIO = [3.0463, 1.5023, 1.3354, 1.1685, 1.085, 1.0224, 0.9807, 0.8972]
// COLA: bordes en GRAMOS de cola (grande→chico) y $/lb EN USO por talla
// (U/12, U/15, 16/20, 21/25, 26/30, 31/35, 36/40, 41/50, 51/60, 61/70, 71/90, 91/110).
const COLA_EDGES = [9999, 37.7993, 30.2395, 22.6796, 18.1437, 15.1197, 12.9598, 11.3398, 9.0718, 7.5599, 6.4799, 5.0399, 4.1236]
const COLA_PRECIO = [2.275, 2.015, 1.43, 1.3975, 1.17, 1.1375, 1.1375, 1.17, 1.04, 0.975, 0.8125, 0.4225]

// erf (Abramowitz–Stegun 7.1.26) para la normal acumulada.
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return s * y
}
const phi = (x, mu, sigma) => 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)))

// Promedio de precio ponderado por la campana sobre `centro` (gramos), con bordes
// descendentes: peso de cada talla = Φ(borde_alto) − Φ(borde_bajo), normalizado.
function blend(centro, edges, precios, cv) {
  const sigma = Math.max(centro * cv, 0.0001)
  let tot = 0; const w = []
  for (let k = 0; k < precios.length; k++) { const d = phi(edges[k], centro, sigma) - phi(edges[k + 1], centro, sigma); w.push(d); tot += d }
  if (tot <= 0) return 0
  let s = 0; for (let k = 0; k < precios.length; k++) s += (w[k] / tot) * precios[k]
  return s
}

// $/lb de entero y de cola para un gramaje, y qué conviene vender.
export function precioPorGramaje(g, cv = CV) {
  if (!(g > 0)) return { entero: 0, cola: 0, conviene: 'entero', ventaja: 0 }
  const entero = blend(g, ENT_EDGES, ENT_PRECIO, cv)
  const cola = blend(g * REND_COLA, COLA_EDGES, COLA_PRECIO, cv)
  const conviene = cola > entero ? 'cola' : 'entero'
  const mn = Math.min(entero, cola), mx = Math.max(entero, cola)
  return { entero, cola, conviene, mejor: mx, ventaja: mn > 0 ? (mx - mn) / mn : 0 }
}
