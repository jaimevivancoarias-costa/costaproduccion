// Valida el port de precios contra los valores calculados de la hoja PRECIOS.
import { precioPorGramaje } from './precios.js'

let fallos = 0
const cerca = (a, b, tol, msg) => { const ok = Math.abs(a - b) < tol; if (ok) console.log('✓', msg, `(${a.toFixed(4)}≈${b})`); else { fallos++; console.error('✗', msg, `(${a.toFixed(4)} vs ${b})`) } }

// Referencia (Excel, lista 5-ago): g → entero, cola, qué conviene.
const casos = [
  { g: 15, ent: 1.0143, cola: 1.1057, con: 'cola' },
  { g: 24.5, ent: 1.2324, cola: 1.2081, con: 'entero' },
  { g: 30, ent: 1.3476, cola: 1.3212, con: 'entero' },
  { g: 35, ent: 1.4393, cola: 1.4031, con: 'entero' },
  { g: 40, ent: 1.5966, cola: 1.5196, con: 'entero' },
  { g: 45, ent: 1.9032, cola: 1.6849, con: 'entero' },
]
for (const c of casos) {
  const p = precioPorGramaje(c.g)
  cerca(p.entero, c.ent, 0.01, `g=${c.g} entero $/lb`)
  cerca(p.cola, c.cola, 0.01, `g=${c.g} cola $/lb`)
  if (p.conviene === c.con) console.log('✓', `g=${c.g} conviene ${c.con}`); else { fallos++; console.error('✗', `g=${c.g} conviene ${p.conviene} (esperado ${c.con})`) }
}

if (fallos) { console.error(`\n${fallos} prueba(s) de precios fallaron.`); process.exit(1) }
console.log('\nTodas las pruebas de precios pasaron.')
