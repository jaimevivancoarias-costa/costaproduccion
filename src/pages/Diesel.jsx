import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, sumarDias, corta, semanaISO, lunesDe, miles, numDec, dinero, MESES } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'
import BotonDescargar from '../components/BotonDescargar'
import { Seg } from '../components/controles'

// Diesel unificado · dos subsecciones:
//  - Registro: ingresos y consumos (lo del día) con resumen del período y
//    desglose. El bodeguero registra solo galones; el precio lo pone el jefe
//    (pop-up al ingresar) y nunca lo ve el bodeguero.
//  - Bodega: cuánto hay (galones, y para el jefe precio/valor), contar la
//    bodega y los conteos anteriores.
// El navegador con chips (Esta semana / Este mes / Mes pasado) manda el período.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'
const precio6 = n => (n === null || n === undefined || n === '') ? '' :
  '$' + Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 6 })

// --- Período (semana / mes) ---
const primerDia = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`
const ultimoDia = (y, m) => { const d = new Date(y, m, 0).getDate(); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
const mesDe = iso => ({ y: +iso.slice(0, 4), m: +iso.slice(5, 7) })
function moverAncla(tipo, ancla, dir) {
  if (tipo === 'semana') return sumarDias(lunesDe(ancla), dir * 7)
  const { y, m } = mesDe(ancla); const nm = m + dir
  const ny = y + Math.floor((nm - 1) / 12); const mm = ((nm - 1) % 12 + 12) % 12 + 1
  return primerDia(ny, mm)
}
function rangoDe(per) {
  if (per.tipo === 'custom') return { desde: per.desde, hasta: per.hasta, label: `del ${corta(per.desde)} al ${corta(per.hasta)}` }
  if (per.tipo === 'semana') {
    const l = lunesDe(per.ancla), d = sumarDias(l, 6)
    return { desde: l, hasta: d, label: `Semana ${semanaISO(l).semana} · del ${corta(l)} al ${corta(d)}` }
  }
  const { y, m } = mesDe(per.ancla)
  return { desde: primerDia(y, m), hasta: ultimoDia(y, m), label: `${MESES[m - 1]} ${y}` }
}
function periodoInicial(tipo) {
  const h = hoyISO()
  if (tipo === 'semana') return { tipo, ancla: lunesDe(h) }
  if (tipo === 'mespasado') { const { y, m } = mesDe(h); return { tipo: 'mes', ancla: moverAncla('mes', primerDia(y, m), -1) } }
  const { y, m } = mesDe(h); return { tipo: 'mes', ancla: primerDia(y, m) }
}

export default function Diesel({ finca, esJefe, esJefeGlobal, soloLectura, onCambio }) {
  const [sub, setSub] = useState('registro')           // 'registro' | 'bodega'
  const [per, setPer] = useState(() => periodoInicial('mes'))
  const [vistaBod, setVistaBod] = useState('hay')      // Bodega: 'hay' | 'movio'
  const { desde, hasta, label } = rangoDe(per)
  const hastaSaldo = hasta < hoyISO() ? hasta : hoyISO()

  const [tipos, setTipos] = useState([])
  const [saldos, setSaldos] = useState([])              // fn_saldo_diesel (bodega, a hastaSaldo)
  const [movs, setMovs] = useState([])                  // fn_movimiento_diesel (resumen del período)
  const [pedidos, setPedidos] = useState([])
  const [consumos, setConsumos] = useState([])
  const [solis, setSolis] = useState([])
  const [precios, setPrecios] = useState({})
  const [userId, setUserId] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [form, setForm] = useState(null)
  const [revPrecio, setRevPrecio] = useState(null)

  // Bodega / conteo
  const [primeraVez, setPrimeraVez] = useState(false)
  const [inicial, setInicial] = useState(null)
  const [conteo, setConteo] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [cortes, setCortes] = useState([])              // conteos anteriores con su diferencia
  const [lotes, setLotes] = useState({})                // tipo_id -> [{fecha, galones, queda, precio, rowId, inicial}]
  const [expandido, setExpandido] = useState(null)      // tipo_id del detalle por lote abierto
  const [movAbierto, setMovAbierto] = useState({})      // `${tipo_id}|e` / `|c` -> desglose fecha por fecha abierto
  const [corrLote, setCorrLote] = useState(null)        // pop-up corregir precio de un lote
  const [editRow, setEditRow] = useState(null)          // jefe edita un ingreso/consumo (fecha, tipo, galones, guía…)
  const [cortesAbiertos, setCortesAbiertos] = useState({})  // conteo_id -> abierto
  const [nombresU, setNombresU] = useState({})          // id usuario -> nombre
  const [pedExp, setPedExp] = useState(null)            // ingreso expandido (quién registró)

  const puedeRegistrar = !soloLectura

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: u }, { data: tp }, { data: sal }, { data: mv }, { data: pe }, { data: co }, { data: sc }, { data: pr }, { count }, { data: peAll }, { data: prh }, { data: usuarios }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre, codigo').eq('activo', true).order('nombre'),
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: hastaSaldo }),
      supabase.schema('produccion').rpc('fn_movimiento_diesel', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
      supabase.schema('produccion').from('diesel_pedido')
        .select('id, tipo_id, galones, fecha, estado, solicitado_por, solicitado_en, numero_guia, proveedor').eq('finca_id', finca.id)
        .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }),
      supabase.schema('produccion').from('diesel_consumo')
        .select('id, tipo_id, galones, fecha').eq('finca_id', finca.id)
        .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, tabla, registro_id, valor_propuesto').eq('finca_id', finca.id)
        .in('tabla', ['diesel_pedido', 'diesel_consumo']).eq('estado', 'pendiente'),
      supabase.schema('produccion').from('diesel_precio')
        .select('tipo_id, finca_id, precio_galon, vigente_desde').is('vigente_hasta', null)
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
      supabase.schema('produccion').from('diesel_conteo')
        .select('id', { count: 'exact', head: true }).eq('finca_id', finca.id),
      // Todos los ingresos (para los lotes FIFO) y el historial de precios.
      supabase.schema('produccion').from('diesel_pedido')
        .select('tipo_id, galones, fecha').eq('finca_id', finca.id).eq('estado', 'aprobado').lte('fecha', hastaSaldo),
      supabase.schema('produccion').from('diesel_precio')
        .select('id, tipo_id, finca_id, precio_galon, vigente_desde, vigente_hasta')
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`).order('vigente_desde', { ascending: true }),
      supabase.schema('produccion').from('vw_usuario').select('id, nombre'),
    ])
    const nu = {}; (usuarios || []).forEach(x => { nu[x.id] = x.nombre }); setNombresU(nu)
    setUserId(u?.user?.id || null)
    setTipos(tp || [])
    setSaldos(sal || [])
    setMovs(mv || [])
    setPedidos(pe || [])
    setConsumos(co || [])
    setSolis(sc || [])
    setPrimeraVez((count || 0) === 0)
    const pm = {}
    ;(pr || []).forEach(r => {
      const esFinca = !!r.finca_id
      if (pm[r.tipo_id] == null || esFinca) pm[r.tipo_id] = { precio: Number(r.precio_galon), desde: r.vigente_desde }
    })
    setPrecios(pm)

    // Inventario inicial existente (para editarlo).
    const { data: iniC } = await supabase.schema('produccion').from('diesel_conteo')
      .select('id, fecha').eq('finca_id', finca.id).eq('es_inicial', true)
      .order('fecha', { ascending: true }).limit(1).maybeSingle()
    let iniFecha = null; const iniGal = {}
    if (iniC) {
      const { data: lin } = await supabase.schema('produccion').from('diesel_conteo_linea')
        .select('tipo_id, galones').eq('conteo_id', iniC.id)
      const vals = {}; (lin || []).forEach(l => { vals[l.tipo_id] = String(Number(l.galones)); iniGal[l.tipo_id] = Number(l.galones) })
      iniFecha = iniC.fecha
      setInicial({ id: iniC.id, fecha: iniC.fecha, valores: vals })
    } else setInicial(null)

    // Detalle por lote (FIFO): cada ingreso es un lote valorado al precio del
    // catálogo que regía en su fecha; el inventario inicial es el lote más
    // viejo. Se consume del más viejo primero. queda = lo que sobró tras el
    // consumo total. (saldo = inicial + ingresos − consumo.)
    const precioEnFecha = (tipoId, fecha) => {
      const cand = (prh || []).filter(r => r.tipo_id === tipoId
        && r.vigente_desde <= fecha && (r.vigente_hasta == null || r.vigente_hasta >= fecha))
      if (!cand.length) return { precio: null, rowId: null }
      const fincaRow = cand.find(r => r.finca_id) || cand[0]
      return { precio: Number(fincaRow.precio_galon), rowId: fincaRow.id }
    }
    const saldoDe = {}; (sal || []).forEach(r => { saldoDe[r.tipo_id] = Number(r.saldo) })
    // Saldo inicial del período por tipo (de fn_movimiento, = la fila de arriba).
    const movIniDe = {}; (mv || []).forEach(r => { movIniDe[r.tipo_id] = Number(r.saldo_inicial) || 0 })
    const porTipo = {}
    ;(tp || []).forEach(t => {
      const arr = []
      if (iniFecha && iniGal[t.id] > 0) { const peI = precioEnFecha(t.id, iniFecha); arr.push({ fecha: iniFecha, galones: iniGal[t.id], precio: peI.precio, rowId: null, inicial: true }) }
      ;(peAll || []).filter(p => p.tipo_id === t.id).forEach(p => arr.push({ fecha: p.fecha, galones: Number(p.galones), ...precioEnFecha(t.id, p.fecha) }))
      arr.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0)
      const entrado = arr.reduce((s, l) => s + l.galones, 0)
      let consumo = entrado - (saldoDe[t.id] ?? entrado)      // = inicial + ingresos − saldo (acumulado hasta hoy)
      if (consumo < 0) consumo = 0
      arr.forEach(l => { const take = Math.min(l.galones, consumo); l.entro = l.galones; l.consumio = take; l.queda = l.galones - take; consumo -= take })
      // Movimiento DEL PERÍODO por lote (cuadra con la fila de arriba). El saldo
      // inicial del período (lo que había al empezar el rango) se reparte entre
      // los lotes que YA existían: por FIFO lo que queda es lo más NUEVO, así que
      // se asigna del más nuevo al más viejo. El inventario inicial, solo si el
      // rango arranca en él (o antes), es la apertura base. Lo que llega dentro
      // del rango es "entró". consumió = saldo ini + entró − queda.
      const iniAp = arr.find(l => l.inicial && l.fecha >= desde && l.fecha <= hasta)
      arr.forEach(l => { l.saldoIniP = 0; l.entroP = (l !== iniAp && l.fecha >= desde && l.fecha <= hasta) ? l.galones : 0 })
      let sIni = Number(movIniDe[t.id] || 0)
      for (let i = arr.length - 1; i >= 0 && sIni > 0.0001; i--) {
        const l = arr[i]
        if (l === iniAp || l.fecha < desde) { const take = Math.min(l.galones, sIni); l.saldoIniP = take; sIni -= take }
      }
      arr.forEach(l => { l.consumioP = Math.max(0, l.saldoIniP + l.entroP - l.queda) })
      porTipo[t.id] = arr      // totales (entro/consumio/queda) + movimiento del período (saldoIniP/entroP/consumioP)
    })
    setLotes(porTipo)

    // Conteos anteriores (cortes): los últimos, con su diferencia vs lo que
    // el sistema decía ese día (teórico = fn_saldo_diesel a esa fecha).
    const { data: cts } = await supabase.schema('produccion').from('diesel_conteo')
      .select('id, fecha, es_inicial, diesel_conteo_linea(tipo_id, galones)')
      .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(6)
    const teos = await Promise.all((cts || []).map(c =>
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: c.fecha })))
    const lista = (cts || []).map((c, i) => {
      const teo = {}; (teos[i]?.data || []).forEach(r => { teo[r.tipo_id] = Number(r.saldo) })
      const lineas = (c.diesel_conteo_linea || []).map(l => {
        const contado = Number(l.galones); const sistema = teo[l.tipo_id] || 0
        return { tipo_id: l.tipo_id, contado, sistema, dif: contado - sistema }
      })
      return { id: c.id, fecha: c.fecha, esInicial: !!c.es_inicial, creadoPor: null, observacion: null, lineas }
    })
    setCortes(lista)
    setCargando(false)
  }, [finca.id, desde, hasta, hastaSaldo])

  useEffect(() => { cargar() }, [cargar])

  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'
  const movDe = id => movs.find(m => m.tipo_id === id)
  const solDe = (tabla, id) => solis.find(x => x.tabla === tabla && x.registro_id === id)
  // Valor por FIFO: cada lote (ingreso/inicial) al precio que regía en SU fecha,
  // no al precio de hoy. Así cambiar el precio no revaloriza lo viejo.
  const valorFifoDe = id => (lotes[id] || []).reduce((s, l) => s + Number(l.queda || 0) * Number(l.precio || 0), 0)
  // Valor de los ingresos del período: cada ingreso × el precio de su fecha.
  const valIngFifoDe = id => (lotes[id] || [])
    .filter(l => !l.inicial && l.fecha >= desde && l.fecha <= hasta)
    .reduce((s, l) => s + Number(l.entro || 0) * Number(l.precio || 0), 0)

  // Desglose fecha por fecha de Ingresos (pedidos aprobados) y Consumo del
  // período, por tipo de diesel, para las flechitas de "Qué se movió".
  const ddmm = iso => corta(iso).slice(0, 5)
  const aggFechaTipo = (rows, soloAprobados) => {
    const porTipo = {}
    rows.forEach(r => {
      if (soloAprobados && r.estado !== 'aprobado') return
      const g = Number(r.galones) || 0
      if (!g) return
      const byF = (porTipo[r.tipo_id] = porTipo[r.tipo_id] || {})
      byF[r.fecha] = (byF[r.fecha] || 0) + g
    })
    const out = {}
    Object.entries(porTipo).forEach(([tid, byF]) => {
      out[tid] = Object.entries(byF).map(([fecha, cant]) => ({ fecha, cant }))
        .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    })
    return out
  }
  const entroDet = aggFechaTipo(pedidos, true)
  const aplicoDet = aggFechaTipo(consumos, false)
  const listaMov = (list, signo, color) => {
    const suma = list.reduce((t, x) => t + Number(x.cant || 0), 0)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontVariantNumeric: 'tabular-nums' }}>
        {list.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', fontSize: '11.5px' }}>
            <span style={{ color: '#aab8c6' }}>{ddmm(it.fecha)}</span>
            <span style={{ color, minWidth: '46px' }}>{signo}{miles(it.cant)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', fontSize: '11.5px', fontWeight: 700, color: NAVY, borderTop: '1px solid ' + BORDE, marginTop: '2px', paddingTop: '2px' }}>
          <span style={{ fontWeight: 600, color: GRIS }}>Total</span>
          <span style={{ minWidth: '46px' }}>{signo}{miles(suma)}</span>
        </div>
      </div>
    )
  }

  async function refrescar() { await cargar(); onCambio && onCambio() }

  async function guardarForm() {
    const gal = numDec(form.galones)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Pon los galones.' }); return }
    if (!form.tipoId) { setAviso({ tipo: 'error', texto: 'Elige el tipo de diesel.' }); return }
    const fecha = form.fecha || hoyISO()
    if (form.modo === 'ingreso') {
      const guia = (form.guia || '').trim() || null
      const proveedor = (form.proveedor || '').trim() || null
      // El jefe verifica/actualiza el precio del catálogo con un pop-up.
      // El bodeguero no ve ni pone precio: se registra directo.
      if (esJefe) {
        const p = precios[form.tipoId]
        setRevPrecio({ tipoId: form.tipoId, galones: gal, fecha, guia, proveedor,
                       precioActual: p ? p.precio : null, precio: p ? String(p.precio) : '' })
        return
      }
      const { error } = await supabase.schema('produccion').from('diesel_pedido')
        .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha, estado: 'aprobado', numero_guia: guia, proveedor })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo registrar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Ingreso registrado.' })
      setForm(null); await refrescar(); return
    }
    const { error } = await supabase.schema('produccion').from('diesel_consumo')
      .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Consumo registrado.' })
    setForm(null); await refrescar()
  }

  async function guardarIngreso() {
    const r = revPrecio
    const nuevo = numDec(r.precio)
    if (!(nuevo > 0)) { setAviso({ tipo: 'error', texto: 'Pon el precio del galón.' }); return }
    const cambio = r.precioActual == null || Math.abs(nuevo - r.precioActual) > 1e-9
    if (cambio) {
      await supabase.schema('produccion').from('diesel_precio')
        .delete().eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).gte('vigente_desde', r.fecha)
      await supabase.schema('produccion').from('diesel_precio')
        .update({ vigente_hasta: sumarDias(r.fecha, -1) })
        .eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).lt('vigente_desde', r.fecha)
      const { error: ep } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: r.tipoId, finca_id: finca.id, precio_galon: nuevo, vigente_desde: r.fecha })
      if (ep) { setAviso({ tipo: 'error', texto: 'No se pudo actualizar el precio. ' + ep.message }); return }
    }
    const { error } = await supabase.schema('produccion').from('diesel_pedido')
      .insert({ finca_id: finca.id, tipo_id: r.tipoId, galones: r.galones, fecha: r.fecha,
                estado: 'aprobado', aprobado_por: userId, aprobado_en: new Date().toISOString(),
                numero_guia: r.guia || null, proveedor: r.proveedor || null })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo registrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: cambio ? 'Ingreso registrado y precio actualizado en el catálogo.' : 'Ingreso registrado.' })
    setRevPrecio(null); setForm(null); await refrescar()
  }

  // --- Jefe edita/borra directo; bodeguero pide permiso ---
  // Mismo diálogo para los dos: el jefe guarda directo, el bodeguero manda una
  // solicitud (pedir:true) que el jefe aprueba. Se edita TODO (tipo, fecha,
  // galones, y en ingresos guía/proveedor).
  function abrirEditar(tabla, row, pedir) {
    setEditRow({
      tabla, id: row.id, pedir,
      tipoId: row.tipo_id,
      fecha: row.fecha,
      galones: String(Number(row.galones)),
      guia: row.numero_guia || '',
      proveedor: row.proveedor || '',
      orig: { tipo_id: row.tipo_id, fecha: row.fecha, galones: Number(row.galones), numero_guia: row.numero_guia || null, proveedor: row.proveedor || null },
    })
  }
  function jefeEditar(tabla, row) { abrirEditar(tabla, row, false) }
  function pedirEditar(tabla, row) { abrirEditar(tabla, row, true) }
  async function guardarEdit() {
    const r = editRow
    const gal = numDec(r.galones)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Pon los galones.' }); return }
    if (!r.tipoId) { setAviso({ tipo: 'error', texto: 'Elige el tipo de diesel.' }); return }
    if (!r.fecha) { setAviso({ tipo: 'error', texto: 'Pon la fecha.' }); return }
    const campos = r.tabla === 'diesel_pedido'
      ? { tipo_id: r.tipoId, fecha: r.fecha, galones: gal, numero_guia: (r.guia || '').trim() || null, proveedor: (r.proveedor || '').trim() || null }
      : { tipo_id: r.tipoId, fecha: r.fecha, galones: gal }
    if (r.pedir) {
      // Bodeguero: no edita directo, manda la solicitud al jefe.
      const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
        finca_id: finca.id, tabla: r.tabla, registro_id: r.id,
        valor_anterior: r.orig, valor_propuesto: campos,
        motivo: 'Corrección de diesel', solicitado_por: userId })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
      setEditRow(null); setAviso({ tipo: 'ok', texto: 'Pedido de cambio enviado. El jefe lo revisará.' }); await refrescar(); return
    }
    const { data, error } = await supabase.schema('produccion').from(r.tabla).update(campos).eq('id', r.id).select('id')
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    if (!data || data.length === 0) { setAviso({ tipo: 'error', texto: 'No se corrigió: sin permiso (revisar RLS de diesel).' }); return }
    setEditRow(null); setAviso({ tipo: 'ok', texto: 'Corregido.' }); await refrescar()
  }
  async function jefeBorrar(tabla, row) {
    if (!window.confirm(`¿Borrar este registro de ${miles(Number(row.galones))} gal?`)) return
    const { data, error } = await supabase.schema('produccion').from(tabla).delete().eq('id', row.id).select('id')
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    if (!data || data.length === 0) { setAviso({ tipo: 'error', texto: 'No se borró: sin permiso (revisar RLS de diesel).' }); return }
    setAviso({ tipo: 'ok', texto: 'Borrado.' }); await refrescar()
  }
  async function pedirBorrar(tabla, row) {
    if (!window.confirm('¿Pedir al jefe que borre este registro?')) return
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla, registro_id: row.id,
      valor_anterior: { galones: Number(row.galones) }, valor_propuesto: { borrar: true },
      motivo: 'Borrar diesel', solicitado_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido de borrado enviado. El jefe lo revisará.' }); await refrescar()
  }
  async function resolver(sol, aprobar) {
    // fn_resolver_correccion marca el estado de la solicitud y aplica los galones.
    // Lo llamamos PRIMERO (por si valida el valor anterior de la fila). Luego, si
    // se aprobó una corrección (no un borrado), escribimos en el front los campos
    // extra propuestos (tipo, fecha, guía, proveedor) para no depender de SQL nueva.
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    if (aprobar && !sol.valor_propuesto?.borrar) {
      const vp = sol.valor_propuesto || {}
      const campos = {}
      if (vp.tipo_id != null) campos.tipo_id = vp.tipo_id
      if (vp.fecha != null) campos.fecha = vp.fecha
      if (vp.galones != null) campos.galones = Number(vp.galones)
      if (sol.tabla === 'diesel_pedido') {
        if ('numero_guia' in vp) campos.numero_guia = vp.numero_guia
        if ('proveedor' in vp) campos.proveedor = vp.proveedor
      }
      if (Object.keys(campos).length) {
        const { error: eU } = await supabase.schema('produccion').from(sol.tabla).update(campos).eq('id', sol.registro_id)
        if (eU) { setAviso({ tipo: 'error', texto: 'Se aprobó, pero no se pudo aplicar todo. ' + eU.message }); return }
      }
    }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Corrección aplicada.' : 'Corrección rechazada.' }); await refrescar()
  }

  // Corregir el precio de un lote (si se tecleó mal). Si ese lote ya tiene una
  // fila de catálogo que lo cubre, se actualiza; si no, se crea una que rija
  // desde la fecha del lote (cerrando la anterior).
  async function guardarCorrLote() {
    const r = corrLote; const nuevo = numDec(r.precio)
    if (!(nuevo > 0)) { setAviso({ tipo: 'error', texto: 'Pon el precio del galón.' }); return }
    const fechaVig = r.desde || r.fecha   // "rige desde" editable (default = fecha del lote)
    if (!fechaVig) { setAviso({ tipo: 'error', texto: 'Pon la fecha desde cuándo rige.' }); return }
    if (r.inicial) {
      // El lote inicial llena el HUECO antes del primer precio existente. No
      // borra ni mueve los precios posteriores (p. ej. la primera compra): su
      // vigencia termina el día antes de que empiece el siguiente precio.
      const { data: post } = await supabase.schema('produccion').from('diesel_precio')
        .select('vigente_desde').eq('tipo_id', r.tipoId)
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`)
        .gt('vigente_desde', fechaVig).order('vigente_desde', { ascending: true }).limit(1)
      // Si ya se había puesto un precio inicial en esa misma fecha, lo reemplazamos.
      await supabase.schema('produccion').from('diesel_precio')
        .delete().eq('tipo_id', r.tipoId).eq('finca_id', finca.id).eq('vigente_desde', fechaVig)
      const hasta = (post && post.length) ? sumarDias(post[0].vigente_desde, -1) : null
      const { error } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: r.tipoId, finca_id: finca.id, precio_galon: nuevo, vigente_desde: fechaVig, vigente_hasta: hasta })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Precio del inventario inicial guardado.' }); setCorrLote(null); await refrescar(); return
    }
    if (r.rowId && fechaVig === r.fecha) {
      // Misma fecha: solo corrige el precio de ese tramo, sin mover vigencias.
      const { error } = await supabase.schema('produccion').from('diesel_precio').update({ precio_galon: nuevo }).eq('id', r.rowId)
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return }
    } else {
      // Rige desde fechaVig: cierra el precio anterior el día antes e inserta el nuevo.
      await supabase.schema('produccion').from('diesel_precio')
        .delete().eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).gte('vigente_desde', fechaVig)
      await supabase.schema('produccion').from('diesel_precio')
        .update({ vigente_hasta: sumarDias(fechaVig, -1) })
        .eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).lt('vigente_desde', fechaVig)
      const { error } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: r.tipoId, finca_id: finca.id, precio_galon: nuevo, vigente_desde: fechaVig })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return }
    }
    setAviso({ tipo: 'ok', texto: 'Precio corregido.' }); setCorrLote(null); await refrescar()
  }

  // --- Conteo de la bodega ---
  async function guardarConteo() {
    setGuardando(true); setAviso(null)
    const editId = conteo.editId || conteo.inicialId   // editar un conteo existente (inicial o normal)
    if (editId) {
      const { error: eF } = await supabase.schema('produccion').from('diesel_conteo').update({ fecha: conteo.fecha }).eq('id', editId)
      if (eF) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo. ' + eF.message }); return }
      await supabase.schema('produccion').from('diesel_conteo_linea').delete().eq('conteo_id', editId)
      const lin = tipos.map(t => ({ conteo_id: editId, tipo_id: t.id, galones: numDec(conteo.valores[t.id] || '') || 0 }))
      const { error: eL } = await supabase.schema('produccion').from('diesel_conteo_linea').insert(lin)
      if (eL) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudieron guardar las líneas. ' + eL.message }); return }
      setGuardando(false); setConteo(null); setAviso({ tipo: 'ok', texto: 'Conteo actualizado.' }); await refrescar(); return
    }
    const { data: cab, error: e1 } = await supabase.schema('produccion').from('diesel_conteo')
      .insert({ finca_id: finca.id, fecha: conteo.fecha, es_inicial: primeraVez }).select('id').single()
    if (e1) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + e1.message }); return }
    const lineas = tipos.map(t => ({ conteo_id: cab.id, tipo_id: t.id, galones: numDec(conteo.valores[t.id] || '') || 0 }))
    const { error: e2 } = await supabase.schema('produccion').from('diesel_conteo_linea').insert(lineas)
    if (e2) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudieron guardar las líneas. ' + e2.message }); return }
    setGuardando(false); setConteo(null)
    setAviso({ tipo: 'ok', texto: primeraVez ? 'Inventario inicial cargado.' : 'Conteo guardado.' }); await refrescar()
  }

  // Editar un conteo anterior: carga sus galones en el formulario.
  async function editarCorte(c) {
    const { data: lin } = await supabase.schema('produccion').from('diesel_conteo_linea')
      .select('tipo_id, galones').eq('conteo_id', c.id)
    const vals = {}; (lin || []).forEach(l => { vals[l.tipo_id] = String(Number(l.galones)) })
    setVistaBod('hay'); setConteo({ fecha: c.fecha, valores: vals, editId: c.id, esInicial: c.esInicial })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function borrarCorte(c) {
    if (!window.confirm(`¿Borrar el conteo del ${corta(c.fecha)}?`)) return
    await supabase.schema('produccion').from('diesel_conteo_linea').delete().eq('conteo_id', c.id)
    const { error } = await supabase.schema('produccion').from('diesel_conteo').delete().eq('id', c.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Conteo borrado.' }); await refrescar()
  }
  // Imprimir el acta del conteo: por tipo, sistema · contó · diferencia.
  function imprimirCorte(c) {
    const filas = c.lineas.map(l => ({
      tipo: nombreTipo(l.tipo_id), sistema: miles(l.sistema), contado: miles(l.contado),
      diferencia: Math.abs(l.dif) < 0.005 ? 'Cuadró' : (l.dif < 0 ? 'faltó ' : 'sobró ') + miles(Math.abs(l.dif)),
    })).sort((a, b) => String(a.tipo).localeCompare(String(b.tipo), 'es'))
    const ok = reporteBodegaPDF({
      titulo: 'Reporte de conteo de bodega', finca: String(finca.nombre).toUpperCase(), categoria: 'Diesel',
      subtitulo: 'Saldo, conteo y diferencias · diesel (galones)',
      pie: '<b>Cómo se lee:</b> Sistema = lo que decía el sistema. Contó = lo contado físicamente. Diferencia: "faltó" = menos de lo que decía; "sobró" = más; "Cuadró" = igual.',
      meta: [
        { k: 'Fecha del conteo', v: corta(c.fecha) },
        { k: 'Tipo', v: c.esInicial ? 'Inventario inicial' : 'Conteo' },
        ...(nombresU[c.creadoPor] ? [{ k: 'Contó', v: nombresU[c.creadoPor] }] : []),
        ...(c.observacion ? [{ k: 'Observación', v: c.observacion }] : []),
      ],
      columnas: [
        { titulo: 'Diesel', campo: 'tipo' },
        { titulo: 'Sistema', campo: 'sistema', der: true },
        { titulo: 'Contó', campo: 'contado', der: true },
        { titulo: 'Diferencia', campo: 'diferencia', der: true },
      ],
      filas,
    })
    if (!ok) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.' })
  }

  // --- Reporte de bodega (jefe) ---
  function construirReporte() {
    const gal = v => miles(Number(v) || 0)
    const mas = v => { const x = Number(v) || 0; return x > 0.001 ? '+' + gal(x) : '—' }
    const menos = v => { const x = Number(v) || 0; return x > 0.001 ? '−' + gal(x) : '—' }
    const conSigno = v => { const x = Number(v) || 0; if (Math.abs(x) < 0.001) return '0'; return (x > 0 ? '+' : '−') + gal(Math.abs(x)) }
    const movById = {}; (movs || []).forEach(m => { movById[m.tipo_id] = m })
    const sById = {}; (saldos || []).forEach(s => { sById[s.tipo_id] = s })
    const ultCorte = cortes[0]
    const contById = {}; if (ultCorte) ultCorte.lineas.forEach(l => { contById[l.tipo_id] = l })
    const ids = [...new Set([...(saldos || []).map(s => s.tipo_id), ...(movs || []).map(m => m.tipo_id)])]
    let totIng = 0, totCon = 0, totSaldo = 0, totValor = 0, totDif = 0, nDesc = 0
    const filasRep = []
    ids.forEach(id => {
      const s = sById[id]; const m = movById[id]
      const nombre = (s && s.tipo) || (m && m.tipo) || ''
      const saldoHoy = s ? Number(s.saldo) : (m ? Number(m.saldo_final) : 0)
      const p = precios[id]; const valor = valorFifoDe(id)   // FIFO: stock × precio de su lote
      const ct = contById[id]; const contado = ct ? ct.contado : null; const dif = ct ? ct.dif : null
      totIng += Number(m?.ingresos) || 0; totCon += Number(m?.consumo) || 0; totSaldo += saldoHoy; totValor += valor
      if (dif != null) { totDif += dif; if (Math.abs(dif) > 0.001) nDesc++ }
      filasRep.push({
        nombre, inicial: gal(m?.saldo_inicial || 0), ingresos: mas(m?.ingresos), consumo: menos(m?.consumo),
        saldoHoy: gal(saldoHoy), precio: p ? precio6(p.precio) : '—', precioDesde: p?.desde ? corta(p.desde) : '',
        valor: dinero(valor), contado: contado != null ? gal(contado) : '',
        contadoInfo: ultCorte?.fecha ? corta(ultCorte.fecha) + (ultCorte.esInicial ? ' (inicial)' : '') : '',
        dif: dif != null ? conSigno(dif) : '',
      })
    })
    filasRep.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    const hayConteo = filasRep.some(f => f.contado !== '')
    const columnas = [
      { titulo: 'Diesel', campo: 'nombre' },
      { titulo: 'Inicial', der: true, campo: 'inicial' },
      { titulo: 'Ingresos', der: true, campo: 'ingresos' },
      { titulo: 'Consumo', der: true, campo: 'consumo' },
      { titulo: 'Saldo (gal)', der: true, campo: 'saldoHoy', destacar: true },
      ...(esJefe ? [{ titulo: 'Precio · desde', der: true, campo: 'precio', sub: 'precioDesde' }, { titulo: 'Valor', der: true, campo: 'valor' }] : []),
      ...(hayConteo ? [{ titulo: 'Contado', der: true, campo: 'contado', sub: 'contadoInfo' }, { titulo: 'Dif.', der: true, campo: 'dif' }] : []),
    ]
    const total = { nombre: 'Total', inicial: '', ingresos: '+' + gal(totIng), consumo: totCon ? '−' + gal(totCon) : '—',
      saldoHoy: gal(totSaldo), precio: '', precioDesde: '', valor: dinero(totValor), contado: '', contadoInfo: '',
      dif: Math.abs(totDif) < 0.001 ? '0' : (totDif > 0 ? '+' : '−') + gal(Math.abs(totDif)) }
    const cards = [
      ...(esJefe ? [{ k: 'Valor del diesel', v: dinero(totValor) }] : [{ k: 'Saldo hoy (gal)', v: gal(totSaldo) }]),
      { k: 'Ingresos del rango', v: gal(totIng) },
      { k: 'Consumo del rango', v: gal(totCon) },
      hayConteo ? { k: 'Con descuadre', v: '' + nDesc, alerta: nDesc > 0 } : { k: 'Saldo hoy (gal)', v: gal(totSaldo) },
    ]
    return { titulo: 'Reporte de Bodega — Diesel', finca: finca.nombre, categoria: 'Diesel',
      meta: [{ k: 'Rango', v: `${corta(desde)} – ${corta(hasta)}` }, { k: 'Impreso', v: corta(hoyISO()) }],
      cards, columnas, filas: filasRep, total }
  }
  function exportarExcel() { reporteBodegaExcel(construirReporte()) }
  function exportarPDF() { if (!reporteBodegaPDF(construirReporte())) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para exportar a PDF.' }) }

  function Acciones({ tabla, row }) {
    if (!puedeRegistrar) return null
    if (solDe(tabla, row.id)) return <span style={{ fontSize: '12px', padding: '3px 10px', borderRadius: '20px', background: '#FAEEDA', color: '#854F0B' }}>Cambio enviado</span>
    if (esJefe) return (
      <span style={{ display: 'flex', gap: '6px' }}>
        <button onClick={() => jefeEditar(tabla, row)} style={btnGhost}>Editar</button>
        <button onClick={() => jefeBorrar(tabla, row)} style={btnDel}>Borrar</button>
      </span>
    )
    return (
      <span style={{ display: 'flex', gap: '10px' }}>
        <button onClick={() => pedirEditar(tabla, row)} style={btnLink}>Pedir corregir</button>
        <button onClick={() => pedirBorrar(tabla, row)} style={btnLink}>Pedir borrar</button>
      </span>
    )
  }

  const chips = [['semana', 'Esta semana'], ['mes', 'Este mes'], ['mespasado', 'Mes pasado']]
  const chipActivo = (() => {
    if (per.tipo === 'semana' && per.ancla === periodoInicial('semana').ancla) return 'semana'
    if (per.tipo === 'mes') {
      if (per.ancla === periodoInicial('mes').ancla) return 'mes'
      if (per.ancla === periodoInicial('mespasado').ancla) return 'mespasado'
    }
    return null
  })()

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1080px' }}>
      {revPrecio && (() => {
        const nuevo = numDec(revPrecio.precio)
        const cambio = revPrecio.precioActual != null && Math.abs(nuevo - revPrecio.precioActual) > 1e-9
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '440px', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>Verifica el precio del diesel</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '16px', lineHeight: 1.5 }}>
              {nombreTipo(revPrecio.tipoId)} · {miles(revPrecio.galones)} gal. El precio del catálogo cambia cada mes — confírmalo o actualízalo.
            </div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Precio por galón</div>
                <CampoNumero maxDec={6} autoFocus value={revPrecio.precio} onChange={v => setRevPrecio(x => ({ ...x, precio: v }))} style={{ ...inp, width: '150px', textAlign: 'right' }} />
              </div>
              <div style={{ fontSize: '12px', color: GRIS, paddingBottom: '9px' }}>
                {revPrecio.precioActual != null ? <>catálogo {precio6(revPrecio.precioActual)}</> : 'sin precio en catálogo'}
              </div>
            </div>
            <div style={{ fontSize: '11.5px', color: cambio ? AMBAR : GRIS, margin: '10px 0 14px', lineHeight: 1.5 }}>
              {cambio ? `Cambiaste el precio → se actualizará en el catálogo y regirá desde ${corta(revPrecio.fecha)}.` : 'Si el precio sigue igual, solo confirma.'}
            </div>
            <div style={{ display: 'flex', gap: '9px' }}>
              <Btn primario onClick={guardarIngreso}>Guardar ingreso</Btn>
              <Btn onClick={() => setRevPrecio(null)}>Volver</Btn>
            </div>
          </div>
        </div>
        )
      })()}

      {corrLote && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '420px', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>{corrLote.inicial ? 'Precio del inventario inicial' : 'Corregir precio del lote'}</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '16px', lineHeight: 1.5 }}>
              {corrLote.inicial
                ? <>{nombreTipo(corrLote.tipoId)} · inventario inicial del {corta(corrLote.fecha)}. Pon el precio del galón con que entró ese inventario; así el consumo de ese lote deja de valer $0. No afecta los precios de las compras posteriores.</>
                : <>{nombreTipo(corrLote.tipoId)} · compra {corta(corrLote.fecha)}. Corrige el precio del galón si se tecleó mal; se ajusta en el catálogo para esa fecha.</>}
            </div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Precio por galón</div>
                <CampoNumero maxDec={6} autoFocus value={corrLote.precio} onChange={v => setCorrLote(x => ({ ...x, precio: v }))} style={{ ...inp, width: '140px', textAlign: 'right' }} />
              </div>
              <div>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Rige desde</div>
                <input type="date" value={corrLote.desde || corrLote.fecha} max={hoyISO()} onChange={e => setCorrLote(x => ({ ...x, desde: e.target.value }))} style={inp} />
              </div>
              <div style={{ fontSize: '12px', color: GRIS, paddingBottom: '9px' }}>
                {corrLote.precioActual != null ? <>antes {precio6(corrLote.precioActual)}</> : 'sin precio'}
              </div>
            </div>
            <div style={{ fontSize: '11.5px', color: GRIS, marginTop: '10px', lineHeight: 1.5 }}>
              El precio rige <b style={{ fontWeight: 600 }}>desde esa fecha en adelante</b>; lo anterior mantiene su precio.
            </div>
            <div style={{ display: 'flex', gap: '9px', marginTop: '16px' }}>
              <Btn primario onClick={guardarCorrLote}>Guardar</Btn>
              <Btn onClick={() => setCorrLote(null)}>Cancelar</Btn>
            </div>
          </div>
        </div>
      )}

      {editRow && (() => {
        const esIng = editRow.tabla === 'diesel_pedido'
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '440px', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>{editRow.pedir ? 'Pedir corrección' : 'Editar'} {esIng ? 'ingreso' : 'consumo'}</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '16px', lineHeight: 1.5 }}>
              {editRow.pedir ? 'Corrige los datos y manda el pedido; el jefe lo revisará.' : 'Corrige los datos de este registro de diesel.'}
            </div>
            <div style={{ display: 'grid', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Tipo de diesel</div>
                <select value={editRow.tipoId} onChange={e => setEditRow(x => ({ ...x, tipoId: e.target.value }))} style={{ ...inp, width: '100%' }}>
                  {tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Fecha</div>
                  <input type="date" value={editRow.fecha} max={hoyISO()} onChange={e => setEditRow(x => ({ ...x, fecha: e.target.value }))} style={inp} />
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Galones</div>
                  <CampoNumero value={editRow.galones} onChange={v => setEditRow(x => ({ ...x, galones: v }))} style={{ ...inp, width: '120px', textAlign: 'right' }} />
                </div>
              </div>
              {esIng && (
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '120px' }}>
                    <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Guía (opcional)</div>
                    <input value={editRow.guia} onChange={e => setEditRow(x => ({ ...x, guia: e.target.value }))} style={{ ...inp, width: '100%' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: '120px' }}>
                    <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Proveedor (opcional)</div>
                    <input value={editRow.proveedor} onChange={e => setEditRow(x => ({ ...x, proveedor: e.target.value }))} style={{ ...inp, width: '100%' }} />
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '9px', marginTop: '18px' }}>
              <Btn primario onClick={guardarEdit}>{editRow.pedir ? 'Enviar pedido' : 'Guardar'}</Btn>
              <Btn onClick={() => setEditRow(null)}>Cancelar</Btn>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Encabezado: título + filtro de fechas (estilo insumos/balanceado) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <h2 style={{ fontSize: '19px', fontWeight: 500, margin: 0 }}>Diesel</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <span style={{ fontSize: '13px', color: GRIS }}>Del</span>
          <input type="date" value={desde} max={hasta} onChange={e => setPer({ tipo: 'custom', desde: e.target.value, hasta })} style={inp} />
          <span style={{ fontSize: '13px', color: GRIS }}>a</span>
          <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setPer({ tipo: 'custom', desde, hasta: e.target.value })} style={inp} />
          {chips.map(([id, txt]) => {
            const on = chipActivo === id
            return (
              <button key={id} onClick={() => setPer(periodoInicial(id))} style={{
                fontSize: '12.5px', color: on ? AZUL : GRIS, border: '1px solid ' + (on ? '#bcd8f2' : BORDE),
                background: on ? '#e8f1fb' : '#fff', borderRadius: '8px', padding: '6px 11px', cursor: 'pointer',
                fontFamily: 'inherit', fontWeight: on ? 600 : 500 }}>{txt}</button>
            )
          })}
        </div>
      </div>

      {/* Sub-pestañas */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid ' + BORDE, marginBottom: '18px' }}>
        {[['registro', 'Registro'], ['bodega', 'Bodega']].map(([id, txt]) => (
          <button key={id} onClick={() => setSub(id)} style={{
            border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14.5px', fontWeight: sub === id ? 600 : 500,
            padding: '10px 20px 12px', background: 'none', color: sub === id ? NAVY : GRIS,
            borderBottom: '2px solid ' + (sub === id ? AZUL : 'transparent'), marginBottom: '-1px' }}>{txt}</button>
        ))}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : sub === 'registro' ? (
        RegistroVista()
      ) : (
        BodegaVista()
      )}
    </div>
  )

  // ====================== REGISTRO ======================
  function RegistroVista() {
    return (
      <>
        {puedeRegistrar && (
          <Caja estilo={{ marginBottom: '14px' }}>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>Registrar</div>
              <div style={{ fontSize: '12.5px', color: GRIS, marginTop: '2px', marginBottom: '12px' }}>
                {esJefe ? 'El diesel que llega o que se consume.' : 'Registra solo los galones. El precio lo pone el jefe.'}
              </div>
              {!form ? (
                <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap' }}>
                  <Btn primario onClick={() => setForm({ modo: 'ingreso', tipoId: tipos[0]?.id || '', galones: '', fecha: hoyISO(), guia: '', proveedor: '' })}>+ Registrar ingreso</Btn>
                  <Btn onClick={() => setForm({ modo: 'consumo', tipoId: tipos[0]?.id || '', galones: '', fecha: hoyISO() })}>Registrar consumo</Btn>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 500, marginBottom: '11px' }}>
                    {form.modo === 'ingreso' ? 'Nuevo ingreso de diesel' : 'Registrar consumo'}
                  </div>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Campo label="Tipo">
                      <select value={form.tipoId} onChange={e => setForm(f => ({ ...f, tipoId: e.target.value }))} style={{ ...inp, width: '170px' }}>
                        {tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
                      </select>
                    </Campo>
                    <Campo label="Galones">
                      <CampoNumero value={form.galones} placeholder="ej. 200" onChange={v => setForm(f => ({ ...f, galones: v }))} style={{ ...inp, width: '110px', textAlign: 'right' }} />
                    </Campo>
                    <Campo label="Fecha">
                      <input type="date" value={form.fecha} max={hoyISO()} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} style={{ ...inp, width: '160px' }} />
                    </Campo>
                    {form.modo === 'ingreso' && (
                      <>
                        <Campo label="Número de guía">
                          <input type="text" value={form.guia || ''} placeholder="ej. 001-234567" onChange={e => setForm(f => ({ ...f, guia: e.target.value }))} style={{ ...inp, width: '150px' }} />
                        </Campo>
                        <Campo label="Proveedor">
                          <input type="text" value={form.proveedor || ''} placeholder="ej. Primax" onChange={e => setForm(f => ({ ...f, proveedor: e.target.value }))} style={{ ...inp, width: '180px' }} />
                        </Campo>
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '9px', marginTop: '14px' }}>
                    <Btn primario onClick={guardarForm}>{form.modo === 'ingreso' ? 'Guardar ingreso' : 'Guardar consumo'}</Btn>
                    <Btn onClick={() => setForm(null)}>Cancelar</Btn>
                  </div>
                  {form.modo === 'ingreso' && esJefe && (
                    <div style={{ fontSize: '11.5px', color: GRIS, marginTop: '10px' }}>Al guardar verás el pop-up para confirmar/actualizar el precio del catálogo.</div>
                  )}
                </div>
              )}
            </div>
          </Caja>
        )}

        {/* Resumen del período */}
        <div style={{ fontSize: '13px', fontWeight: 650, margin: '0 0 10px' }}>Resumen del período</div>
        <Caja>
          <Fila cabecera gtc={esJefe ? GRES_J : GRES} der={esJefe ? [false, true, true, true] : [false, true, true]}
            cols={esJefe ? ['Diesel', 'Ingresos (gal)', 'Consumo (gal)', 'Valor ingresos'] : ['Diesel', 'Ingresos (gal)', 'Consumo (gal)']} />
          {tipos.map((t, i) => {
            const m = movDe(t.id); const ing = Number(m?.ingresos) || 0; const con = Number(m?.consumo) || 0
            const p = precios[t.id]; const valIng = valIngFifoDe(t.id)   // cada ingreso al precio de su fecha
            return (
              <Fila key={t.id} cebra={i % 2 === 1} gtc={esJefe ? GRES_J : GRES} der={esJefe ? [false, true, true, true] : [false, true, true]} cols={[
                <b style={{ fontWeight: 600 }}>{t.nombre}</b>,
                <span style={{ color: ing ? VERDE : '#c3d0db' }}>{ing ? '+' + miles(ing) : '—'}</span>,
                <span style={{ color: con ? ROJO : '#c3d0db' }}>{con ? '−' + miles(con) : '—'}</span>,
                ...(esJefe ? [ing ? (
                  <span>{dinero(valIng)}
                    {p && <span style={{ display: 'block', fontSize: '11px', color: GRIS }}>{precio6(p.precio)}/gal{p.desde ? ` · ${corta(p.desde).slice(0, 5)}` : ''}</span>}
                  </span>
                ) : <span>—</span>] : []),
              ]} />
            )
          })}
        </Caja>

        {/* Correcciones pendientes · jefe */}
        {esJefe && solis.length > 0 && (
          <div style={{ marginTop: '18px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>Correcciones por aprobar</h3>
            <Caja>
              {solis.map(sc => {
                const vp = sc.valor_propuesto || {}
                const borrar = !!vp.borrar
                const resumen = borrar ? 'Borrar' : ('Corregir a ' + [
                  vp.tipo_id != null ? nombreTipo(vp.tipo_id) : null,
                  vp.fecha != null ? corta(vp.fecha).slice(0, 5) : null,
                  vp.galones != null ? miles(Number(vp.galones)) + ' gal' : null,
                ].filter(Boolean).join(' · '))
                return (
                  <div key={sc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span>
                      <span style={{ fontWeight: 500 }}>{sc.tabla === 'diesel_pedido' ? 'Ingreso' : 'Consumo'}</span>
                      <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{resumen}</span>
                    </span>
                    <span style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => resolver(sc, true)} style={btnOk}>Aprobar</button>
                      <button onClick={() => resolver(sc, false)} style={btnNo}>Rechazar</button>
                    </span>
                  </div>
                )
              })}
            </Caja>
          </div>
        )}

        {/* Desglose */}
        <div style={{ fontSize: '13px', fontWeight: 650, margin: '20px 0 10px' }}>Desglose</div>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: '320px' }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY, marginBottom: '8px' }}>Ingresos</div>
            {pedidos.length === 0 ? (
              <Caja><div style={{ padding: '18px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin ingresos en el período.</div></Caja>
            ) : (
              <Caja>
                {pedidos.map(p => {
                  const pr = precios[p.tipo_id]
                  const ab = pedExp === p.id
                  const quien = nombresU[p.solicitado_por]
                  return (
                    <div key={p.id} style={{ borderBottom: '0.5px solid #f1f6f9' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px 16px', fontSize: '14px' }}>
                        <span onClick={() => setPedExp(ab ? null : p.id)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                          <span style={{ color: '#aab8c6', fontSize: '11px', marginRight: '7px' }}>{ab ? '▾' : '▸'}</span>
                          <span style={{ fontWeight: 500 }}>{nombreTipo(p.tipo_id)}</span>
                          <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{corta(p.fecha)}{esJefe && pr ? ` · ${precio6(pr.precio)}/gal` : ''}</span>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ color: VERDE, fontVariantNumeric: 'tabular-nums' }}>+{miles(Number(p.galones))} gal</span>
                          <Acciones tabla="diesel_pedido" row={p} />
                        </span>
                      </div>
                      {ab && (
                        <div style={{ background: '#f8fafc', padding: '10px 16px 12px 33px', fontSize: '12.5px', color: GRIS, lineHeight: 1.6 }}>
                          <div>Ingresó: <b style={{ color: NAVY, fontWeight: 600 }}>{quien || 'No registrado'}</b>{p.solicitado_en ? ` · el ${corta(p.solicitado_en.slice(0, 10))}` : ''}</div>
                          <div>Guía: <b style={{ color: NAVY, fontWeight: 600 }}>{p.numero_guia || '—'}</b> · Proveedor: <b style={{ color: NAVY, fontWeight: 600 }}>{p.proveedor || '—'}</b></div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </Caja>
            )}
          </div>
          <div style={{ flex: 1, minWidth: '320px' }}>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY, marginBottom: '8px' }}>Consumos</div>
            {consumos.length === 0 ? (
              <Caja><div style={{ padding: '18px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin consumo en el período.</div></Caja>
            ) : (
              <Caja>
                {consumos.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span>
                      <span style={{ fontWeight: 500 }}>{nombreTipo(c.tipo_id)}</span>
                      <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{corta(c.fecha)}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{ color: ROJO, fontVariantNumeric: 'tabular-nums' }}>−{miles(Number(c.galones))} gal</span>
                      <Acciones tabla="diesel_consumo" row={c} />
                    </span>
                  </div>
                ))}
              </Caja>
            )}
          </div>
        </div>
      </>
    )
  }

  // "Cuánto queda a cada precio" (línea de tiempo) · se usa en "Cuánto hay".
  function DetalleQueda({ tipoId }) {
    const ls = (lotes[tipoId] || []).filter(l => l.queda > 0.0001)
    const p = precios[tipoId]
    return (
      <div style={{ background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', padding: '13px 16px 16px' }}>
        <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '11px' }}>Cuánto queda a cada precio</div>
        {ls.length === 0 ? (
          <div style={{ fontSize: '13px', color: GRIS }}>Sin saldo.</div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: '20px' }}>
            <div style={{ position: 'absolute', left: '4px', top: '6px', bottom: '6px', width: '1.5px', background: BORDE }} />
            {ls.map((L, li) => (
              <div key={li} style={{ position: 'relative', padding: '7px 0' }}>
                <div style={{ position: 'absolute', left: '-20px', top: '11px', width: '9px', height: '9px', borderRadius: '50%', background: L.precio == null ? '#FAEEDA' : '#fff', border: '1.5px solid ' + (L.precio == null ? '#d9a441' : AZUL) }} />
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '9px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 650, fontSize: '13.5px', fontVariantNumeric: 'tabular-nums' }}>{miles(L.queda)} gal</span>
                  <span style={{ fontSize: '11.5px', color: L.precio == null ? AMBAR : GRIS }}>
                    {L.precio == null ? 'sin precio' : precio6(L.precio)} · {L.inicial ? 'del conteo físico' : 'compra ' + corta(L.fecha)}
                  </span>
                  {li === 0 && <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 8px', borderRadius: '20px', background: '#eaf6f0', color: '#0f6e56' }}>se gasta primero</span>}
                  {esJefe && (
                    <button onClick={() => setCorrLote({ tipoId, fecha: L.fecha, rowId: L.rowId, inicial: !!L.inicial, precioActual: L.precio, precio: L.precio != null ? String(L.precio) : '' })}
                      style={{ marginLeft: 'auto', fontSize: '12px', padding: '3px 10px', background: '#eef4fb', color: AZUL, border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                      {L.inicial && L.precio == null ? 'Poner precio' : 'Corregir precio'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {p?.desde && <div style={{ fontSize: '11.5px', color: GRIS, marginTop: '11px' }}>Precio que rige desde {corta(p.desde)}</div>}
      </div>
    )
  }

  // Detalle por lote (FIFO) en tabla · se usa en "Qué se movió".
  function DetalleLote({ tipoId }) {
    const ls = lotes[tipoId] || []
    const cab = { fontSize: '10px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'right' }
    const cel = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12.5px' }
    const tot = { ...cel, fontWeight: 700, borderTop: '1px solid ' + BORDE, paddingTop: '8px' }
    // Lo que había al empezar el rango (lotes previos) se junta en una sola línea
    // "Saldo anterior"; los lotes que entraron DENTRO del rango se muestran uno
    // por uno. Así se ve "solo el ciclo del filtro" + su saldo de arranque.
    const periodo = ls.filter(l => (l.entroP || 0) > 0.0001)
    const anteriores = ls.filter(l => !((l.entroP || 0) > 0.0001))
    const antSaldoIni = anteriores.reduce((a, l) => a + (l.saldoIniP || 0), 0)
    const antCons = anteriores.reduce((a, l) => a + (l.consumioP || 0), 0)
    const antQueda = anteriores.reduce((a, l) => a + l.queda, 0)
    const antCosto = anteriores.reduce((a, l) => a + (l.consumioP || 0) * (l.precio || 0), 0)
    const hayAnterior = antSaldoIni > 0.0001 || antQueda > 0.0001 || antCons > 0.0001
    const tEntro = periodo.reduce((a, l) => a + (l.entroP || 0), 0)
    const tCons = antCons + periodo.reduce((a, l) => a + (l.consumioP || 0), 0)
    const tQueda = antQueda + periodo.reduce((a, l) => a + l.queda, 0)
    const tCosto = antCosto + periodo.reduce((a, l) => a + (l.consumioP || 0) * (l.precio || 0), 0)
    const primerQuedaPer = periodo.findIndex(l => l.queda > 0.0001)
    return (
      <div style={{ background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', padding: '13px 16px 16px' }}>
        <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY }}>Detalle por lote</div>
        <div style={{ fontSize: '10.5px', color: GRIS, marginBottom: '12px' }}>Movimiento del período · se consume del más viejo primero · en galones</div>
        {!hayAnterior && periodo.length === 0 ? (
          <div style={{ fontSize: '13px', color: GRIS }}>Sin movimiento en el período.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: G_LOTE, gap: '13px 18px', alignItems: 'baseline' }}>
            <div style={{ ...cab, textAlign: 'left' }}>Lote</div>
            <div style={cab}>Saldo inicio</div>
            <div style={cab}>Entró</div>
            <div style={cab}>Consumió</div>
            <div style={cab}>Queda</div>
            <div style={cab}>Costo consumido</div>
            {hayAnterior && (
              <Fragment>
                <div style={{ fontSize: '12.5px', textAlign: 'left', lineHeight: 1.45 }}>
                  <div style={{ fontWeight: 600 }}>Saldo anterior</div>
                  <div style={{ color: GRIS, fontSize: '11.5px' }}>lo que había al empezar</div>
                  {antQueda > 0.0001 && <div style={{ fontSize: '10px', color: GRIS }}>se gasta primero</div>}
                </div>
                <div style={cel}>{miles(antSaldoIni)}</div>
                <div style={{ ...cel, color: '#c3d0db' }}>—</div>
                <div style={{ ...cel, color: antCons ? ROJO : '#c3d0db' }}>{antCons ? '−' + miles(antCons) : '—'}</div>
                <div style={{ ...cel, fontWeight: 600 }}>{miles(antQueda)}</div>
                <div style={cel}>{dinero(antCosto)}</div>
              </Fragment>
            )}
            {periodo.map((L, li) => (
              <Fragment key={li}>
                <div style={{ fontSize: '12.5px', textAlign: 'left', lineHeight: 1.45 }}>
                  <div style={{ fontWeight: 600 }}>{L.inicial ? 'Inventario inicial' : 'Compra ' + corta(L.fecha)}</div>
                  <div style={{ color: GRIS, fontSize: '11.5px' }}>{L.precio == null ? 'sin precio' : precio6(L.precio) + ' /gal'}</div>
                  {!hayAnterior && li === primerQuedaPer && L.queda > 0.0001 && <div style={{ fontSize: '10px', color: GRIS }}>se gasta primero</div>}
                  {esJefe && (
                    <button onClick={() => setCorrLote({ tipoId, fecha: L.fecha, rowId: L.rowId, inicial: !!L.inicial, precioActual: L.precio, precio: L.precio != null ? String(L.precio) : '' })}
                      style={{ marginTop: '3px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', color: AZUL }}>
                      {L.inicial && L.precio == null ? 'Poner precio' : 'Corregir precio'}
                    </button>
                  )}
                </div>
                <div style={{ ...cel, color: '#c3d0db' }}>—</div>
                <div style={{ ...cel, color: L.entroP ? VERDE : '#c3d0db' }}>{L.entroP ? '+' + miles(L.entroP) : '—'}</div>
                <div style={{ ...cel, color: L.consumioP ? ROJO : '#c3d0db' }}>{L.consumioP ? '−' + miles(L.consumioP) : '—'}</div>
                <div style={{ ...cel, fontWeight: 600 }}>{miles(L.queda)}</div>
                <div style={cel}>{dinero((L.consumioP || 0) * (L.precio || 0))}</div>
              </Fragment>
            ))}
            <div style={{ ...tot, textAlign: 'left' }}>Total</div>
            <div style={tot}>{miles(antSaldoIni)}</div>
            <div style={tot}>{tEntro ? '+' + miles(tEntro) : '—'}</div>
            <div style={tot}>{tCons ? '−' + miles(tCons) : '—'}</div>
            <div style={tot}>{miles(tQueda)}</div>
            <div style={tot}>{dinero(tCosto)}</div>
          </div>
        )}
      </div>
    )
  }

  // ====================== BODEGA ======================
  function BodegaVista() {
    return (
      <>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' }}>
          <Seg valor={vistaBod} onCambio={setVistaBod} opciones={[['hay', 'Cuánto hay'], ['movio', 'Qué se movió']]} />
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
            {esJefe && <BotonDescargar conRango={false} desde={desde} hasta={hasta} setDesde={() => {}} setHasta={() => {}} onPDF={exportarPDF} onExcel={exportarExcel} />}
            {!soloLectura && !conteo && (
              <button onClick={() => setConteo({ fecha: hoyISO(), valores: {} })} style={{ background: AZUL, color: 'white', border: '0.5px solid ' + AZUL, borderRadius: '9px', padding: '8px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
                {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
              </button>
            )}
          </span>
        </div>

        {conteo && (
          <Caja estilo={{ marginBottom: '14px' }}>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500 }}>{conteo.editId ? (conteo.esInicial ? 'Editar inventario inicial' : 'Editar conteo') : primeraVez ? 'Inventario inicial de diesel' : 'Contar la bodega'}</span>
                <span style={{ fontSize: '12px', color: GRIS }}>Fecha</span>
                <input type="date" value={conteo.fecha} max={hoyISO()} onChange={e => setConteo(c => ({ ...c, fecha: e.target.value }))} style={inp} />
              </div>
              {tipos.map(t => {
                const sist = Number(saldos.find(s => s.tipo_id === t.id)?.saldo || 0)
                const v = conteo.valores[t.id]; const contado = numDec(v || '')
                const dif = v !== undefined && v !== '' ? contado - sist : null
                return (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span style={{ fontWeight: 500 }}>{t.nombre} {esJefe && <span style={{ fontSize: '12px', color: GRIS, fontWeight: 400 }}>· el sistema dice {miles(sist)} gal</span>}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {dif != null && <span style={{ fontSize: '12px', color: Math.abs(dif) < 0.005 ? VERDE : ROJO }}>{Math.abs(dif) < 0.005 ? 'cuadra' : (dif > 0 ? '+' : '−') + miles(Math.abs(dif)) + ' gal'}</span>}
                      <CampoNumero maxDec={2} placeholder="0" value={conteo.valores[t.id] || ''} onChange={val => setConteo(c => ({ ...c, valores: { ...c.valores, [t.id]: val } }))} style={{ ...inp, width: '100px', textAlign: 'right' }} />
                      <span style={{ color: GRIS, fontSize: '13px' }}>gal</span>
                    </span>
                  </div>
                )
              })}
              <div style={{ display: 'flex', gap: '9px', marginTop: '12px' }}>
                <button onClick={guardarConteo} disabled={guardando} style={{ background: AZUL, color: 'white', border: '0.5px solid ' + AZUL, borderRadius: '9px', padding: '9px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: guardando ? 'default' : 'pointer', opacity: guardando ? 0.6 : 1 }}>
                  {guardando ? 'Guardando...' : conteo.editId ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
                </button>
                <button onClick={() => setConteo(null)} style={{ background: 'white', color: NAVY, border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '9px 15px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>Cancelar</button>
              </div>
            </div>
          </Caja>
        )}

        {vistaBod === 'movio' ? (
          <>
            {/* Qué se movió en el período */}
            <div style={{ fontSize: '13px', fontWeight: 650, margin: '0 0 10px' }}>Qué se movió <span style={{ fontWeight: 400, color: GRIS }}>· {label}</span></div>
            <Caja>
              <Fila cabecera gtc={G_MOV} cols={['Diesel', 'Saldo inicio', 'Ingresos', 'Consumo', 'Saldo final']} der={[false, true, true, true, true]} />
              {tipos.map((t, i) => {
                const m = movDe(t.id)
                const ini = Number(m?.saldo_inicial) || 0, ing = Number(m?.ingresos) || 0
                const con = Number(m?.consumo) || 0, fin = Number(m?.saldo_final) || 0
                const abierto = expandido === t.id
                const nombreCol = esJefe ? (
                  <span onClick={() => setExpandido(abierto ? null : t.id)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                    <span style={{ color: '#aab8c6', fontSize: '11px', marginRight: '7px' }}>{abierto ? '▾' : '▸'}</span>
                    <b style={{ fontWeight: 500 }}>{t.nombre}</b>
                  </span>
                ) : <b style={{ fontWeight: 500 }}>{t.nombre}</b>
                // Flechitas de desglose fecha por fecha en Ingresos / Consumo.
                const eList = entroDet[t.id] || [], cList = aplicoDet[t.id] || []
                const openE = !!movAbierto[t.id + '|e'] && eList.length > 0
                const openC = !!movAbierto[t.id + '|c'] && cList.length > 0
                const flecha = color => ({ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color, fontVariantNumeric: 'tabular-nums' })
                return (
                  <div key={t.id}>
                    <Fila gtc={G_MOV} cebra={i % 2 === 1} der={[false, true, true, true, true]} cols={[
                      nombreCol,
                      <span style={{ color: GRIS }}>{miles(ini)}</span>,
                      ing ? (eList.length > 0
                        ? <button onClick={() => setMovAbierto(x => ({ ...x, [t.id + '|e']: !x[t.id + '|e'] }))} style={flecha(VERDE)}>+{miles(ing)} <span style={{ color: AZUL, fontSize: '9px' }}>{openE ? '▾' : '▸'}</span></button>
                        : <span style={{ color: VERDE }}>+{miles(ing)}</span>) : <span style={{ color: '#c3d0db' }}>—</span>,
                      con ? (cList.length > 0
                        ? <button onClick={() => setMovAbierto(x => ({ ...x, [t.id + '|c']: !x[t.id + '|c'] }))} style={flecha(ROJO)}>−{miles(con)} <span style={{ color: AZUL, fontSize: '9px' }}>{openC ? '▾' : '▸'}</span></button>
                        : <span style={{ color: ROJO }}>−{miles(con)}</span>) : <span style={{ color: '#c3d0db' }}>—</span>,
                      <span style={{ fontWeight: 500, color: fin < 0 ? ROJO : NAVY }}>{miles(fin)}</span>,
                    ]} />
                    {(openE || openC) && (
                      <Fila gtc={G_MOV} der={[false, true, true, true, true]} cols={[
                        <span />, <span />,
                        openE ? listaMov(eList, '+', VERDE) : <span />,
                        openC ? listaMov(cList, '−', ROJO) : <span />,
                        <span />,
                      ]} />
                    )}
                    {esJefe && abierto && DetalleLote({ tipoId: t.id })}
                  </div>
                )
              })}
            </Caja>
          </>
        ) : (
          <>
            {/* Lo que hay */}
            <div style={{ fontSize: '13px', fontWeight: 650, margin: '0 0 10px' }}>Lo que hay en bodega</div>
            <Caja>
              {esJefe ? (
                <>
                  <Fila cabecera gtc={G_HAY_J} cols={['Diesel', 'Saldo (gal)', 'Precio/gal · desde', 'Valor']} der={[false, true, true, true]} />
                  {saldos.map((s, i) => {
                    const p = precios[s.tipo_id]
                    const abierto = expandido === s.tipo_id
                    return (
                      <div key={s.tipo_id}>
                        <Fila gtc={G_HAY_J} cebra={i % 2 === 1} der={[false, true, true, true]} cols={[
                          <span onClick={() => setExpandido(abierto ? null : s.tipo_id)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                            <span style={{ color: '#aab8c6', fontSize: '11px', marginRight: '7px' }}>{abierto ? '▾' : '▸'}</span>
                            <b style={{ fontWeight: 600 }}>{s.tipo}</b>
                          </span>,
                          <span style={{ fontWeight: 600, color: Number(s.saldo) < 0 ? ROJO : NAVY }}>{miles(Number(s.saldo))}</span>,
                          p ? <span>{precio6(p.precio)}{p.desde && <span style={{ display: 'block', fontSize: '11px', color: GRIS }}>desde {corta(p.desde)}</span>}</span> : <span style={{ color: GRIS }}>Sin precio</span>,
                          <span style={{ fontWeight: 600 }}>{dinero(valorFifoDe(s.tipo_id))}</span>,
                        ]} />
                        {abierto && DetalleQueda({ tipoId: s.tipo_id })}
                      </div>
                    )
                  })}
                </>
              ) : (
                <>
                  <Fila cabecera gtc={G_HAY} cols={['Diesel', 'Saldo (gal)']} der={[false, true]} />
                  {saldos.map((s, i) => (
                    <Fila key={s.tipo_id} gtc={G_HAY} cebra={i % 2 === 1} der={[false, true]} cols={[
                      <b style={{ fontWeight: 600 }}>{s.tipo}</b>,
                      <span style={{ fontWeight: 600, color: Number(s.saldo) < 0 ? ROJO : NAVY }}>{miles(Number(s.saldo))}</span>,
                    ]} />
                  ))}
                </>
              )}
            </Caja>
          </>
        )}

        {/* Conteos anteriores · se mantiene en ambas vistas (Cuánto hay / Qué se movió) */}
        <div style={{ fontSize: '15px', fontWeight: 500, margin: '22px 0 12px' }}>Conteos anteriores</div>
            {cortes.length === 0 ? (
              <Caja><div style={{ padding: '18px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay conteos.</div></Caja>
            ) : cortes.map((c, idx) => {
              const abierto = !!cortesAbiertos[c.id]
              const autor = nombresU[c.creadoPor]
              const nFalt = c.esInicial ? 0 : c.lineas.filter(l => l.dif < -0.005).length
              const nTipo = c.lineas.length
              const hastaTxt = idx === 0 ? 'hoy' : corta(sumarDias(cortes[idx - 1].fecha, -1))
              return (
                <div key={c.id} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '14px 16px' }}>
                    <button onClick={() => setCortesAbiertos(a => ({ ...a, [c.id]: !abierto }))}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', flex: 1, minWidth: '240px' }}>
                      <div style={{ fontSize: '14.5px', fontWeight: 700, color: NAVY }}>
                        <span style={{ color: GRIS, marginRight: '8px', fontSize: '12px' }}>{abierto ? '▾' : '▸'}</span>
                        Conteo del {corta(c.fecha)}
                        <span style={{ fontSize: '10px', fontWeight: 700, borderRadius: '20px', padding: '2px 9px', marginLeft: '8px',
                          background: idx === 0 ? '#E6F1FB' : '#eef2f6', color: idx === 0 ? AZUL : GRIS }}>
                          {idx === 0 ? 'Corte actual' : c.esInicial ? 'Inventario inicial' : 'Corte anterior'}</span>
                      </div>
                      <div style={{ color: GRIS, fontSize: '11.5px', marginTop: '3px', marginLeft: '20px' }}>
                        {idx === 0 ? 'Desde este conteo hasta hoy' : `${corta(c.fecha)} → ${hastaTxt}`}
                        {autor ? ` · contó ${autor}` : ''} · {nTipo} {nTipo === 1 ? 'tipo' : 'tipos'} · {c.esInicial
                          ? <span style={{ color: GRIS }}>inventario inicial</span>
                          : nFalt > 0
                            ? <b style={{ color: ROJO }}>{nFalt} {nFalt === 1 ? 'faltante' : 'faltantes'}</b>
                            : <span style={{ color: VERDE }}>todo cuadró</span>}
                      </div>
                    </button>
                    <div style={{ display: 'flex', gap: '7px' }}>
                      <button onClick={() => imprimirCorte(c)}
                        style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid ' + AZUL, borderRadius: '8px', background: AZUL, color: '#fff', cursor: 'pointer' }}>Imprimir</button>
                      {esJefe && !soloLectura && <>
                        <button onClick={() => editarCorte(c)} style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: 'white', color: NAVY, cursor: 'pointer' }}>Editar</button>
                        <button onClick={() => borrarCorte(c)} style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid #e7cccb', borderRadius: '8px', background: 'white', color: ROJO, cursor: 'pointer' }}>Borrar</button>
                      </>}
                    </div>
                  </div>
                  {abierto && (
                    <>
                      <Fila cabecera gtc={G_CORTE2} cols={['Diesel', 'Sistema', 'Contó', 'Diferencia']} der={[false, true, true, true]} />
                      {c.lineas.map(l => (
                        <Fila key={l.tipo_id} gtc={G_CORTE2} der={[false, true, true, true]} cols={[
                          nombreTipo(l.tipo_id),
                          c.esInicial ? <span style={{ color: '#c3d0db' }}>—</span> : <span style={{ color: GRIS }}>{miles(l.sistema)}</span>,
                          <span style={{ fontWeight: 500 }}>{miles(l.contado)}</span>,
                          c.esInicial ? <span style={{ color: VERDE }}>Inicial</span>
                            : <span style={{ color: Math.abs(l.dif) < 0.005 ? VERDE : l.dif < 0 ? ROJO : AMBAR }}>{Math.abs(l.dif) < 0.005 ? 'Cuadró' : (l.dif < 0 ? 'Faltó ' : 'Sobró ') + miles(Math.abs(l.dif))}</span>,
                        ]} />
                      ))}
                    </>
                  )}
                </div>
              )
            })}
      </>
    )
  }
}

const GRES = '2fr 1fr 1fr'
const GRES_J = '1.8fr 1fr 1fr 1.1fr'
const G_HAY = '2fr 1fr'
const G_HAY_J = '1.6fr 1fr 1.2fr 1fr'
const G_CORTE2 = '2fr 1fr 1fr 1.2fr'
const G_MOV = '1.6fr 1fr 1fr 1fr 1fr'
const G_LOTE = '1.8fr 1fr 1fr 1fr 1fr 1.3fr'

const inp = { padding: '9px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY }
const btnOk = { fontSize: '12px', padding: '6px 12px', borderRadius: '8px', border: '0.5px solid #3B6D11', background: '#EAF3DE', color: '#27500A', fontFamily: 'inherit', cursor: 'pointer' }
const btnNo = { fontSize: '12px', padding: '6px 12px', borderRadius: '8px', border: '0.5px solid ' + BORDE, background: 'white', color: GRIS, fontFamily: 'inherit', cursor: 'pointer' }
const btnGhost = { fontSize: '12px', padding: '5px 10px', borderRadius: '8px', border: '0.5px solid ' + BORDE, background: 'white', color: GRIS, fontFamily: 'inherit', cursor: 'pointer' }
const btnDel = { fontSize: '12px', padding: '5px 10px', borderRadius: '8px', border: '0.5px solid #e8c9c9', background: 'white', color: ROJO, fontFamily: 'inherit', cursor: 'pointer' }
const btnLink = { fontSize: '12px', border: 'none', background: 'none', color: AZUL, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }

function Caja({ children, estilo }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden', ...estilo }}>{children}</div>
}
function Campo({ label, children }) {
  return <div><label style={{ display: 'block', fontSize: '11px', color: GRIS, margin: '0 0 5px' }}>{label}</label>{children}</div>
}
function Btn({ children, onClick, primario }) {
  return (
    <button onClick={onClick} style={{ background: primario ? AZUL : 'white', color: primario ? 'white' : NAVY, border: '0.5px solid ' + (primario ? AZUL : BORDE), borderRadius: '9px', padding: '9px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: primario ? 500 : 400, cursor: 'pointer' }}>{children}</button>
  )
}
function Fila({ cols, der = [], cabecera, gtc, cebra }) {
  const auto = cols.length === 2 ? '1.6fr 1fr' : cols.length === 3 ? '1.4fr 1fr 1fr' : '1.4fr 1fr 1fr 1fr 1fr'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: gtc || auto, gap: '10px', padding: cabecera ? '11px 16px' : '13px 16px',
                  borderBottom: '0.5px solid ' + (cabecera ? BORDE : '#f1f6f9'), background: cabecera ? '#f6f9fb' : (cebra ? '#fbfcfe' : 'white'),
                  fontSize: cabecera ? '12px' : '14px', color: cabecera ? GRIS : NAVY, alignItems: 'center' }}>
      {cols.map((c, i) => <span key={i} style={{ textAlign: der[i] ? 'right' : 'left', fontVariantNumeric: der[i] ? 'tabular-nums' : 'normal' }}>{c}</span>)}
    </div>
  )
}
