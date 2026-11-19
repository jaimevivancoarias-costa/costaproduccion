import { supabase } from './supabase'
import { dinero } from './fechas'

// Lógica compartida de "Cierres por mes" (tarjeta en pantalla + hoja final del PDF/Excel).
export const MESES_C = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
export const num = v => (Math.round(Math.abs(v) * 100) / 100).toLocaleString('es-EC', { maximumFractionDigits: 2 })
export const signo = v => (v > 0 ? '+' : v < 0 ? '−' : '')

// Unidad en que se APLICA cada producto (para diferencias chicas: OXITET Marexport faltó
// 0,004 tambores = 100 g; con 2 decimales decía "Cuadró" y mostraba −$2,65).
//   insumos: factor/unidad del catálogo con el override por finca.
//   balanceado: sacos → libras (libras_por_saco de la finca).
export async function cargarUnidadesCierre(fincaId, tipo) {
  if (tipo === 'bal') {
    const { data } = await supabase.schema('produccion').from('finca').select('libras_por_saco').eq('id', fincaId).maybeSingle()
    return { todos: { factor: Number(data?.libras_por_saco) || 55, u: 'lb' } }
  }
  const [{ data: ins }, { data: ov }] = await Promise.all([
    supabase.schema('produccion').from('insumo').select('id, factor, unidad'),
    supabase.schema('produccion').from('insumo_finca').select('insumo_id, factor, unidad').eq('finca_id', fincaId),
  ])
  const m = {}
  ;(ins || []).forEach(i => { m[i.id] = { factor: Number(i.factor) || 1, u: i.unidad } })
  ;(ov || []).forEach(o => { if (o.factor != null) m[o.insumo_id] = { factor: Number(o.factor) || 1, u: o.unidad || m[o.insumo_id]?.u } })
  return m
}

const ETQ = { kg: 'kg', kilos: 'kg', gramos: 'g', g: 'g', litros: 'L', l: 'L', ml: 'mL', libras: 'lb', lb: 'lb' }
// Cantidad (en unidad de compra) expresada en la unidad de aplicación: "100 g", "1,5 L".
function enAplicacion(q, uni) {
  if (!uni || !(uni.factor > 1)) return null
  let x = Math.abs(q) * uni.factor
  let u = ETQ[String(uni.u || '').toLowerCase()] || uni.u || ''
  if (u === 'kg' && x < 1) { x *= 1000; u = 'g' }
  if (u === 'L' && x < 1) { x *= 1000; u = 'mL' }
  const r = Math.round(x * 100) / 100
  return r > 0 ? `${r.toLocaleString('es-EC', { maximumFractionDigits: 2 })} ${u}` : null
}

// Explica en palabras de dónde sale el $ de cada producto del ajuste.
export function explicar(f, uni) {
  const q = Number(f.cantidad) || 0, qr = Number(f.cant_real) || 0, v = Number(f.valor) || 0
  // Menos de 10 centavos, o la cantidad cuadró y solo es diferencia de precio de
  // menos de $1: no se lista (Melany: "si cuadró no debería salir"). Va a la línea gris.
  if (Math.abs(v) < 0.10) return { centavos: true }
  // Saldo negativo al cierre: se registró más consumo del que había (caso BIOBAC-M
  // Marexport nov). No es un sobrante: el $ sale porque lo aplicado de más no tenía costo.
  const sf = Number(f.saldo_fin) || 0
  if (sf < -0.005) return {
    txt: `Se aplicó ${num(sf)} más de lo que había en bodega (el saldo quedó en −${num(sf)}).`,
    nota: 'Revisar: un consumo registrado de más, o una guía que falta cargar.', revisar: true }
  // Cantidad que con 2 decimales se ve 0 pero en la unidad de aplicación no lo es (100 g).
  const apl = enAplicacion(qr, uni)
  const chica = Math.abs(qr) < 0.005
  if (chica && !apl && Math.abs(v) < 1 && !/Baja/.test(f.detalle || '')) return { centavos: true }
  const cuanto = chica ? apl : num(qr) + (Math.abs(qr) < 1 && apl ? ` (${apl})` : '')
  if (f.detalle) {
    // Bajas (robo/merma) solas: se muestran tal cual, son explícitas.
    const soloBaja = !/Conteo/.test(f.detalle)
    if (soloBaja) return { txt: f.detalle }
    // Conteos (y bajas junto con conteos): se dice UNA cifra, la real (la misma
    // que da el $ y la que sale en "Qué se movió"), y de dónde sale.
    const cuando = [
      ...(f.detalle.match(/Conteo \d\d\/\d\d/g) || []).map(s => s.replace('Conteo', 'conteo')),
      ...(f.detalle.match(/Baja\/ajuste \d\d\/\d\d: [^·]+/g) || []).map(s => s.replace('Baja/ajuste', 'baja').trim()),
    ].join(', ')
    // "Cuadró" nunca lleva plata al lado: si la cantidad cuadró de verdad, es precio.
    if (chica && !apl) return { txt: `Diferencia de precio, la cantidad cuadró · ${cuando}` }
    const txt = `${qr < 0 ? 'Faltó' : 'Sobró'} ${cuanto} · ${cuando}`
    if (Math.abs(qr - q) < 0.1) return { txt }
    return { txt, nota: `En el acta del conteo figura ${Math.abs(q) < 0.005 ? 'que cuadró' : (q < 0 ? 'faltó ' : 'sobró ') + num(q)} (se calculó distinto ese día); lo que vale es la foto del conteo.` }
  }
  if (Math.abs(v) < 1) return { centavos: true }
  if (!chica || apl) return { txt: `Sin conteo en el mes. Diferencia real ${signo(qr)}${cuanto}: hay una guía o un consumo cargado después con fecha anterior.`, revisar: true }
  return { txt: 'La cantidad cuadra: es diferencia de precio del saldo (se corrigió el precio de un ingreso o del inventario inicial).' }
}

