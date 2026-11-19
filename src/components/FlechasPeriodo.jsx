import { MESES, hoyISO, lunesDe, sumarDias, semanaISO, cortita } from '../lib/fechas'

// Flechas ‹ › para ir retrocediendo/avanzando el filtro de fechas
// (pedido del cliente: "una flechita hacia atrás para ir retrocediendo por mes y semana").
// Entiende el rango que ya está puesto:
//  - mes completo (1 → fin de mes, o 1 → hoy si es el mes en curso) → salta de mes en mes
//  - semana (lunes → domingo, o lunes → hoy)                       → salta de semana en semana
//  - cualquier otro rango                                           → salta el mismo número de días
// onCambiar(desde, hasta, tipo) con tipo 'mes' | 'semana' | 'dias'. Nunca pasa de hoy.
const finDeMes = iso => { const [y, m] = iso.split('-').map(Number); const d = new Date(y, m, 0).getDate(); return `${iso.slice(0, 7)}-${String(d).padStart(2, '0')}` }
const primeroDe = iso => iso.slice(0, 7) + '-01'
const dias = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000)

export function tipoDeRango(desde, hasta) {
  const hoy = hoyISO()
  if (!desde || !hasta) return 'dias'
  if (desde.slice(8) === '01' && desde.slice(0, 7) === hasta.slice(0, 7) && (hasta === finDeMes(desde) || hasta === hoy)) return 'mes'
  if (lunesDe(desde) === desde && (hasta === sumarDias(desde, 6) || (hasta === hoy && dias(desde, hasta) < 7))) return 'semana'
  return 'dias'
}

export function moverRango(desde, hasta, dir) {
  const hoy = hoyISO(), tipo = tipoDeRango(desde, hasta)
  let d, h
  if (tipo === 'mes') {
    const [y, m] = desde.split('-').map(Number), nm = m + dir
    const ny = y + Math.floor((nm - 1) / 12), mm = ((nm - 1) % 12 + 12) % 12 + 1
    d = `${ny}-${String(mm).padStart(2, '0')}-01`; h = finDeMes(d)
  } else if (tipo === 'semana') {
    d = sumarDias(desde, dir * 7); h = sumarDias(d, 6)
  } else {
    const n = dias(desde, hasta) + 1
    d = sumarDias(desde, dir * n); h = sumarDias(hasta, dir * n)
  }
  if (h > hoy) h = hoy
  return { desde: d, hasta: h, tipo }
}

function etiqueta(desde, hasta) {
  const t = tipoDeRango(desde, hasta)
  if (t === 'mes') return `${MESES[Number(desde.slice(5, 7)) - 1]} ${desde.slice(0, 4)}`
  if (t === 'semana') return `Semana ${semanaISO(desde).semana} · ${cortita(desde)} – ${cortita(sumarDias(desde, 6))}`
  return `${cortita(desde)} – ${cortita(hasta)}`
}

export default function FlechasPeriodo({ desde, hasta, onCambiar, conEtiqueta = true }) {
  const hoy = hoyISO()
  const sig = moverRango(desde, hasta, 1)
  const puedeSig = sig.desde <= hoy && hasta < hoy
  const b = on => ({
    border: '1px solid #dce6ef', background: '#fff', borderRadius: '8px', width: '30px', height: '30px',
    cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.35, fontSize: '16px', lineHeight: 1, color: '#022847',
    fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  })
  const ir = dir => { const r = moverRango(desde, hasta, dir); onCambiar(r.desde, r.hasta, r.tipo) }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <button type="button" title="Período anterior" onClick={() => ir(-1)} style={b(true)}>‹</button>
      {conEtiqueta && <span style={{ fontSize: '13px', color: '#022847', fontWeight: 600, minWidth: '96px', textAlign: 'center', whiteSpace: 'nowrap' }}>{etiqueta(desde, hasta)}</span>}
      <button type="button" title="Período siguiente" disabled={!puedeSig} onClick={() => puedeSig && ir(1)} style={b(puedeSig)}>›</button>
    </span>
  )
}
