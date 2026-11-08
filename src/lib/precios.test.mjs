// Valida el modelo de precios. Desde nov 2026 la dispersión (CV) es SOLO hacia
// abajo (no cuenta talla premium por encima del promedio), así que los valores se
// desvían a propósito de la hoja PRECIOS del Excel (que usa campana simétrica).
import { precioPorGramaje } from './precios.js'

let fallos = 0
const cerca = (a, b, tol, msg) => { const ok = Math.abs(a - b) < tol; if (ok) console.log('✓', msg, `(${a.toFixed(4)}≈${b})`); else { fallos++; console.error('✗', msg, `(${a.toFixed(4)} vs ${b})`) } }

// Referencia (modelo solo-abajo): g → entero, cola, qué conviene.
const casos = [
  { g: 15, ent: 0.9641, cola: 1.0532, con: 'cola' },
  { g: 24.5, ent: 1.1369, cola: 1.1457, con: 'cola' },
  { g: 30, ent: 1.2698, cola: 1.2317, con: 'entero' },
  { g: 35, ent: 1.3497, cola: 1.3367, con: 'entero' },
  { g: 40, ent: 1.4364, cola: 1.3926, con: 'entero' },
  { g: 45, ent: 1.4748, cola: 1.4149, con: 'entero' },
]
for (const c of casos) {
  const p = precioPorGramaje(c.g)
  cerca(p.entero, c.ent, 0.01, `g=${c.g} entero $/lb`)
  cerca(p.cola, c.cola, 0.01, `g=${c.g} cola $/lb`)
  if (p.conviene === c.con) console.log('✓', `g=${c.g} conviene ${c.con}`); else { fallos++; console.error('✗', `g=${c.g} conviene ${p.conviene} (esperado ${c.con})`) }
}

if (fallos) { console.error(`\n${fallos} prueba(s) de precios fallaron.`); process.exit(1) }
console.log('\nTodas las pruebas de precios pasaron.')