// Separa las líneas a listar de los centavos (que van agrupados en una fila).
export function lineasAjuste(filas, unidades) {
  const uniDe = id => (unidades && (unidades.todos || unidades[id])) || null
  const lineas = (filas || []).map(f => ({ ...f, ...explicar(f, uniDe(f.producto_id)) }))
  const normales = lineas.filter(l => !l.centavos)
  const cent = lineas.filter(l => l.centavos)
  const sumCent = cent.reduce((s, l) => s + Number(l.valor), 0)
  return { normales, cent, sumCent }
}

const conSigno = v => (Math.abs(v) < 0.005 ? '—' : signo(v) + dinero(Math.abs(v)))

// Hoja final del reporte (PDF/Excel): cierre del mes + detalle del ajuste.
// Pedido cliente 19-nov ("esos valores del cierre de mes también en los PDF");
// Melany: al final, hoja nueva, sin tocar lo que ya está.
export function anexoCierre({ cierre, detalle, unidades, categoria }) {
  if (!cierre) return null
  const m = Number(String(cierre.mes).slice(5, 7)) - 1
  const dev = Number(cierre.devoluciones) || 0
  const cards = [
    { k: 'Inicia con', v: dinero(Number(cierre.inicia)) },
    { k: '+ Ingresos', v: dinero(Number(cierre.ingresos)) },
    ...(Math.abs(dev) > 0.005 ? [{ k: '− Devoluciones', v: dinero(dev) }] : []),
    { k: '− Consumo', v: dinero(Number(cierre.consumo)) },
    { k: '± Ajustes', v: conSigno(Number(cierre.ajuste)), alerta: Math.abs(Number(cierre.ajuste)) >= 0.005 },
    { k: '= Termina con', v: dinero(Number(cierre.termina)) },
  ]
  const { normales, cent, sumCent } = lineasAjuste(detalle, unidades)
  const filas = normales.map(l => ({ producto: l.producto, que: l.txt, nota: l.nota || '', valor: conSigno(Number(l.valor)) }))
  if (cent.length && Math.abs(sumCent) >= 0.005) filas.push({ producto: 'Centavos', que: `Redondeo de precio, la cantidad cuadró (${cent.length} ${cent.length === 1 ? 'producto' : 'productos'})`, nota: '', valor: conSigno(sumCent) })
  return {
    titulo: `Cierre del mes — ${categoria}`,
    sub: `${MESES_C[m]} ${String(cierre.mes).slice(0, 4)}`,
    cards,
    bloque: filas.length ? {
      titulo: 'Detalle del ajuste: lo que faltó (−) o sobró (+) al contar la bodega, y las bajas',
      columnas: [
        { titulo: 'Producto', campo: 'producto' },
        { titulo: 'Qué pasó', campo: 'que', sub: 'nota' },
        { titulo: '$', der: true, campo: 'valor' },
      ],
      filas,
      total: { producto: 'Total ajuste', que: '', nota: '', valor: conSigno(Number(cierre.ajuste)) },
    } : null,
  }
}

// Carga lo que necesita la hoja final para un mes (cierres + detalle + unidades).
// fn: 'fn_cierres_mes_insumo' | 'fn_cierres_mes_bal'. Devuelve null si el mes no tiene cierre.
export async function cargarAnexoCierre({ fincaId, fn, desde }) {
  const tipo = fn.endsWith('_bal') ? 'bal' : 'ins'
  const { data: cs, error } = await supabase.schema('produccion').rpc(fn, { p_finca: fincaId })
  if (error) return null
  const cierre = (cs || []).find(r => String(r.mes).slice(0, 7) === desde.slice(0, 7))
  if (!cierre) return null
  const [det, unidades] = await Promise.all([
    Math.abs(Number(cierre.ajuste)) >= 0.005
      ? supabase.schema('produccion').rpc(fn.replace('fn_cierres_mes_', 'fn_cierre_ajuste_detalle_'), { p_finca: fincaId, p_desde: cierre.desde, p_hasta: cierre.hasta })
      : Promise.resolve({ data: [] }),
    cargarUnidadesCierre(fincaId, tipo),
  ])
  return { desde, cierre, detalle: det.data || [], unidades }
}
