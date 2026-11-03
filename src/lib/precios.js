// Precio de venta del camarón por gramaje — portado de la hoja PRECIOS del Excel
// de estimación v9. La pesca se reparte entre tallas con una campana normal
// (media = gramaje, σ = gramaje × CV) y se promedia el precio por talla.
// Se parte de la LISTA (entero $/kg por pz/kg, cola $/lb por pz/lb) y se aplica el
// rendimiento (entero y cola). Todo es editable desde produccion.precio_camaron.
export const REND_ENTERO_DEF = 0.92
export const REND_COLA_DEF = 0.65
export const CV_DEF = 0.18
const LB_POR_KG = 2.20462

// ENTERO: bordes en GRAMOS por pieza (grande→chico), etiquetas pz/kg y precio de
// LISTA $/kg por talla (lista AQUAGOLD 5-ago, columna A-B).
const ENT_EDGES = [100, 50, 33.3333, 25, 20, 16.6667, 14.2857, 12.5, 10]
export const ENT_TALLAS = ['10/20', '20/30', '30/40', '40/50', '50/60', '60/70', '70/80', '80/100']
export const ENT_LISTA_DEF = [7.3, 3.6, 3.2, 2.8, 2.6, 2.45, 2.35, 2.15]
// COLA: bordes en GRAMOS de cola (grande→chico), etiquetas pz/lb y precio de LISTA
// $/lb por talla (columna DIRECTA A).
const COLA_EDGES = [9999, 37.7993, 30.2395, 22.6796, 18.1437, 15.1197, 12.9598, 11.3398, 9.0718, 7.5599, 6.4799, 5.0399, 4.1236]
export const COLA_TALLAS = ['U/12', 'U/15', '16/20', '21/25', '26/30', '31/35', '36/40', '41/50', '51/60', '61/70', '71/90', '91/110']
export const COLA_LISTA_DEF = [3.5, 3.1, 2.2, 2.15, 1.8, 1.75, 1.75, 1.8, 1.6, 1.5, 1.25, 0.65]

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

// $/lb de entero y de cola para un gramaje, y qué conviene vender. `opts` permite
// sobrescribir la lista y los rendimientos/dispersión desde la base.
export function precioPorGramaje(g, opts = {}) {
  if (!(g > 0)) return { entero: 0, cola: 0, conviene: 'entero', mejor: 0, ventaja: 0 }
  const rendE = opts.rendEntero ?? REND_ENTERO_DEF
  const rendC = opts.rendCola ?? REND_COLA_DEF
  const cv = opts.cv ?? CV_DEF
  const entLista = opts.enteroLista || ENT_LISTA_DEF
  const colLista = opts.colaLista || COLA_LISTA_DEF
  const entUso = entLista.map(v => v * rendE / LB_POR_KG)   // $/kg lista → $/lb EN USO
  const colUso = colLista.map(v => v * rendC)               // $/lb lista → $/lb EN USO
  const entero = blend(g, ENT_EDGES, entUso, cv)
  const cola = blend(g * rendC, COLA_EDGES, colUso, cv)
  const conviene = cola > entero ? 'cola' : 'entero'
  const mn = Math.min(entero, cola), mx = Math.max(entero, cola)
  return { entero, cola, conviene, mejor: mx, ventaja: mn > 0 ? (mx - mn) / mn : 0 }
}
