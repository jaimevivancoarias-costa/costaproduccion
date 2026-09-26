import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, numDec, miles, dinero, dineroExacto } from '../lib/fechas'
import PreciosBalanceado from './PreciosBalanceado'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'

// Inventario de balanceado · igual que el de insumos, pero en sacos.
//
// El balanceado se compra en sacos y se aplica en libras. El saldo se
// lleva en sacos: baja con lo aplicado en las piscinas (libras/55) y
// sube con los ingresos. Valorado por lotes (FIFO). Los dolares son
// solo para el jefe.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
const ROJO = '#8A2F2E', VERDE = '#0F6E56', AMBAR = '#BA7517'
const primeroDelMes = iso => iso.slice(0, 8) + '01'
const G_CONTEO = '1fr 90px 100px 250px 120px'
const MOTIVOS_DESCUADRE = ['Merma', 'Rotura', 'Robo', 'Error de registro', 'Otro']
const G_SALDO_J = '1fr 150px 130px 140px 110px'
const G_SALDO_B = '1fr 140px'
const G_MOV_J = '1.3fr repeat(8, 1fr)'
const G_MOV_B = '1.3fr repeat(7, 1fr)'
const G_DOS = '150px 1fr'

export default function InventarioBalanceado({ finca, esJefe, esJefeGlobal, abrirIngresos, abrirPrecios, onCorreccion }) {
  const [seccion, setSeccion] = useState('bodega')  // 'bodega' | 'ingresos' | 'precios'
  useEffect(() => { if (abrirIngresos) setSeccion('ingresos') }, [abrirIngresos])
  const [vista, setVista] = useState('saldo')       // 'saldo' | 'movimientos'
  const [busq, setBusq] = useState('')
  const coincide = nom => !busq || nom === busq
  const [alDia, setAlDia] = useState(hoyISO())
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())

  const [saldos, setSaldos] = useState([])
  const [valorFifo, setValorFifo] = useState({})
  const [desglose, setDesglose] = useState({})
  const [abierto, setAbierto] = useState(null)
  const [movs, setMovs] = useState([])
  const [precios, setPrecios] = useState({})
  const [precioInfo, setPrecioInfo] = useState({})   // producto_id -> { aplicado, otros, semaforo, rigeSinPrecio }
  const [tomas, setTomas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const [contando, setContando] = useState(false)
  const [editToma, setEditToma] = useState(null)
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})        // sacos completos
  const [sueltas, setSueltas] = useState({})         // libras sueltas
  const [motivoDesc, setMotivoDesc] = useState({})   // motivo del descuadre
  const [motivoOtro, setMotivoOtro] = useState({})
  const [lps, setLps] = useState(55)                 // libras por saco
  const [detToma, setDetToma] = useState(null)       // conteo expandido (ver descuadres)
  const [detLineas, setDetLineas] = useState({})
  const [guardando, setGuardando] = useState(false)
  const [nuevos, setNuevos] = useState([])
  const [guardandoNuevos, setGuardandoNuevos] = useState(false)
  const [conteoQuien, setConteoQuien] = useState({})   // producto_id -> {fecha, autor}
  const [descMotivo, setDescMotivo] = useState({})     // producto_id -> motivo del descuadre (para el reporte)
  const [conteoDet, setConteoDet] = useState(null)     // producto_id con detalle abierto
  const [lotes, setLotes] = useState({})               // producto_id -> [{fecha, cantidad, costo, valor}] (FIFO, solo jefe)
  const [iniForm, setIniForm] = useState(null)         // { productoId, cantidad, fecha } al cargar inventario inicial de un producto
  const [recosForm, setRecosForm] = useState(null)     // producto_id con la confirmación de recosteo abierta
  const [recosteando, setRecosteando] = useState(false)
  const [verSinInv, setVerSinInv] = useState(false)    // mostrar también los productos sin inventario

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: s, error: e }, { data: vf }, { data: m }, { data: p }, { data: t }, { data: dpz }, { data: par }, { data: lt }, { data: pzr }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_saldo_balanceado', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_valor_bodega_bal_fifo', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_movimiento_balanceado', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
        supabase.schema('produccion').from('precio_producto')
          .select('producto_id, plazo, precio_saco, vigente_desde').eq('finca_id', finca.id).is('vigente_hasta', null),
        supabase.schema('produccion').from('toma_balanceado')
          .select('id, fecha, observacion').eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
        supabase.schema('produccion').rpc('fn_saldo_balanceado_plazo', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').from('parametro').select('valor').eq('clave', 'libras_por_saco').maybeSingle(),
        // Lotes por precio (FIFO): solo se piden si es jefe/contadora.
        esJefe ? supabase.schema('produccion').rpc('fn_lotes_balanceado', { p_finca: finca.id, p_hasta: alDia }) : Promise.resolve({ data: [] }),
        // Plazo que rige por producto (para verificar QUÉ precio se aplica).
        supabase.schema('produccion').from('plazo_producto')
          .select('producto_id, plazo, vigente_desde').eq('finca_id', finca.id).is('vigente_hasta', null),
      ])
      if (e) throw e
      // Precios por plazo (con su "desde") + plazo que rige. Con esto sabemos
      // QUÉ precio se aplica y avisamos si pusiste precio en otro plazo que no
      // rige (el caso "puse 30,68 pero aplica otro"). precios[pid] = el que se
      // aplica realmente; precioInfo[pid] = detalle para el doble-check.
      const preP = {}
      ;(p || []).forEach(x => { (preP[x.producto_id] = preP[x.producto_id] || {})[Number(x.plazo)] = { precio: Number(x.precio_saco), desde: x.vigente_desde } })
      const rigeP = {}
      ;(pzr || []).forEach(x => { rigeP[x.producto_id] = Number(x.plazo) })
      const pr = {}, pinfo = {}
      Object.keys(preP).forEach(pid => {
        const plazos = preP[pid]
        const rige = rigeP[pid] != null ? rigeP[pid] : 0
        const usaPlazo = plazos[rige] ? rige : (plazos[0] ? 0 : null)
        const row = usaPlazo != null ? plazos[usaPlazo] : null
        const aplicado = row ? { precio: row.precio, plazo: usaPlazo, desde: row.desde } : null
        const otros = Object.keys(plazos).map(Number).filter(pz => pz !== usaPlazo)
          .map(pz => ({ plazo: pz, precio: plazos[pz].precio, desde: plazos[pz].desde }))
          .sort((a, b) => a.plazo - b.plazo)
        const rigeSinPrecio = rigeP[pid] != null && !plazos[rige]
        pr[pid] = aplicado ? aplicado.precio : 0
        // Solo se marca "Revisar" cuando el plazo que rige NO tiene precio (se
        // aplica un respaldo equivocado). Tener precios en varios plazos es
        // normal y NO es un problema.
        pinfo[pid] = { aplicado, otros, semaforo: rigeSinPrecio ? 'warn' : 'ok', rigeSinPrecio }
      })
      const vfm = {}; (vf || []).forEach(x => { vfm[x.producto_id] = Number(x.valor) })
      const dgm = {}; (dpz || []).forEach(x => { (dgm[x.producto_id] = dgm[x.producto_id] || []).push({ plazo: Number(x.plazo), cantidad: Number(x.cantidad), valor: Number(x.valor) }) })
      const ltm = {}; (lt || []).forEach(x => { (ltm[x.producto_id] = ltm[x.producto_id] || []).push({ fecha: x.fecha, cantidad: Number(x.cantidad), costo: x.costo_unitario == null ? null : Number(x.costo_unitario), valor: Number(x.valor) }) })
      setSaldos(s || []); setValorFifo(vfm); setMovs(m || []); setPrecios(pr); setTomas(t || []); setDesglose(dgm); setLotes(ltm); setPrecioInfo(pinfo)
      if (par && Number(par.valor) > 0) setLps(Number(par.valor))

      // Autoría del conteo por producto (quién y cuándo) para la columna Conteo.
      const [{ data: tomasP }, { data: usuarios }] = await Promise.all([
        supabase.schema('produccion').from('toma_balanceado')
          .select('fecha, creado_por, es_inicial, toma_balanceado_linea(producto_id, motivo_descuadre, diferencia)')
          .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
          .order('fecha', { ascending: true }),
        supabase.schema('produccion').from('vw_usuario').select('id, nombre'),
      ])
      const nombreU = {}; (usuarios || []).forEach(u => { nombreU[u.id] = u.nombre })
      const cq = {}, dm = {}
      ;(tomasP || []).forEach(tt => (tt.toma_balanceado_linea || []).forEach(l => {
        cq[l.producto_id] = { fecha: tt.fecha, autor: nombreU[tt.creado_por] || null, esInicial: !!tt.es_inicial }
        // El último motivo del rango con descuadre (las tomas vienen en orden ascendente).
        if (l.motivo_descuadre && Math.abs(Number(l.diferencia) || 0) > 0.001) dm[l.producto_id] = l.motivo_descuadre
      }))
      setConteoQuien(cq); setDescMotivo(dm)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally { setCargando(false) }
  }, [finca.id, alDia, desde, hasta, esJefe])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = tomas.length === 0
  // Valor de la bodega = costo REAL de lo que hay (FIFO, lo que se pagó por
  // cada lote). Es la plata parada de verdad, no el precio de catálogo. Así
  // el valor cuadra con el desglose "cuánto queda a cada precio" de abajo.
  const valorBodega = useMemo(() => saldos.reduce((t, s) => t + Number(valorFifo[s.producto_id] || 0), 0), [saldos, valorFifo])
  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.producto_id]; const hayS = txt !== undefined && txt !== ''
    const lib = sueltas[s.producto_id]; const hayL = lib !== undefined && lib !== '' && Number(lib) !== 0
    const c = (hayS || hayL) ? (hayS ? Number(txt) : 0) + (hayL ? Number(String(lib).replace(',', '.')) / (lps || 55) : 0) : null
    return { ...s, precio: precios[s.producto_id] || 0, contado: c,
             diferencia: c !== null ? c - Number(s.saldo) : null }
  }), [saldos, precios, contado, sueltas, lps])
  const llenadas = filas.filter(f => f.contado !== null).length
  const negativos = saldos.filter(s => Number(s.saldo) < -0.001).length
  // Sin inventario: saldo ~0 y sin lotes. Se ocultan por defecto en la bodega.
  const esSinInvFila = f => Math.abs(Number(f.saldo)) < 0.001 && !((lotes[f.producto_id] || []).length)
  const nSinInv = filas.filter(f => coincide(f.producto) && esSinInvFila(f)).length

  // Reporte de bodega: junta "Cuánto hay" y "Qué se movió" en un solo documento.
  // Cruza saldos (al día) con movimientos (del rango), lotes, precio·vigencia y
  // el conteo con su motivo. Un mismo botón para Excel y PDF.
  function construirReporte() {
    const mas = n => { const x = numDec(n); return x > 0.001 ? '+' + limpio(x) : '—' }
    const menos = n => { const x = numDec(n); return x > 0.001 ? '−' + limpio(x) : '—' }
    const conSigno = n => { const x = numDec(n); if (Math.abs(x) < 0.001) return '0'; return (x > 0 ? '+' : '−') + limpio(Math.abs(x)) }
    const movById = {}; (movs || []).forEach(m => { movById[m.producto_id] = m })
    const sById = {}; (saldos || []).forEach(s => { sById[s.producto_id] = s })

    // Universo: productos con saldo/lotes o con movimiento en el rango.
    const ids = [...new Set([...(saldos || []).map(s => s.producto_id), ...(movs || []).map(m => m.producto_id)])]
    const filaTieneMov = m => m && (numDec(m.ingresos) || numDec(m.consumo) || numDec(m.devuelto) || numDec(m.ajustes) || m.conteo != null)

    let totIni = 0, totIng = 0, totDev = 0, totCon = 0, totConUsd = 0, totAlaFecha = 0, totValor = 0, totDif = 0, totDesc = 0, nDesc = 0
    const filasRep = []
    ids.forEach(id => {
      const s = sById[id]; const m = movById[id]
      const nombre = (s && s.producto) || (m && m.producto) || ''
      if (!coincide(nombre)) return
      const saldoAlDia = s ? Number(s.saldo) : 0
      const sinInv = Math.abs(saldoAlDia) < 0.001 && !((lotes[id] || []).length)
      if (sinInv && !filaTieneMov(m) && !verSinInv) return

      const precio = precios[id] || 0
      const desde = precioInfo[id]?.aplicado?.desde
      const valor = Number(valorFifo[id] || 0)
      const conteo = m && m.conteo != null ? Number(m.conteo) : null
      const teorico = m ? Number(m.saldo_final) : saldoAlDia
      const dif = conteo != null ? conteo - teorico : null
      const descUsd = (dif != null && Math.abs(dif) > 0.001) ? dif * precio : null
      const cq = conteoQuien[id]
      const ls = (lotes[id] || []).flatMap(L => ([
        { t: `${limpio(L.cantidad)} a ${L.costo == null ? 's/precio' : dineroExacto(L.costo)}` },
        { t: L.fecha ? 'compra ' + corta(L.fecha) : 'del conteo físico', sm: true },
      ]))

      totIni += numDec(m?.saldo_inicial); totIng += numDec(m?.ingresos); totDev += numDec(m?.devuelto)
      totCon += numDec(m?.consumo); totConUsd += numDec(m?.consumo_dolares); totAlaFecha += saldoAlDia; totValor += valor
      if (dif != null) { totDif += dif; if (descUsd) { totDesc += descUsd; nDesc++ } }

      filasRep.push({
        nombre, viaTop: 'Saco → lb', viaSub: '' + (lps || 55),
        inicial: limpio(m?.saldo_inicial || 0), ingresos: mas(m?.ingresos), devuelto: menos(m?.devuelto),
        consumo: menos(m?.consumo), consumoUsd: dinero(numDec(m?.consumo_dolares)),
        alafecha: limpio(saldoAlDia), precio: precio ? dineroExacto(precio) : '—', precioDesde: desde ? corta(desde) : '',
        valor: dinero(valor), lotes: ls,
        contado: conteo != null ? limpio(conteo) : '', contadoFecha: cq?.fecha ? corta(cq.fecha) : '',
        dif: dif != null ? conSigno(dif) : '', descuadre: descUsd ? dinero(descUsd) : (dif === 0 ? '—' : ''),
        motivo: descMotivo[id] || '',
      })
    })
    filasRep.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

    const columnas = [
      { titulo: 'Balanceado', campo: 'nombre' },
      { titulo: 'Llega / aplica', campo: 'viaTop', sub: 'viaSub' },
      { titulo: 'Inicial', der: true, campo: 'inicial' },
      { titulo: 'Ingresos', der: true, campo: 'ingresos' },
      { titulo: 'Devuelto', der: true, campo: 'devuelto' },
      { titulo: 'Consumo', der: true, campo: 'consumo' },
      { titulo: 'Consumo $', der: true, campo: 'consumoUsd' },
      { titulo: 'A la fecha', der: true, campo: 'alafecha' },
      { titulo: 'Precio · desde', der: true, campo: 'precio', sub: 'precioDesde' },
      { titulo: 'Valor', der: true, campo: 'valor' },
      { titulo: 'Lotes', campo: 'lotes', lotes: true },
      { titulo: 'Contado', der: true, campo: 'contado', sub: 'contadoFecha' },
      { titulo: 'Dif.', der: true, campo: 'dif' },
      { titulo: 'Descuadre $', der: true, campo: 'descuadre' },
      { titulo: 'Motivo', campo: 'motivo' },
    ]
    const total = {
      nombre: 'Total', viaTop: '', viaSub: '', inicial: limpio(totIni), ingresos: '+' + limpio(totIng),
      devuelto: totDev ? '−' + limpio(totDev) : '—', consumo: totCon ? '−' + limpio(totCon) : '—',
      consumoUsd: dinero(totConUsd), alafecha: limpio(totAlaFecha), precio: '', precioDesde: '',
      valor: dinero(totValor), lotes: [], contado: '', contadoFecha: '',
      dif: Math.abs(totDif) < 0.001 ? '0' : (totDif > 0 ? '+' : '−') + limpio(Math.abs(totDif)),
      descuadre: totDesc ? dinero(totDesc) : '—', motivo: '',
    }
    const cards = [
      { k: 'Valor total en bodega', v: dinero(totValor) },
      { k: 'Consumo del rango', v: dinero(totConUsd) },
      { k: 'Descuadre total', v: dinero(totDesc), alerta: Math.abs(totDesc) > 0.001 },
      { k: 'Ítems con descuadre', v: '' + nDesc, alerta: nDesc > 0 },
    ]
    return {
      titulo: `Reporte de Bodega — Balanceado`, finca: finca.nombre, categoria: 'Balanceado',
      meta: [
        { k: 'Rango', v: `${corta(desde)} – ${corta(hasta)}` },
        { k: 'Impreso', v: corta(hoyISO()) },
      ],
      cards, columnas, filas: filasRep, total,
    }
  }
  function exportarExcel() { reporteBodegaExcel(construirReporte()) }
  function exportarPDF() {
    if (!reporteBodegaPDF(construirReporte())) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para exportar a PDF.' })
  }

  const filaNueva = () => ({ nombre: '', marca: '' })
  const setNuevo = (i, campo, val) => setNuevos(ns => ns.map((n, j) => j === i ? { ...n, [campo]: val } : n))

  async function guardarNuevos() {
    const validos = nuevos.filter(n => n.nombre.trim())
    if (!validos.length) { setNuevos([]); return }
    const rows = validos.map(n => ({ nombre: n.nombre.trim(), marca: n.marca.trim() || null }))
    setGuardandoNuevos(true)
    if (esJefeGlobal) {
      const { error } = await supabase.schema('produccion').from('producto').insert(rows)
      setGuardandoNuevos(false)
      if (error) {
        const dup = /duplicate|unique/i.test(error.message)
        setAviso({ tipo: 'error', texto: dup ? 'Alguno ya existe con ese nombre.' : 'No se pudo agregar. ' + error.message })
        return
      }
      setAviso({ tipo: 'ok', texto: `${rows.length} ${rows.length === 1 ? 'balanceado agregado' : 'balanceados agregados'}.` })
    } else {
      const { data: au } = await supabase.auth.getUser()
      const solis = rows.map(r => ({
        finca_id: finca.id, tabla: 'nuevo_producto', registro_id: crypto.randomUUID(),
        valor_propuesto: r, motivo: 'Balanceado que falta en la lista', solicitado_por: au?.user?.id }))
      const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert(solis)
      setGuardandoNuevos(false)
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido enviado al jefe. Lo agregará al catálogo.' })
    }
    setNuevos([])
    await cargar()
  }

  async function editarToma(t) {
    const { data } = await supabase.schema('produccion').from('toma_balanceado_linea')
      .select('producto_id, cantidad_contada, motivo_descuadre').eq('toma_id', t.id)
    const mapa = {}, md = {}, mo = {}
    ;(data || []).forEach(l => {
      mapa[l.producto_id] = String(l.cantidad_contada)
      if (l.motivo_descuadre) {
        if (MOTIVOS_DESCUADRE.includes(l.motivo_descuadre)) md[l.producto_id] = l.motivo_descuadre
        else { md[l.producto_id] = 'Otro'; mo[l.producto_id] = l.motivo_descuadre }
      }
    })
    setContado(mapa); setSueltas({}); setMotivoDesc(md); setMotivoOtro(mo)
    setFecha(t.fecha); setObs(t.observacion || '')
    setEditToma(t); setContando(true); setAviso(null)
  }

  async function guardarToma() {
    if (!llenadas) { setAviso({ tipo: 'error', texto: 'No has contado ningún producto.' }); return }
    const desc = filas.filter(f => f.diferencia !== null && Math.abs(f.diferencia) > 0.001)
    const txt = editToma
      ? `Vas a guardar los cambios del conteo del ${corta(editToma.fecha)}. ¿Guardar?`
      : primeraVez
      ? `Vas a cargar el inventario inicial de balanceado con ${llenadas} productos.\n¿Guardar?`
      : desc.length ? `${desc.length} productos no cuadran. Las diferencias quedan registradas. ¿Guardar?`
                    : 'Todo cuadra. ¿Guardar el conteo?'
    if (!window.confirm(txt)) return
    setGuardando(true)
    try {
      let tomaId
      if (editToma) {
        const { error: eU } = await supabase.schema('produccion').from('toma_balanceado')
          .update({ fecha, observacion: obs || null }).eq('id', editToma.id)
        if (eU) throw eU
        await supabase.schema('produccion').from('toma_balanceado_linea').delete().eq('toma_id', editToma.id)
        tomaId = editToma.id
      } else {
        const { data: toma, error } = await supabase.schema('produccion').from('toma_balanceado')
          .insert({ finca_id: finca.id, fecha, observacion: obs || null }).select('id').single()
        if (error) throw error
        tomaId = toma.id
      }
      const lineas = filas.filter(f => f.contado !== null).map(f => {
        const hayDesc = !primeraVez && (editToma || Math.abs(f.diferencia || 0) > 0.001)
        const cat = motivoDesc[f.producto_id]
        const motivoD = hayDesc && cat ? (cat === 'Otro' ? (motivoOtro[f.producto_id]?.trim() || 'Otro') : cat) : null
        return {
          toma_id: tomaId, producto_id: f.producto_id, cantidad_contada: f.contado,
          cantidad_sistema: Number(f.saldo), diferencia: f.diferencia, motivo_descuadre: motivoD,
        }
      })
      const { error: e2 } = await supabase.schema('produccion').from('toma_balanceado_linea').insert(lineas)
      if (e2) throw e2
      setAviso({ tipo: 'ok', texto: editToma ? 'Conteo actualizado.' : primeraVez ? 'Inventario inicial cargado.' : `Conteo guardado. ${lineas.length} productos.` })
      setContando(false); setEditToma(null); setContado({}); setSueltas({}); setMotivoDesc({}); setMotivoOtro({}); setObs(''); await cargar()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') }) }
    finally { setGuardando(false) }
  }

  const nombreProducto = id => saldos.find(s => s.producto_id === id)?.producto || ''

  async function verDescuadres(t) {
    if (detToma === t.id) { setDetToma(null); return }
    setDetToma(t.id)
    if (!detLineas[t.id]) {
      const { data } = await supabase.schema('produccion').from('toma_balanceado_linea')
        .select('producto_id, cantidad_sistema, cantidad_contada, diferencia, motivo_descuadre').eq('toma_id', t.id)
      const desc = (data || []).filter(l => Math.abs(Number(l.diferencia) || 0) > 0.001)
      setDetLineas(m => ({ ...m, [t.id]: desc }))
    }
  }

  async function borrarToma(t) {
    if (!window.confirm(`¿Borrar el conteo del ${corta(t.fecha)}?\n\nEl saldo vuelve a calcularse desde el conteo anterior (o desde cero). No se puede deshacer.`)) return
    const { error } = await supabase.schema('produccion').from('toma_balanceado').delete().eq('id', t.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Conteo borrado.' }); await cargar()
  }

  // Cargar inventario inicial de UN producto (nuevo o sin inventario). Usa el
  // mismo mecanismo de ajuste que "corregir": es seguro y por producto.
  async function guardarInicial() {
    if (!iniForm) return
    const cant = Number(String(iniForm.cantidad).replace(',', '.'))
    if (!isFinite(cant) || cant <= 0) { setAviso({ tipo: 'error', texto: 'Escribe una cantidad válida.' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iniForm.fecha)) { setAviso({ tipo: 'error', texto: 'Fecha inválida.' }); return }
    const sActual = Number(saldos.find(x => x.producto_id === iniForm.productoId)?.saldo || 0)
    const delta = cant - sActual
    const { error } = await supabase.schema('produccion').from('ajuste_balanceado')
      .insert({ finca_id: finca.id, fecha: iniForm.fecha, producto_id: iniForm.productoId, cantidad: delta, motivo: 'Inventario inicial' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setIniForm(null); setAviso({ tipo: 'ok', texto: 'Inventario inicial cargado.' }); await cargar()
  }

  // Recostear un producto: sus lotes y su consumo pasan al precio que rige
  // (los lotes conservan su fecha de compra; cambia precio y plazo). Manual,
  // por producto: el jefe decide cuándo. No se puede deshacer solo, pero es
  // determinístico (siempre recalcula desde el catálogo actual).
  async function recostear(f) {
    setRecosteando(true)
    const { error } = await supabase.schema('produccion')
      .rpc('fn_recostear_producto_finca', { p_finca: finca.id, p_producto: f.producto_id })
    setRecosteando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo recostear. ' + error.message }); return }
    setRecosForm(null)
    setAviso({ tipo: 'ok', texto: `${f.producto} recosteado al precio que rige.` })
    await cargar()
  }

  async function corregir(f) {
    const escrito = window.prompt(`${f.producto}\n\nEl sistema dice ${limpio(f.saldo)} sacos.\n¿Cuánto debe decir?`, limpio(f.saldo))
    if (escrito === null) return
    const nuevo = Number(String(escrito).replace(',', '.'))
    if (!isFinite(nuevo)) { setAviso({ tipo: 'error', texto: 'No es un número.' }); return }
    const delta = nuevo - Number(f.saldo)
    if (Math.abs(delta) < 0.001) return
    const motivo = window.prompt('¿Por qué? Queda en la bitácora.')
    if (!motivo || !motivo.trim()) { setAviso({ tipo: 'error', texto: 'Falta el motivo.' }); return }
    // La fecha del ajuste debe ser la del día en que pasó el descuadre, no
    // siempre hoy: así cuadra en todos los cortes (no solo el de hoy).
    const fechaTxt = window.prompt('¿De qué fecha es la corrección? (AAAA-MM-DD)\nPon el día en que ocurrió el descuadre, no el de hoy.', alDia)
    if (fechaTxt === null) return
    const fecha = String(fechaTxt).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { setAviso({ tipo: 'error', texto: 'Fecha inválida. Usa el formato AAAA-MM-DD.' }); return }
    const { error } = await supabase.schema('produccion').from('ajuste_balanceado')
      .insert({ finca_id: finca.id, fecha, producto_id: f.producto_id, cantidad: delta, motivo: motivo.trim() })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${f.producto} corregido.` }); await cargar()
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
      <div style={{ display: 'flex', gap: '9px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <Chip on={seccion === 'bodega'} onClick={() => setSeccion('bodega')}>Bodega</Chip>
        <Chip on={seccion === 'ingresos'} onClick={() => { setSeccion('ingresos'); setContando(false) }}>Ingresos</Chip>
        {seccion === 'bodega' && !contando && !cargando && (
          <button onClick={() => setContando(true)} style={{ ...btn, marginLeft: 'auto',
            background: AZUL, color: 'white', borderColor: AZUL }}>
            {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
          </button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
          background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
          color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {seccion === 'ingresos' ? (
        <IngresosBalanceado finca={finca} esJefe={esJefe} onCambio={cargar} onCorreccion={onCorreccion} />
      ) : contando ? (
        <Caja>
          {editToma && (
            <div style={{ padding: '11px 16px', background: '#E6F1FB', color: AZUL, fontSize: '13px', borderBottom: '0.5px solid ' + BORDE }}>
              Editando el conteo del {corta(editToma.fecha)}. Cambia las cantidades y guarda.
            </div>
          )}
          <div style={{ padding: '15px 16px', borderBottom: '0.5px solid ' + BORDE, display: 'flex',
                        gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Campo label="Fecha del conteo">
              <input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} />
            </Campo>
            <div style={{ flex: 1, minWidth: '220px' }}>
              <Campo label="Observación">
                <input value={obs} placeholder="Quién contó" onChange={e => setObs(e.target.value)} style={{ ...inp, width: '100%' }} />
              </Campo>
            </div>
          </div>

          {/* Agregar balanceados que faltan, varios a la vez. */}
          <div style={{ padding: '12px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#fbfdfe' }}>
            {nuevos.length === 0 ? (
              <button onClick={() => setNuevos([filaNueva()])} style={btnLink}>
                + ¿Falta un balanceado? {esJefeGlobal ? 'Agrégalo aquí' : 'Pídelo al jefe'}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: '12px', color: GRIS, marginBottom: '8px' }}>
                  Balanceados nuevos (puedes agregar varios):
                </div>
                {nuevos.map((n, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px', flexWrap: 'wrap' }}>
                    <input autoFocus={i === nuevos.length - 1} value={n.nombre} placeholder="Nombre del balanceado"
                      onChange={e => setNuevo(i, 'nombre', e.target.value)} style={{ ...inp, flex: 1, minWidth: '200px' }} />
                    <input value={n.marca} placeholder="Marca (opcional)"
                      onChange={e => setNuevo(i, 'marca', e.target.value)} style={{ ...inp, width: '160px' }} />
                    <button onClick={() => setNuevos(ns => ns.filter((_, j) => j !== i))} title="Quitar"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                  <button onClick={() => setNuevos(ns => [...ns, filaNueva()])} style={btnLink}>+ Otro balanceado</button>
                  <span style={{ marginLeft: 'auto' }} />
                  <button onClick={() => setNuevos([])} style={btn}>Cancelar</button>
                  <button onClick={guardarNuevos} disabled={guardandoNuevos || !nuevos.some(n => n.nombre.trim())}
                    style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL,
                             opacity: (guardandoNuevos || !nuevos.some(n => n.nombre.trim())) ? 0.5 : 1 }}>
                    {guardandoNuevos ? (esJefeGlobal ? 'Agregando...' : 'Enviando...') : (esJefeGlobal ? 'Agregar a la lista' : 'Enviar pedido al jefe')}
                  </button>
                </div>
              </div>
            )}
          </div>

          <Encabezado gtc={G_CONTEO} cols={['Balanceado', 'Llega / se aplica', (primeraVez || editToma) ? '' : 'El sistema dice', editToma ? 'Contado' : primeraVez ? 'Inventario inicial' : 'Contado', (primeraVez || editToma) ? '' : 'Diferencia']} />
          {(primeraVez || editToma ? filas : filas.filter(f => coincide(f.producto))).map(f => (
            <Fila gtc={G_CONTEO} key={f.producto_id}>
              <Cel>{f.producto}</Cel>
              <Cel gris><span style={{ color: NAVY, fontWeight: 500 }}>Saco</span> → Libras<div style={{ fontSize: '10px', color: GRIS }}>1 saco = {lps} lb</div></Cel>
              <Cel der gris>{(primeraVez || editToma) ? '' : limpio(f.saldo)}</Cel>
              <div style={{ padding: '5px 10px' }}>
                {primeraVez ? (
                  <CampoNumero maxDec={2} value={contado[f.producto_id] ?? ''} placeholder="Sacos"
                    onChange={v => setContado(c => ({ ...c, [f.producto_id]: v }))}
                    style={{ ...inp, width: '100%', textAlign: 'right' }} />
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                        <span style={{ fontSize: '10px', color: GRIS }}>Sacos completos</span>
                        <CampoNumero maxDec={2} value={contado[f.producto_id] ?? ''} placeholder="0"
                          onChange={v => setContado(c => ({ ...c, [f.producto_id]: v }))}
                          style={{ ...inp, width: '100%', textAlign: 'right' }} />
                      </div>
                      <span style={{ color: '#c3d0db', paddingBottom: '8px' }}>+</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                        <span style={{ fontSize: '10px', color: GRIS }}>Libras sueltas</span>
                        <CampoNumero maxDec={2} value={sueltas[f.producto_id] ?? ''} placeholder="0"
                          onChange={v => setSueltas(c => ({ ...c, [f.producto_id]: v }))}
                          style={{ ...inp, width: '100%', textAlign: 'right' }} />
                      </div>
                    </div>
                    {f.contado !== null && (
                      <div style={{ fontSize: '10.5px', color: VERDE, marginTop: '4px', textAlign: 'right' }}>
                        = {limpio(f.contado)} sacos · {limpio(f.contado * lps)} lb
                      </div>
                    )}
                  </>
                )}
              </div>
              <Cel der color={f.diferencia === null ? '#c3d0db' : f.diferencia < 0 ? ROJO : f.diferencia > 0 ? AMBAR : VERDE}>
                {(primeraVez || editToma) ? '' : f.diferencia === null ? '—' : Math.abs(f.diferencia) < 0.001 ? 'Cuadra'
                  : (f.diferencia < 0 ? 'Faltan ' : 'Sobran ') + limpio(Math.abs(f.diferencia))}
              </Cel>
              {!primeraVez && f.contado !== null && Math.abs(f.diferencia || 0) > 0.001 && (
                <div style={{ gridColumn: '1 / -1', padding: '0 12px 11px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', borderBottom: '0.5px solid #f1f6f9', marginTop: '-2px' }}>
                  <span style={{ fontSize: '11px', color: GRIS }}>{f.diferencia < 0 ? '¿Por qué faltan?' : '¿Por qué sobran?'}</span>
                  <select value={motivoDesc[f.producto_id] || ''} onChange={e => setMotivoDesc(m => ({ ...m, [f.producto_id]: e.target.value }))} style={{ ...inp, width: '180px', padding: '5px 8px' }}>
                    <option value="">Elegir motivo</option>
                    {MOTIVOS_DESCUADRE.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {motivoDesc[f.producto_id] === 'Otro' && (
                    <input value={motivoOtro[f.producto_id] || ''} placeholder="Especifica el motivo"
                      onChange={e => setMotivoOtro(m => ({ ...m, [f.producto_id]: e.target.value }))} style={{ ...inp, flex: 1, minWidth: '160px', padding: '5px 8px' }} />
                  )}
                </div>
              )}
            </Fila>
          ))}
          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => { setContando(false); setContado({}); setSueltas({}); setMotivoDesc({}); setMotivoOtro({}); setEditToma(null) }} style={btn}>Cancelar</button>
            <button onClick={guardarToma} disabled={guardando || !llenadas}
              style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL,
                       opacity: (guardando || !llenadas) ? 0.5 : 1 }}>
              {guardando ? 'Guardando...' : editToma ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
            </button>
          </div>
        </Caja>
      ) : cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '9px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip pequeno on={vista === 'saldo'} onClick={() => setVista('saldo')}>Cuánto hay</Chip>
            <Chip pequeno on={vista === 'movimientos'} onClick={() => setVista('movimientos')}>Qué se movió</Chip>
            {vista === 'saldo' && nSinInv > 0 && (
              <Chip pequeno on={verSinInv} onClick={() => setVerSinInv(v => !v)}>
                {verSinInv ? 'Ocultar sin inventario' : `Sin inventario (${nSinInv})`}
              </Chip>
            )}
            <select value={busq} onChange={e => setBusq(e.target.value)}
                    style={{ ...inp, marginLeft: 'auto', minWidth: '210px' }}>
              <option value="">Todos los balanceados</option>
              {[...new Set(saldos.map(s => s.producto))].sort().map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {vista === 'saldo' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px', fontSize: '13px', color: GRIS }}>
                al <input type="date" value={alDia} max={hoyISO()} onChange={e => setAlDia(e.target.value)} style={inp} />
              </label>
            ) : (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px', fontSize: '13px', color: GRIS }}>
                del <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
                al <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
              </label>
            )}
            {esJefe && (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={exportarExcel} title="Reporte completo de bodega en Excel" style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Excel</button>
                <button onClick={exportarPDF} title="Reporte completo de bodega en PDF" style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>PDF</button>
              </div>
            )}
          </div>

          {vista === 'saldo' ? (
            <>
              {esJefe && (
                <div style={{ display: 'flex', gap: '11px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  <Kpi k="Valor de la bodega" v={dinero(valorBodega)} />
                  <Kpi k="Con problema" v={negativos ? `${negativos} en negativo` : 'Ninguno'} alerta={negativos > 0} />
                </div>
              )}
              {primeraVez && (
                filas.some(f => Number(f.saldo) !== 0) ? (
                  <Nota color={AMBAR} bg="#FAEEDA">
                    Aún no has hecho un conteo físico de esta finca. El saldo de arriba viene de los ingresos registrados. Cuando cuentes la bodega con “Cargar inventario inicial”, ese conteo fija el punto de partida.
                  </Nota>
                ) : (
                  <Nota color={AMBAR} bg="#FAEEDA">
                    Todavía no se ha contado el balanceado de esta finca. Carga el inventario inicial y de ahí el saldo se lleva solo.
                  </Nota>
                )
              )}
              <Caja>
                <Encabezado gtc={esJefe ? G_SALDO_J : G_SALDO_B} cols={esJefe ? ['Balanceado', 'Saldo', 'Precio saco', 'Valor', ''] : ['Balanceado', 'Saldo']} />
                {filas.filter(f => coincide(f.producto) && (verSinInv || !esSinInvFila(f)))
                      .sort((a, b) => (esSinInvFila(a) ? 1 : 0) - (esSinInvFila(b) ? 1 : 0))
                      .map(f => {
                  const dg = desglose[f.producto_id] || []
                  const pi = precioInfo[f.producto_id]
                  const warn = esJefe && pi?.semaforo === 'warn'
                  // Recosteable: hay algún lote SIN precio, o a un precio distinto
                  // al que rige. Los lotes sin precio son los que más lo necesitan.
                  const ruling = Number(f.precio) || 0
                  const recostable = esJefeGlobal && ruling > 0 &&
                    (lotes[f.producto_id] || []).some(L => L.costo == null || Math.abs(Number(L.costo) - ruling) > 0.005)
                  const varios = dg.length > 1 || (dg.length === 1 && dg[0].plazo !== 0) || warn || recostable
                  const ab = abierto === f.producto_id
                  const sinInv = Math.abs(Number(f.saldo)) < 0.001 && !((lotes[f.producto_id] || []).length)
                  return (
                  <div key={f.producto_id}>
                  <Fila gtc={esJefe ? G_SALDO_J : G_SALDO_B}>
                    <Cel>
                      {varios ? (
                        <button onClick={() => setAbierto(ab ? null : f.producto_id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, textAlign: 'left' }}>
                          <span style={{ color: GRIS, marginRight: '5px' }}>{ab ? '▾' : '▸'}</span>{f.producto}
                        </button>
                      ) : f.producto}
                    </Cel>
                    <Cel der fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>{sinInv ? <span style={{ fontSize: '12px', color: AMBAR, fontWeight: 400 }}>Sin inventario</span> : <>{limpio(f.saldo)} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></>}</Cel>
                    {esJefe && <Cel der>{f.precio ? <><span style={{ fontSize: '15px', fontWeight: 500, color: NAVY }}>{dineroExacto(f.precio)}</span><span style={{ display: 'block', fontSize: '10px', color: '#a7b4c1', fontWeight: 400 }}>
                      {pi?.aplicado ? `${PLAZO_LBL[pi.aplicado.plazo] || 'catálogo'}${pi.aplicado.desde ? ' · desde ' + corta(pi.aplicado.desde) : ''}` : 'catálogo'}
                      {warn && <span style={{ color: AMBAR }}> · Revisar</span>}
                    </span></> : <span style={{ color: GRIS }}>Sin precio</span>}</Cel>}
                    {esJefe && <Cel der><span style={{ fontSize: '15px', fontWeight: 500, color: NAVY }}>{dinero(Number(valorFifo[f.producto_id] || 0))}</span></Cel>}
                    {esJefe && <div style={{ padding: '6px 10px', textAlign: 'right' }}>
                      {esJefeGlobal && (sinInv
                        ? <button onClick={() => setIniForm({ productoId: f.producto_id, cantidad: '', fecha: hoyISO() })} style={{ background: '#fff', border: '0.5px solid #9cc4e8', color: AZUL, borderRadius: '8px', padding: '5px 11px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>Cargar inicial</button>
                        : <button onClick={() => corregir(f)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', color: GRIS, textDecoration: 'underline' }}>Corregir</button>)}
                    </div>}
                  </Fila>
                  {recosForm === f.producto_id && (
                    <div style={{ background: '#f6f9fb', padding: '13px 16px', borderBottom: '0.5px solid #f1f6f9' }}>
                      <div style={{ fontSize: '13px', color: NAVY, marginBottom: '6px' }}>
                        Recostear <b>{f.producto}</b> al precio que rige: <b>{dineroExacto(ruling)}</b>{pi?.aplicado ? ` · ${PLAZO_LBL[pi.aplicado.plazo]}` : ''}.
                      </div>
                      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '11px', lineHeight: 1.5 }}>
                        Los lotes a otro precio pasan a {dineroExacto(ruling)} (mantienen su fecha de compra; cambia precio y plazo) y se recostea el consumo de este balanceado. Es re-ejecutable, pero no se deshace solo.
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => recostear(f)} disabled={recosteando}
                          style={{ ...btn, background: AZUL, color: '#fff', borderColor: AZUL, opacity: recosteando ? 0.5 : 1 }}>
                          {recosteando ? 'Recosteando...' : `Recostear a ${dineroExacto(ruling)}`}
                        </button>
                        <button onClick={() => setRecosForm(null)} style={btn}>Mantener</button>
                      </div>
                    </div>
                  )}
                  {iniForm?.productoId === f.producto_id && (
                    <div style={{ background: '#f6f9fb', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div><div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Cantidad (sacos)</div><CampoNumero maxDec={2} autoFocus value={iniForm.cantidad} onChange={v => setIniForm(x => ({ ...x, cantidad: v }))} style={{ padding: '8px 9px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '8px', width: '100px', textAlign: 'right' }} /></div>
                      <div><div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Fecha</div><input type="date" value={iniForm.fecha} max={hoyISO()} onChange={e => setIniForm(x => ({ ...x, fecha: e.target.value }))} style={{ padding: '8px 9px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '8px' }} /></div>
                      <button onClick={guardarInicial} style={{ ...btn, background: AZUL, color: '#fff', borderColor: AZUL }}>Guardar inicial</button>
                      <button onClick={() => setIniForm(null)} style={btn}>Cancelar</button>
                    </div>
                  )}
                  {ab && (
                    <div style={{ padding: '10px 14px 12px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                      {esJefe && warn && pi && (
                        <div style={{ marginBottom: '12px', background: '#fff', border: '0.5px solid #e8d5b0', borderRadius: '12px', padding: '12px 14px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 500, color: AMBAR, marginBottom: '9px', textTransform: 'uppercase', letterSpacing: '.03em' }}>Verificación de precio</div>
                          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                            <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '8px 12px' }}>
                              <div style={{ fontSize: '10px', color: GRIS }}>Se aplica</div>
                              <div style={{ fontSize: '16px', fontWeight: 600 }}>{pi.aplicado ? dineroExacto(pi.aplicado.precio) : 'sin precio'}</div>
                              <div style={{ fontSize: '11px', color: GRIS }}>{pi.aplicado ? `${PLAZO_LBL[pi.aplicado.plazo]}${pi.aplicado.desde ? ' · desde ' + corta(pi.aplicado.desde) : ''}` : 'el plazo que rige no tiene precio'}</div>
                            </div>
                            {pi.otros.map((o, i) => (
                              <div key={i} style={{ background: '#FAEEDA', borderRadius: '10px', padding: '8px 12px' }}>
                                <div style={{ fontSize: '10px', color: AMBAR }}>También pusiste</div>
                                <div style={{ fontSize: '16px', fontWeight: 600, color: AMBAR }}>{dineroExacto(o.precio)}</div>
                                <div style={{ fontSize: '11px', color: AMBAR }}>{PLAZO_LBL[o.plazo]}{o.desde ? ' · desde ' + corta(o.desde) : ''} · no rige</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ fontSize: '12px', color: NAVY, lineHeight: 1.5 }}>
                            {pi.rigeSinPrecio
                              ? 'El plazo que rige no tiene precio puesto, por eso se usa un respaldo. Pon el precio en ese plazo o cambia el plazo que rige.'
                              : 'Se costea con el plazo que rige. Si querías otro precio, cambia el plazo que rige o pon ese valor en el plazo correcto.'}
                            {abrirPrecios && <>{' '}<button onClick={() => abrirPrecios()} style={{ background: 'none', border: 'none', padding: 0, color: AZUL, cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', textDecoration: 'underline' }}>Ir a precios</button></>}
                          </div>
                        </div>
                      )}
                      {esJefe && (lotes[f.producto_id] || []).length > 0 && (
                        <div style={{ marginBottom: dg.length ? '12px' : 0 }}>
                          <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', marginBottom: '8px' }}>Cuánto queda a cada precio</div>
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {[...(lotes[f.producto_id] || [])].sort((a, b) => ((a.fecha || '0') < (b.fecha || '0') ? -1 : 1)).map((L, i) => {
                              const distinto = ruling > 0 && (L.costo == null || Math.abs(Number(L.costo) - ruling) > 0.005)
                              return (
                              <div key={i} style={{ background: distinto ? '#FAEEDA' : '#fff', border: '0.5px solid ' + (distinto ? '#ecd9b3' : BORDE), borderRadius: '12px', padding: '8px 13px', fontSize: '13px', lineHeight: 1.35 }}>
                                <div><b style={{ fontWeight: 600 }}>{limpio(L.cantidad)} sacos</b>{L.costo == null ? ' · sin precio' : ' a ' + dineroExacto(L.costo)}</div>
                                <div style={{ fontSize: '11px', color: distinto ? AMBAR : GRIS }}>{L.fecha ? 'compra ' + corta(L.fecha) : 'del conteo físico'}{i === 0 ? ' · se gasta primero' : ''}{distinto && L.costo != null ? ' · no es el que rige' : ''}</div>
                                {distinto && esJefeGlobal && (
                                  <button onClick={() => setRecosForm(recosForm === f.producto_id ? null : f.producto_id)}
                                    style={{ marginTop: '7px', fontSize: '12px', padding: '4px 10px', background: '#F5D9A6', color: '#6b3f08', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                                    Recostear a {dineroExacto(ruling)}
                                  </button>
                                )}
                              </div>
                            )})}
                          </div>
                        </div>
                      )}
                      {dg.length > 0 && (
                        <div style={{ fontSize: '12px', color: GRIS }}>
                          <span style={{ textTransform: 'uppercase', fontSize: '11px', letterSpacing: '.03em' }}>Por plazo de pago: </span>
                          {dg.map((d, i) => <span key={i}>{i ? ' · ' : ''}{PLAZO_LBL[d.plazo]} {limpio(d.cantidad)}</span>)}
                          <span> sacos</span>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                )})}
              </Caja>
            </>
          ) : (
            <Caja>
              <Encabezado gtc={esJefe ? G_MOV_J : G_MOV_B} cols={['Balanceado', 'Saldo Ini.', 'Ingresos', 'Consumo', 'Devuelto', 'Ajustes', 'Conteo', 'Saldo Fin.', ...(esJefe ? ['Consumo $'] : [])]} />
              {movs.filter(m => coincide(m.producto)).map(m => {
                const cq = conteoQuien[m.producto_id]
                // Si el conteo es el inventario inicial y no había saldo antes,
                // se muestra en "Saldo Ini." (no en Conteo), como en insumos.
                const contInicial = cq?.esInicial && m.conteo !== null && Math.abs(Number(m.saldo_inicial)) < 0.0001
                const iniMostrar = contInicial ? m.conteo : m.saldo_inicial
                const conteoMostrar = contInicial ? null : m.conteo
                const detalle = cq && (
                  <>
                    <button onClick={() => setConteoDet(conteoDet === m.producto_id ? null : m.producto_id)}
                      title="Ver quién contó y cuándo"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, fontSize: '10px', padding: '0 0 0 5px', lineHeight: 1 }}>
                      {conteoDet === m.producto_id ? '▾' : '▸'}</button>
                    {conteoDet === m.producto_id && (
                      <div style={{ fontSize: '9.5px', color: GRIS, marginTop: '2px', fontWeight: 400 }}>
                        {cq.autor || 'desconocido'} · {corta(cq.fecha)}
                      </div>
                    )}
                  </>
                )
                return (
                <Fila gtc={esJefe ? G_MOV_J : G_MOV_B} key={m.producto_id}>
                  <Cel>{m.producto}</Cel>
                  <Cel der gris>
                    {limpio(iniMostrar)}
                    {contInicial && <>
                      <span style={{ display: 'block', fontSize: '9px', fontWeight: 500, color: AZUL, background: '#E6F1FB', borderRadius: '6px', padding: '1px 6px', marginTop: '3px' }}>Inventario inicial</span>
                      {detalle}
                    </>}
                  </Cel>
                  <Cel der color={Number(m.ingresos) ? VERDE : '#c3d0db'}>{Number(m.ingresos) ? '+' + limpio(m.ingresos) : '—'}</Cel>
                  <Cel der>{Number(m.consumo) ? '-' + limpio(m.consumo) : '—'}</Cel>
                  <Cel der color={Number(m.devuelto) ? ROJO : '#c3d0db'}>{Number(m.devuelto) ? '−' + limpio(m.devuelto) : '—'}</Cel>
                  <Cel der color={Number(m.ajustes) ? AMBAR : '#c3d0db'}>{Number(m.ajustes) ? (Number(m.ajustes) > 0 ? '+' : '') + limpio(m.ajustes) : '—'}</Cel>
                  <Cel der color={conteoMostrar === null ? '#c3d0db' : AZUL}>
                    {conteoMostrar === null ? '—' : <>{limpio(conteoMostrar)}{detalle}</>}
                  </Cel>
                  <Cel der fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>{limpio(m.saldo_final)}</Cel>
                  {esJefe && <Cel der>{dinero(Number(m.consumo_dolares))}</Cel>}
                </Fila>
                )
              })}
            </Caja>
          )}

          {negativos > 0 && (
            <Nota color={ROJO} bg="#FBEAEA">
              Hay {negativos} {negativos === 1 ? 'producto' : 'productos'} con saldo negativo: {' '}
              <b>{saldos.filter(s => Number(s.saldo) < -0.001).map(s => `${s.producto} (${limpio(s.saldo)})`).join(', ')}</b>.
              {' '}Se aplicó más de lo que entró. Falta cargar un ingreso o contar la bodega.
            </Nota>
          )}

          {tomas.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 8px' }}>Conteos anteriores</h3>
              <Caja>
                {tomas.map(t => (
                  <div key={t.id}>
                  <Fila gtc={esJefe ? '150px 1fr 160px' : G_DOS}>
                    <Cel fuerte>{corta(t.fecha)}</Cel>
                    <Cel gris>
                      {t.observacion || 'Sin observación'}
                      <button onClick={() => verDescuadres(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', color: AZUL, marginLeft: '8px', padding: 0 }}>
                        {detToma === t.id ? 'ocultar descuadres' : 'ver descuadres'}
                      </button>
                    </Cel>
                    {esJefe && (
                      <div style={{ padding: '6px 10px', textAlign: 'right', display: 'flex', gap: '7px', justifyContent: 'flex-end' }}>
                        <button onClick={() => editarToma(t)} style={{ ...btn, padding: '5px 11px', fontSize: '12px' }}>Editar</button>
                        <button onClick={() => borrarToma(t)} style={{ ...btn, padding: '5px 11px',
                          fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                      </div>
                    )}
                  </Fila>
                  {detToma === t.id && (
                    <div style={{ padding: '8px 16px 12px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                      {!detLineas[t.id] ? (
                        <div style={{ fontSize: '12px', color: GRIS }}>Cargando...</div>
                      ) : !detLineas[t.id].length ? (
                        <div style={{ fontSize: '12px', color: VERDE }}>Todo cuadró en este conteo.</div>
                      ) : detLineas[t.id].map((l, i) => {
                        const dif = Number(l.diferencia)
                        return (
                          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: '10px', fontSize: '12.5px', padding: '4px 0', borderTop: i ? '0.5px solid #eef3f7' : 'none' }}>
                            <span>{nombreProducto(l.producto_id)}</span>
                            <span style={{ color: GRIS }}>sistema {limpio(l.cantidad_sistema)} · contó {limpio(l.cantidad_contada)}</span>
                            <span style={{ textAlign: 'right', color: dif < 0 ? ROJO : AMBAR }}>
                              {(dif < 0 ? 'faltó ' : 'sobró ') + limpio(Math.abs(dif))}{l.motivo_descuadre ? ` · ${l.motivo_descuadre}` : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  </div>
                ))}
              </Caja>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Movimientos de balanceado: Ingresos, Pedidos y Devoluciones (3 modos).
function IngresosBalanceado({ finca, esJefe, onCambio, onCorreccion }) {
  const [modo, setModo] = useState('ingresos')   // 'ingresos' | 'pedidos' | 'devoluciones'
  const [productos, setProductos] = useState([])
  const [lista, setLista] = useState([])         // ingresos
  const [pedidos, setPedidos] = useState([])
  const [pendientes, setPendientes] = useState({})
  const [devoluciones, setDevoluciones] = useState([])
  const [usuarios, setUsuarios] = useState({})
  const [nuevo, setNuevo] = useState(null)       // 'ingreso' | 'pedido' | 'devolucion' | null
  const [fecha, setFecha] = useState(hoyISO())
  const [guia, setGuia] = useState(''); const [prov, setProv] = useState('')
  const [esperada, setEsperada] = useState(''); const [obs, setObs] = useState('')
  const [lineas, setLineas] = useState([{ productoId: '', cantidad: '' }])
  const [aviso, setAviso] = useState(null)
  const [solicitudes, setSolicitudes] = useState([])
  const [userId, setUserId] = useState(null)
  const [editando, setEditando] = useState(null)

  const cargar = useCallback(async () => {
    const [{ data: pr }, { data: g }, { data: pd }, { data: pend }, { data: dev }, { data: sol }, { data: auth }, { data: us }] = await Promise.all([
      supabase.schema('produccion').from('producto').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('ingreso_balanceado')
        .select('id, fecha, numero_guia, proveedor, creado_por, creado_en, ingreso_balanceado_linea(producto_id, cantidad)')
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
      supabase.schema('produccion').from('pedido_balanceado')
        .select('id, fecha, fecha_esperada, proveedor, estado, creado_por, creado_en, pedido_balanceado_linea(producto_id, cantidad)')
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
      supabase.schema('produccion').from('vw_pedido_balanceado_pendiente')
        .select('pedido_id, producto_id, producto, pedida, recibida, pendiente').eq('finca_id', finca.id),
      supabase.schema('produccion').from('devolucion_balanceado')
        .select('id, fecha, producto_id, cantidad, motivo, creado_por, creado_en')
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, registro_id, valor_propuesto, motivo, estado')
        .eq('finca_id', finca.id).eq('tabla', 'ingreso_balanceado').eq('estado', 'pendiente'),
      supabase.auth.getUser(),
      supabase.schema('produccion').from('vw_usuario').select('id, nombre'),
    ])
    setProductos(pr || []); setLista(g || []); setPedidos(pd || []); setDevoluciones(dev || [])
    setSolicitudes(sol || []); setUserId(auth?.user?.id || null)
    const pp = {}; (pend || []).forEach(r => { (pp[r.pedido_id] = pp[r.pedido_id] || []).push(r) }); setPendientes(pp)
    const um = {}; (us || []).forEach(u => { um[u.id] = u.nombre }); setUsuarios(um)
  }, [finca.id])
  useEffect(() => { cargar() }, [cargar])

  const nombre = id => productos.find(p => p.id === id)?.nombre || ''
  const validas = lineas.filter(l => l.productoId && numDec(l.cantidad))
  const autoria = row => {
    const n = row?.creado_por ? usuarios[row.creado_por] : null
    const cuando = row?.creado_en ? new Date(row.creado_en).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
    if (!n && !cuando) return null
    return (n ? 'Registrado por ' + n : 'Registrado') + (cuando ? ' · ' + cuando : '')
  }

  async function borrarJefe(g) {
    if (!window.confirm('¿Borrar este ingreso? Se resta de la bodega.')) return
    const { error } = await supabase.schema('produccion').from('ingreso_balanceado').delete().eq('id', g.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Ingreso borrado.' }); await cargar(); onCambio && onCambio()
  }
  async function borrarDevolucion(d) {
    if (!window.confirm('¿Borrar esta devolución? Vuelve a sumar al saldo.')) return
    const { error } = await supabase.schema('produccion').from('devolucion_balanceado').delete().eq('id', d.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setDevoluciones(prev => prev.filter(x => x.id !== d.id))
    setAviso({ tipo: 'ok', texto: 'Devolución borrada.' }); onCambio && onCambio()
  }
  async function cerrarPedido(id) {
    const { error } = await supabase.schema('produccion').from('pedido_balanceado').update({ estado: 'recibido' }).eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    await cargar()
  }
  // Marca el pedido como entregado: crea el ingreso con lo que falta y suma a bodega.
  async function entregarPedido(p) {
    const pend = (pendientes[p.id] || []).filter(x => Number(x.pendiente) > 0.0001)
    const lineasIng = pend.length
      ? pend.map(x => ({ producto_id: x.producto_id, cantidad: Number(x.pendiente) }))
      : (p.pedido_balanceado_linea || []).map(l => ({ producto_id: l.producto_id, cantidad: numDec(l.cantidad) }))
    if (!lineasIng.length) { setAviso({ tipo: 'error', texto: 'El pedido no tiene líneas.' }); return }
    if (!window.confirm(`Marcar como entregado y sumar a bodega:\n${lineasIng.map(l => `${nombre(l.producto_id)}: ${miles(l.cantidad)} sacos`).join('\n')}\n\n¿Confirmar?`)) return
    try {
      const { data: g, error } = await supabase.schema('produccion').from('ingreso_balanceado')
        .insert({ finca_id: finca.id, fecha: hoyISO(), proveedor: p.proveedor || null, pedido_id: p.id }).select('id').single()
      if (error) throw error
      const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
        .insert(lineasIng.map(l => ({ ingreso_id: g.id, producto_id: l.producto_id, cantidad: l.cantidad })))
      if (e2) throw e2
      await supabase.schema('produccion').from('pedido_balanceado').update({ estado: 'recibido' }).eq('id', p.id)
      setAviso({ tipo: 'ok', texto: 'Pedido entregado y sumado a bodega.' }); await cargar(); onCambio && onCambio()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo. ' + (err.message || '') }) }
  }
  async function borrarPedido(p) {
    if (!window.confirm('¿Borrar este pedido? No afecta el saldo (un pedido no suma).')) return
    const { error } = await supabase.schema('produccion').from('pedido_balanceado').delete().eq('id', p.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setPedidos(prev => prev.filter(x => x.id !== p.id))
    setAviso({ tipo: 'ok', texto: 'Pedido borrado.' })
  }
  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Corrección aplicada.' : 'Solicitud rechazada.' })
    await cargar(); onCambio && onCambio(); onCorreccion && onCorreccion()
  }

  function limpiarForm() {
    setNuevo(null); setLineas([{ productoId: '', cantidad: '' }])
    setGuia(''); setProv(''); setEsperada(''); setObs('')
  }

  async function guardar() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Agrega al menos una línea.' }); return }
    try {
      if (nuevo === 'ingreso') {
        const { data: g, error } = await supabase.schema('produccion').from('ingreso_balanceado')
          .insert({ finca_id: finca.id, fecha, numero_guia: guia || null, proveedor: prov || null }).select('id').single()
        if (error) throw error
        const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
          .insert(validas.map(l => ({ ingreso_id: g.id, producto_id: l.productoId, cantidad: numDec(l.cantidad) })))
        if (e2) throw e2
      } else if (nuevo === 'devolucion') {
        const { error } = await supabase.schema('produccion').from('devolucion_balanceado')
          .insert(validas.map(l => ({ finca_id: finca.id, fecha, producto_id: l.productoId, cantidad: numDec(l.cantidad), motivo: obs || null })))
        if (error) throw error
      } else { // pedido
        const { data: p, error } = await supabase.schema('produccion').from('pedido_balanceado')
          .insert({ finca_id: finca.id, fecha, fecha_esperada: esperada || null, proveedor: prov || null }).select('id').single()
        if (error) throw error
        const { error: e2 } = await supabase.schema('produccion').from('pedido_balanceado_linea')
          .insert(validas.map(l => ({ pedido_id: p.id, producto_id: l.productoId, cantidad: numDec(l.cantidad) })))
        if (e2) throw e2
      }
      const msg = nuevo === 'ingreso' ? 'Ingreso registrado.' : nuevo === 'pedido' ? 'Pedido registrado.' : 'Devolución registrada.'
      limpiarForm(); setAviso({ tipo: 'ok', texto: msg }); await cargar(); onCambio && onCambio()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') }) }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Chip on={modo === 'ingresos'} onClick={() => { setModo('ingresos'); setNuevo(null) }}>Ingresos a bodega</Chip>
        <Chip on={modo === 'devoluciones'} onClick={() => { setModo('devoluciones'); setNuevo(null) }}>Devoluciones</Chip>
        {!nuevo && (
          <button onClick={() => setNuevo(modo === 'ingresos' ? 'ingreso' : modo === 'pedidos' ? 'pedido' : 'devolucion')}
            style={{ ...btn, marginLeft: 'auto', background: AZUL, color: 'white', borderColor: AZUL }}>
            {modo === 'ingresos' ? 'Registrar ingreso' : modo === 'pedidos' ? 'Registrar pedido' : 'Registrar devolución'}
          </button>
        )}
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
        background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>}

      {modo === 'ingresos' && solicitudes.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ fontWeight: 500 }}>{esJefe ? 'Correcciones por autorizar' : 'Correcciones pendientes'} ({solicitudes.length})</div>
          {solicitudes.map(s => {
            const vp = s.valor_propuesto || {}
            return (
              <div key={s.id} style={{ borderTop: '0.5px solid #ecd9b3', paddingTop: '10px', marginTop: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500 }}>{vp.borrar ? 'Pide borrar el ingreso' : 'Propone cambios en el ingreso'}</div>
                {!vp.borrar && (
                  <div style={{ fontSize: '12px', color: GRIS, marginTop: '4px' }}>
                    {corta(vp.fecha)} · {vp.numero_guia ? ('Guía ' + vp.numero_guia) : 'Sin guía'}{vp.proveedor ? (' · ' + vp.proveedor) : ''}
                    <div>{(vp.lineas || []).map((l, i) => <span key={i}>{nombre(l.producto_id)}: {miles(l.cantidad)} sacos{i < vp.lineas.length - 1 ? '  ·  ' : ''}</span>)}</div>
                  </div>
                )}
                <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '4px' }}>Motivo: {s.motivo || '—'}</div>
                {esJefe && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '9px' }}>
                    <button onClick={() => resolver(s, true)} style={btn}>Aprobar</button>
                    <button onClick={() => resolver(s, false)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Rechazar</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {nuevo && (
        <div style={{ ...cajaS, padding: '18px', marginBottom: '14px', border: '0.5px solid ' + AZUL }}>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 14px' }}>
            {nuevo === 'ingreso' ? 'Registrar ingreso a bodega' : nuevo === 'pedido' ? 'Registrar pedido' : 'Registrar devolución a CostaMarket'}
          </h3>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} /></Campo>
            {nuevo === 'ingreso' && <Campo label="Número de guía"><input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={inp} /></Campo>}
            {nuevo === 'pedido' && <Campo label="Fecha esperada"><input type="date" value={esperada} min={fecha} onChange={e => setEsperada(e.target.value)} style={inp} /></Campo>}
            {nuevo === 'devolucion'
              ? <Campo label="Motivo / observación"><input value={obs} placeholder="Por qué se devuelve" onChange={e => setObs(e.target.value)} style={{ ...inp, width: '260px' }} /></Campo>
              : <Campo label="Proveedor"><input value={prov} placeholder="Opcional" onChange={e => setProv(e.target.value)} style={inp} /></Campo>}
          </div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Balanceados (en sacos)</div>
          {lineas.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px' }}>
              <select value={l.productoId} onChange={e => setLineas(ls => ls.map((x, j) => j === i ? { ...x, productoId: e.target.value } : x))} style={{ ...inp, flex: 1 }}>
                <option value="">Elegir balanceado</option>
                {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
              <CampoNumero maxDec={2} value={l.cantidad} placeholder="Sacos"
                onChange={v => setLineas(ls => ls.map((x, j) => j === i ? { ...x, cantidad: v } : x))} style={{ ...inp, width: '150px' }} />
              {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
            </div>
          ))}
          <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ otra línea</button>
          <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button onClick={limpiarForm} style={btn}>Cancelar</button>
            <button onClick={guardar} disabled={!validas.length} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: validas.length ? 1 : 0.5 }}>
              {nuevo === 'ingreso' ? 'Guardar ingreso' : nuevo === 'pedido' ? 'Guardar pedido' : 'Guardar devolución'}
            </button>
          </div>
        </div>
      )}

      {/* LISTAS */}
      {modo === 'ingresos' ? (
        lista.length === 0 ? (
          <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay ingresos. Cuando llegue balanceado, regístralo con su guía.</div></Caja>
        ) : lista.map(g => {
          const solPend = solicitudes.find(s => s.registro_id === g.id)
          return (
          <div key={g.id} style={{ ...cajaS, padding: '15px 17px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(g.fecha)}</div>
                <div style={{ fontSize: '12px', color: GRIS }}>{g.numero_guia ? `Guía ${g.numero_guia}` : 'Sin guía'}{g.proveedor ? ` · ${g.proveedor}` : ''}</div>
                {autoria(g) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(g)}</div>}
              </div>
              <div style={{ display: 'flex', gap: '7px', alignItems: 'flex-start' }}>
                {solPend ? (
                  <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px', borderRadius: '20px', background: '#FAEEDA', color: AMBAR, height: 'fit-content' }}>Corrección pendiente</span>
                ) : editando === g.id ? null : esJefe ? (
                  <>
                    <button onClick={() => setEditando(g.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Editar</button>
                    <button onClick={() => borrarJefe(g)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                  </>
                ) : (
                  <button onClick={() => setEditando(g.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Solicitar corrección</button>
                )}
              </div>
            </div>
            <div style={{ marginTop: '9px', borderTop: '0.5px solid #f1f6f9', paddingTop: '8px' }}>
              {(g.ingreso_balanceado_linea || []).map((l, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0' }}>
                  <span>{nombre(l.producto_id)}</span><span style={{ color: VERDE }}>+{miles(numDec(l.cantidad))} sacos</span>
                </div>
              ))}
            </div>
            {editando === g.id && (
              <EditorIngBal g={g} productos={productos} esJefe={esJefe} finca={finca} userId={userId}
                onHecho={async (msg) => { setEditando(null); await cargar(); onCambio && onCambio(); setAviso({ tipo: 'ok', texto: msg }) }}
                onCancelar={() => setEditando(null)} setAviso={setAviso} />
            )}
          </div>
          )
        })
      ) : modo === 'pedidos' ? (
        pedidos.length === 0 ? (
          <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay pedidos. Un pedido no suma al saldo: solo sirve para seguir lo que pediste.</div></Caja>
        ) : pedidos.map(p => {
          const pend = pendientes[p.id] || []
          const todoLlego = pend.every(x => Number(x.pendiente) <= 0.0001)
          return (
          <div key={p.id} style={{ ...cajaS, padding: '15px 17px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(p.fecha)}</div>
                <div style={{ fontSize: '12px', color: GRIS }}>{p.proveedor || 'Sin proveedor'}{p.fecha_esperada ? ` · esperado ${corta(p.fecha_esperada)}` : ''}</div>
                {autoria(p) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(p)}</div>}
              </div>
              <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px', borderRadius: '20px', height: 'fit-content',
                             background: p.estado !== 'abierto' ? '#eef3f7' : todoLlego ? '#E1F5EE' : '#FAEEDA',
                             color: p.estado !== 'abierto' ? GRIS : todoLlego ? VERDE : AMBAR }}>
                {p.estado !== 'abierto' ? 'Cerrado' : todoLlego ? 'Llegó todo' : 'Abierto'}
              </span>
            </div>
            <div style={{ marginTop: '9px', borderTop: '0.5px solid #f1f6f9', paddingTop: '8px' }}>
              {(p.pedido_balanceado_linea || []).map((l, i) => {
                const seg = pend.find(x => x.producto_id === l.producto_id)
                const falta = seg ? Number(seg.pendiente) : Number(l.cantidad)
                return (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '12px', alignItems: 'center', fontSize: '13px', padding: '3px 0' }}>
                    <span>{nombre(l.producto_id)}</span>
                    <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{miles(numDec(l.cantidad))} sacos</span>
                    <span style={{ minWidth: '110px', textAlign: 'right', color: falta <= 0.0001 ? VERDE : AMBAR }}>{falta <= 0.0001 ? 'llegó todo' : `faltan ${miles(falta)}`}</span>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
              {p.estado === 'abierto' && (
                <button onClick={() => entregarPedido(p)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', background: AZUL, color: 'white', borderColor: AZUL }}>Marcar entregado (sumar a bodega)</button>
              )}
              {p.estado === 'abierto' && (
                <button onClick={() => cerrarPedido(p.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: GRIS }}>Cerrar sin sumar</button>
              )}
              <button onClick={() => borrarPedido(p)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
            </div>
          </div>
          )
        })
      ) : (
        devoluciones.length === 0 ? (
          <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay devoluciones. Una devolución a CostaMarket resta del saldo.</div></Caja>
        ) : devoluciones.map(d => (
          <div key={d.id} style={{ ...cajaS, padding: '15px 17px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(d.fecha)}</div>
                <div style={{ fontSize: '13px', color: NAVY, marginTop: '3px' }}>{nombre(d.producto_id)}: <b style={{ fontWeight: 600 }}>−{miles(num(d.cantidad))}</b> sacos</div>
                {d.motivo && <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '2px' }}>{d.motivo}</div>}
                {autoria(d) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(d)}</div>}
              </div>
              {esJefe && <button onClick={() => borrarDevolucion(d)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// Editor de un ingreso de balanceado: el jefe guarda directo, el bodeguero pide.
function EditorIngBal({ g, productos, esJefe, finca, userId, onHecho, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(g.fecha)
  const [guia, setGuia] = useState(g.numero_guia || '')
  const [prov, setProv] = useState(g.proveedor || '')
  const [lineas, setLineas] = useState((g.ingreso_balanceado_linea || []).map(l => ({ productoId: l.producto_id, cantidad: String(l.cantidad) })))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const setLinea = (i, c, v) => setLineas(ls => ls.map((l, j) => j === i ? { ...l, [c]: v } : l))
  const validas = lineas.filter(l => l.productoId && numDec(l.cantidad))

  async function guardarJefe() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('ingreso_balanceado')
      .update({ fecha, numero_guia: guia || null, proveedor: prov || null }).eq('id', g.id)
    if (error) { setEnviando(false); setAviso({ tipo: 'error', texto: error.message }); return }
    await supabase.schema('produccion').from('ingreso_balanceado_linea').delete().eq('ingreso_id', g.id)
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
      .insert(validas.map(l => ({ ingreso_id: g.id, producto_id: l.productoId, cantidad: numDec(l.cantidad) })))
    setEnviando(false)
    if (e2) { setAviso({ tipo: 'error', texto: e2.message }); return }
    onHecho('Ingreso actualizado.')
  }
  async function enviarSolicitud(borrar) {
    if (!motivo.trim()) { setAviso({ tipo: 'error', texto: 'Escribe el motivo de la corrección.' }); return }
    if (!borrar && !validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const anterior = { fecha: g.fecha, numero_guia: g.numero_guia, proveedor: g.proveedor,
      lineas: (g.ingreso_balanceado_linea || []).map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad) })) }
    const propuesto = borrar ? { borrar: true }
      : { borrar: false, fecha, numero_guia: guia || null, proveedor: prov || null,
          lineas: validas.map(l => ({ producto_id: l.productoId, cantidad: numDec(l.cantidad) })) }
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'ingreso_balanceado', registro_id: g.id,
      valor_anterior: anterior, valor_propuesto: propuesto, motivo: motivo.trim(), solicitado_por: userId })
    setEnviando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    onHecho(borrar ? 'Solicitud de borrado enviada.' : 'Solicitud enviada. El jefe la revisará.')
  }

  return (
    <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '14px', marginTop: '11px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>{esJefe ? 'Editar ingreso' : 'Proponer corrección'}</div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} /></Campo>
        <Campo label="Número de guía"><input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={inp} /></Campo>
        <Campo label="Proveedor"><input value={prov} placeholder="Opcional" onChange={e => setProv(e.target.value)} style={inp} /></Campo>
      </div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Balanceados (en sacos)</div>
      {lineas.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px' }}>
          <select value={l.productoId} onChange={e => setLinea(i, 'productoId', e.target.value)} style={{ ...inp, flex: 1 }}>
            <option value="">Elegir balanceado</option>
            {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <CampoNumero maxDec={2} value={l.cantidad} placeholder="Sacos" onChange={v => setLinea(i, 'cantidad', v)} style={{ ...inp, width: '150px' }} />
          {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
        </div>
      ))}
      <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ otra línea</button>
      {!esJefe && (
        <div style={{ marginTop: '10px' }}>
          <Campo label="Motivo de la corrección"><input value={motivo} placeholder="Por qué se corrige — lo verá el jefe" onChange={e => setMotivo(e.target.value)} style={{ ...inp, width: '100%' }} /></Campo>
        </div>
      )}
      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' }}>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
        {esJefe ? (
          <button onClick={guardarJefe} disabled={enviando} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: enviando ? 0.6 : 1 }}>{enviando ? 'Guardando...' : 'Guardar cambios'}</button>
        ) : (
          <>
            <button onClick={() => enviarSolicitud(true)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Solicitar borrado</button>
            <button onClick={() => enviarSolicitud(false)} disabled={enviando} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: enviando ? 0.6 : 1 }}>{enviando ? 'Enviando...' : 'Enviar solicitud'}</button>
          </>
        )}
      </div>
    </div>
  )
}

function limpio(n) { const v = Number(n); if (!isFinite(v)) return '—'; const s = v.toFixed(2).replace(/\.?0+$/, ''); return s === '' || s === '-' ? '0' : s }
function Chip({ children, on, pequeno, onClick }) {
  return <button onClick={onClick} style={{ padding: pequeno ? '7px 12px' : '8px 15px', borderRadius: '20px',
    fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
    background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>{children}</button>
}
function Kpi({ k, v, alerta }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + (alerta ? '#e8d5b0' : BORDE), borderRadius: '12px', padding: '13px 15px', minWidth: '160px' }}>
    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '4px' }}>{k}</div>
    <div style={{ fontSize: '19px', fontWeight: 500, color: alerta ? AMBAR : NAVY }}>{v}</div>
  </div>
}
function Nota({ children, color, bg }) { return <div style={{ background: bg, color, borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginTop: '12px', lineHeight: 1.6 }}>{children}</div> }
function Caja({ children }) { return <div style={cajaS}>{children}</div> }
const cajaS = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'auto', maxHeight: '68vh' }
function Campo({ label, children }) { return <div><div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>{children}</div> }
function Encabezado({ cols, gtc }) {
  return <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: '10px 14px', fontSize: '12px', color: GRIS, background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE, position: 'sticky', top: 0, zIndex: 3 }}>
    {cols.map((c, i) => <span key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{c}</span>)}
  </div>
}
function Fila({ children, gtc }) {
  return <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', alignItems: 'center', borderBottom: '0.5px solid #f1f6f9' }}>{children}</div>
}
function Cel({ children, der, gris, fuerte, color }) {
  return <div style={{ padding: '10px 12px', fontSize: '13px', textAlign: der ? 'right' : 'left', color: color || (gris ? GRIS : NAVY), fontWeight: fuerte ? 500 : 400, fontVariantNumeric: der ? 'tabular-nums' : 'normal' }}>{children}</div>
}
const inp = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const btn = { padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const btnLink = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: '13px', color: AZUL, fontWeight: 500 }
