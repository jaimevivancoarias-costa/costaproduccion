import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, numDec, miles, dinero, dineroExacto, sumarDias, LIBRAS_POR_SACO } from '../lib/fechas'
import PreciosBalanceado from './PreciosBalanceado'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'
import BotonDescargar from '../components/BotonDescargar'
import { TabU, Seg, GhostBtn, selChip, BuscadorFiltro } from '../components/controles'

// Inventario de balanceado · igual que el de insumos, pero en sacos.
//
// El balanceado se compra en sacos y se aplica en libras. El saldo se
// lleva en sacos: baja con lo aplicado en las piscinas (libras ÷ libras_por_saco) y
// sube con los ingresos. Valorado por lotes (FIFO). Los dolares son
// solo para el jefe.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
const ROJO = '#8A2F2E', VERDE = '#0F6E56', AMBAR = '#BA7517'
const primeroDelMes = iso => iso.slice(0, 8) + '01'
const primeroMesPasado = iso => { let y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1; if (m === 0) { m = 12; y-- }; return `${y}-${String(m).padStart(2, '0')}-01` }
const ddmm = iso => corta(iso).slice(0, 5)
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
  const [modoMov, setModoMov] = useState('conteo')  // 'conteo' | 'fechas' — cómo elegir el período en "Qué se movió"
  const [periodoSel, setPeriodoSel] = useState(0)   // índice del período entre conteos
  // Al entrar a "Qué se movió" siempre arranca Por conteo, en el último conteo.
  useEffect(() => { if (vista === 'movimientos') { setModoMov('conteo'); setPeriodoSel(0) } }, [vista])
  const [busq, setBusq] = useState('')
  const coincide = nom => !busq || String(nom).toLowerCase().includes(busq.toLowerCase())
  const [alDia, setAlDia] = useState(hoyISO())
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())
  // El detalle por lote depende de "hasta" y la finca; si cambian, limpiar caché.
  useEffect(() => { setLotesMov({}); setMovDet(null) }, [hasta, finca.id])

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
  const [lps, setLps] = useState(LIBRAS_POR_SACO)    // libras por saco (del parámetro de la base)
  const [detToma, setDetToma] = useState(null)       // conteo expandido (ver descuadres)
  const [detLineas, setDetLineas] = useState({})
  const [guardando, setGuardando] = useState(false)
  const [nuevos, setNuevos] = useState([])
  const [guardandoNuevos, setGuardandoNuevos] = useState(false)
  const [conteoQuien, setConteoQuien] = useState({})   // producto_id -> {fecha, autor}
  const [descMotivo, setDescMotivo] = useState({})     // producto_id -> motivo del descuadre (para el reporte)
  const [nombresU, setNombresU] = useState({})         // id usuario -> nombre
  const [lineasToma, setLineasToma] = useState({})     // toma_id -> [líneas completas] (resumen Conteos anteriores)
  const [consumoToma, setConsumoToma] = useState({})   // toma_id -> { porProd: {pid: $}, total } consumo del corte
  const [motivoEdit, setMotivoEdit] = useState(null)   // { tomaId, productoId } línea editando motivo
  const [motivoSel, setMotivoSel] = useState('')       // opción del dropdown
  const [motivoVal, setMotivoVal] = useState('')       // texto libre cuando es "Otro"
  const [cortesAbiertos, setCortesAbiertos] = useState({})  // toma_id -> abierto/cerrado (resumen colapsable)
  const [conteoDet, setConteoDet] = useState(null)     // producto_id con detalle abierto
  const [lotes, setLotes] = useState({})               // producto_id -> [{fecha, cantidad, costo, valor}] (FIFO, solo jefe)
  const [iniForm, setIniForm] = useState(null)         // { productoId, cantidad, fecha } al cargar inventario inicial de un producto
  const [recosForm, setRecosForm] = useState(null)     // producto_id con la confirmación de recosteo abierta
  const [corrForm, setCorrForm] = useState(null)       // producto_id con el editor de corrección abierto
  const [corrSaldo, setCorrSaldo] = useState('')       // saldo nuevo que se escribe al corregir
  const [corrMotivo, setCorrMotivo] = useState('')
  const [corrFecha, setCorrFecha] = useState('')
  const [corrUnidad, setCorrUnidad] = useState('sacos')  // 'sacos' | 'libras' — en qué unidad se escribe
  const [corrAjustes, setCorrAjustes] = useState([])     // correcciones (ajustes manuales) del producto
  const [guardandoCorr2, setGuardandoCorr2] = useState(false)
  const [recosteando, setRecosteando] = useState(false)
  const [verSinInv, setVerSinInv] = useState(false)    // mostrar también los productos sin inventario
  const [movDet, setMovDet] = useState(null)           // producto_id con el detalle por lote abierto en "Qué se movió"
  const [lotesMov, setLotesMov] = useState({})         // producto_id -> [{fecha, costo_unitario, plazo, entro, consumio, queda, es_conteo}]
  const [saldoAntes, setSaldoAntes] = useState({})     // producto_id -> saldo víspera del último conteo del rango (Por fechas)
  const [conteosRango, setConteosRango] = useState({}) // producto_id -> [{fecha, conto, antes, dif}] conteos del rango (Por fechas)
  // Carga por adelantado (no al abrir la flecha) los conteos del rango y el
  // saldo la víspera de cada uno, para que el ▸ salga al instante.
  useEffect(() => {
    if (modoMov !== 'fechas') { setConteosRango({}); setSaldoAntes({}); return }
    const ts = tomas.filter(t => t.fecha > desde && t.fecha <= hasta).sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    if (!ts.length) { setConteosRango({}); setSaldoAntes({}); return }
    let vivo = true
    ;(async () => {
      const { data: lins } = await supabase.schema('produccion').from('toma_balanceado_linea')
        .select('toma_id, producto_id, cantidad_contada').in('toma_id', ts.map(t => t.id))
      const antesPorFecha = {}
      await Promise.all(ts.map(t =>
        supabase.schema('produccion').rpc('fn_saldo_balanceado', { p_finca: finca.id, p_hasta: sumarDias(t.fecha, -1) })
          .then(r => { const m = {}; (r.data || []).forEach(x => { m[x.producto_id] = Number(x.saldo) }); antesPorFecha[t.fecha] = m })
      ))
      if (!vivo) return
      const porProd = {}
      ts.forEach(t => (lins || []).filter(l => l.toma_id === t.id).forEach(l => {
        const conto = Number(l.cantidad_contada)
        const antes = antesPorFecha[t.fecha]?.[l.producto_id]
        ;(porProd[l.producto_id] = porProd[l.producto_id] || []).push({ fecha: t.fecha, conto, antes: antes == null ? null : antes, dif: antes == null ? null : conto - antes })
      }))
      setConteosRango(porProd)
      setSaldoAntes(antesPorFecha[ts[ts.length - 1].fecha] || {})
    })()
    return () => { vivo = false }
  }, [modoMov, desde, hasta, finca.id, tomas])
  const [corrige, setCorrige] = useState(null)         // { productoId, fecha, plazo, actual } lote en corrección
  const [corrPrecio, setCorrPrecio] = useState('')     // nuevo precio por saco
  const [corrAdelante, setCorrAdelante] = useState(false)
  const [guardandoCorr, setGuardandoCorr] = useState(false)

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
          .select('id, fecha, observacion, es_inicial, creado_por').eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
        supabase.schema('produccion').rpc('fn_saldo_balanceado_plazo', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').from('finca').select('libras_por_saco').eq('id', finca.id).maybeSingle(),
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
      setLps(Number(par?.libras_por_saco) > 0 ? Number(par.libras_por_saco) : LIBRAS_POR_SACO)

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
      setConteoQuien(cq); setDescMotivo(dm); setNombresU(nombreU)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally { setCargando(false) }
  }, [finca.id, alDia, desde, hasta, esJefe])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = tomas.length === 0

  // Períodos "entre conteos": de cada conteo hasta el siguiente (o hasta hoy).
  const periodos = useMemo(() => {
    const ts = [...tomas].sort((a, b) => (a.fecha < b.fecha ? 1 : -1))  // más reciente primero
    return ts.map((t, i) => ({
      desde: t.fecha,
      hasta: i === 0 ? hoyISO() : sumarDias(ts[i - 1].fecha, -1),
      label: i === 0 ? `Conteo ${corta(t.fecha)} → Hoy` : `Conteo ${corta(t.fecha)} → Conteo ${corta(ts[i - 1].fecha)}`,
    }))
  }, [tomas])
  // En modo "por conteo", el período elegido fija desde/hasta.
  useEffect(() => {
    if (modoMov !== 'conteo') return
    const p = periodos[periodoSel]
    if (p) { setDesde(p.desde); setHasta(p.hasta) }
  }, [modoMov, periodoSel, periodos])

  // El conteo "fija" el saldo: si el período arranca justo en un conteo (o en el
  // inventario inicial), ese valor contado ES el Saldo Ini. — en todos los modos.
  const anclaInicio = m => {
    if (m.conteo === null) return false
    const c = conteoQuien[m.producto_id]
    if (c && c.fecha === desde) return true
    if (c?.esInicial && Math.abs(Number(m.saldo_inicial)) < 0.0001) return true
    return false
  }
  // La columna "Conteo" solo aparece si hay algún conteo a media vista (no al inicio).
  const hayConteoSuelto = movs.some(m => m.conteo !== null && !anclaInicio(m))
  const ocultaConteo = !hayConteoSuelto
  // En "Por fechas" usamos el Diseño A: Saldo Ini · Ingresos · Consumo ·
  // Antes del conteo · Último conteo · Saldo hoy (· Consumo $). Sin Devuelto/Ajustes.
  const gMov = modoMov === 'fechas'
    ? (esJefe ? '1.6fr repeat(6, 1fr) 1.1fr' : '1.6fr repeat(6, 1fr)')
    : (esJefe ? (ocultaConteo ? '1.3fr repeat(7, 1fr)' : G_MOV_J) : (ocultaConteo ? '1.3fr repeat(6, 1fr)' : G_MOV_B))

  // Resumen de "Conteos anteriores": todas las líneas de cada conteo + el
  // consumo $ del corte (del conteo al siguiente, o a hoy). Se carga una vez.
  useEffect(() => {
    if (!tomas.length) { setLineasToma({}); setConsumoToma({}); return }
    let vivo = true
    ;(async () => {
      const ids = tomas.map(t => t.id)
      const { data: lins } = await supabase.schema('produccion').from('toma_balanceado_linea')
        .select('toma_id, producto_id, cantidad_sistema, cantidad_contada, diferencia, motivo_descuadre').in('toma_id', ids)
      if (!vivo) return
      const byToma = {}; (lins || []).forEach(l => { (byToma[l.toma_id] = byToma[l.toma_id] || []).push(l) })
      setLineasToma(byToma)
      if (!esJefe) return
      const res = await Promise.all(tomas.map((t, i) => {
        const h = i === 0 ? hoyISO() : sumarDias(tomas[i - 1].fecha, -1)
        return supabase.schema('produccion').rpc('fn_movimiento_balanceado', { p_finca: finca.id, p_desde: t.fecha, p_hasta: h })
          .then(r => ({ id: t.id, rows: r.data || [] }))
      }))
      if (!vivo) return
      const cmap = {}
      res.forEach(({ id, rows }) => {
        const porProd = {}, sis = {}; let total = 0
        rows.forEach(r => { const d = Number(r.consumo_dolares) || 0; porProd[r.producto_id] = d; total += d; sis[r.producto_id] = Number(r.saldo_inicial) })
        cmap[id] = { porProd, total, sis }
      })
      setConsumoToma(cmap)
    })()
    return () => { vivo = false }
  }, [tomas, finca.id, esJefe])

  // Sistema "en vivo" del corte = saldo del sistema la mañana del conteo
  // (saldo_inicial recalculado). Si no hay dato, usa lo guardado en la línea.
  const sisCorte = (l, cons) => (cons && cons.sis[l.producto_id] != null) ? cons.sis[l.producto_id] : Number(l.cantidad_sistema)
  const difCorte = (l, cons) => Number(l.cantidad_contada) - sisCorte(l, cons)

  function abrirMotivo(tomaId, productoId, actual) {
    setMotivoEdit({ tomaId, productoId })
    if (actual && MOTIVOS_DESCUADRE.includes(actual)) { setMotivoSel(actual); setMotivoVal('') }
    else if (actual) { setMotivoSel('Otro'); setMotivoVal(actual) }
    else { setMotivoSel(''); setMotivoVal('') }
  }
  async function guardarMotivo(tomaId, productoId) {
    const v = motivoSel === 'Otro' ? (motivoVal || '').trim() : motivoSel
    if (!v) { setMotivoEdit(null); return }
    const { error } = await supabase.schema('produccion').from('toma_balanceado_linea')
      .update({ motivo_descuadre: v }).eq('toma_id', tomaId).eq('producto_id', productoId)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar el motivo. ' + error.message }); return }
    setLineasToma(m => ({ ...m, [tomaId]: (m[tomaId] || []).map(l => l.producto_id === productoId ? { ...l, motivo_descuadre: v } : l) }))
    setMotivoEdit(null); setMotivoSel(''); setMotivoVal('')
  }

  // Acta de un corte para imprimir (PDF), con Sistema en vivo.
  function imprimirCorte(t, idx, lins, cons) {
    const autor = nombresU[t.creado_por]
    const nFalt = lins.filter(l => difCorte(l, cons) < -0.001).length
    const hastaTxt = idx === 0 ? 'hoy' : corta(sumarDias(tomas[idx - 1].fecha, -1))
    const columnas = [
      { titulo: 'Balanceado', campo: 'nombre' },
      { titulo: 'Sistema', der: true, campo: 'sistema' },
      { titulo: 'Contó', der: true, campo: 'conto' },
      { titulo: 'Diferencia', der: true, campo: 'dif' },
      { titulo: 'Motivo', campo: 'motivo' },
      ...(esJefe ? [{ titulo: 'Consumo $', der: true, campo: 'consumo' }] : []),
    ]
    const filas = lins.map(l => {
      const dif = difCorte(l, cons)
      return {
        nombre: nombreProducto(l.producto_id),
        sistema: t.es_inicial ? '—' : limpio(sisCorte(l, cons)),
        conto: limpio(l.cantidad_contada),
        dif: t.es_inicial ? 'Inicial' : Math.abs(dif) < 0.001 ? 'Cuadró' : (dif < 0 ? 'Faltó ' : 'Sobró ') + limpio(Math.abs(dif)),
        motivo: l.motivo_descuadre || (t.es_inicial || Math.abs(dif) < 0.001 ? '—' : 'sin motivo'),
        consumo: cons ? dinero(cons.porProd[l.producto_id] || 0) : '—',
      }
    })
    const total = esJefe && cons ? { nombre: 'Total del corte', sistema: '', conto: '', dif: '', motivo: '', consumo: dinero(cons.total) } : null
    return {
      titulo: 'Acta de conteo — Balanceado', finca: finca.nombre, categoria: 'Balanceado',
      subtitulo: `Conteo del ${corta(t.fecha)}${t.es_inicial ? ' (inventario inicial)' : ''}`,
      pie: '<b>Cómo se lee:</b> Sistema = lo que debía haber la mañana del conteo. &nbsp; Contó = lo físico. &nbsp; Diferencia = Contó − Sistema. &nbsp; Consumo $ = lo consumido del corte.',
      meta: [
        { k: 'Período', v: idx === 0 ? `${corta(t.fecha)} – hoy` : `${corta(t.fecha)} – ${hastaTxt}` },
        { k: 'Contó', v: autor || '—' },
        { k: 'Faltantes', v: String(nFalt) },
        { k: 'Impreso', v: corta(hoyISO()) },
      ],
      columnas, filas, total,
    }
  }
  // Valor de la bodega = costo REAL de lo que hay (FIFO, lo que se pagó por
  // cada lote). Es la plata parada de verdad, no el precio de catálogo. Así
  // el valor cuadra con el desglose "cuánto queda a cada precio" de abajo.
  const valorBodega = useMemo(() => saldos.reduce((t, s) => t + Number(valorFifo[s.producto_id] || 0), 0), [saldos, valorFifo])
  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.producto_id]; const hayS = txt !== undefined && txt !== ''
    const lib = sueltas[s.producto_id]; const hayL = lib !== undefined && lib !== '' && Number(lib) !== 0
    const c = (hayS || hayL) ? (hayS ? Number(txt) : 0) + (hayL ? Number(String(lib).replace(',', '.')) / (lps || LIBRAS_POR_SACO) : 0) : null
    return { ...s, precio: precios[s.producto_id] || 0, contado: c,
             diferencia: c !== null ? c - Number(s.saldo) : null }
  }), [saldos, precios, contado, sueltas, lps])
  const llenadas = filas.filter(f => f.contado !== null).length
  const negativos = saldos.filter(s => Number(s.saldo) < -0.001).length
  // Sin inventario: saldo ~0 y sin lotes. Se ocultan por defecto en la bodega.
  const esSinInvFila = f => Math.abs(Number(f.saldo)) < 0.001 && !((lotes[f.producto_id] || []).length)
  const nSinInv = filas.filter(f => coincide(f.producto) && esSinInvFila(f)).length
  // En "Qué se movió": sin inventario = quedó en 0 y sin lotes, y tampoco se movió nada en el rango.
  const esSinInvMov = m => Math.abs(Number(m.saldo_final)) < 0.001 && !((lotes[m.producto_id] || []).length) &&
    !Number(m.ingresos) && !Number(m.consumo) && !Number(m.devuelto) && !Number(m.ajustes) && (m.conteo === null || m.conteo === undefined)
  const nSinInvMov = movs.filter(m => coincide(m.producto) && esSinInvMov(m)).length

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
      // Lotes en una sola línea (solo si hay más de uno; agrupa "todos al mismo precio").
      const lts = lotes[id] || []
      let lotesLinea = ''
      if (lts.length > 1) {
        const costos = [...new Set(lts.map(L => L.costo == null ? 's/p' : Number(L.costo).toFixed(6)))]
        if (costos.length === 1) {
          const pr = lts[0].costo == null ? 'sin precio' : dineroExacto(lts[0].costo)
          lotesLinea = `Lotes: ${lts.map(L => limpio(L.cantidad)).join(' · ')} sacos (todos a ${pr})`
        } else {
          lotesLinea = 'Lotes: ' + lts.map(L => `${limpio(L.cantidad)} a ${L.costo == null ? 's/p' : dineroExacto(L.costo)}`).join(' · ')
        }
      }

      totIni += numDec(m?.saldo_inicial); totIng += numDec(m?.ingresos); totDev += numDec(m?.devuelto)
      totCon += numDec(m?.consumo); totConUsd += numDec(m?.consumo_dolares); totAlaFecha += saldoAlDia; totValor += valor
      if (dif != null) { totDif += dif; if (descUsd) { totDesc += descUsd; nDesc++ } }

      const contadoInfo = cq?.fecha ? corta(cq.fecha) + (cq.autor ? ' · ' + cq.autor : '') + (cq.esInicial ? ' (inicial)' : '') : ''
      filasRep.push({
        nombre, lotesLinea, viaTop: 'Saco → lb', viaSub: `1 Saco = ${lps || LIBRAS_POR_SACO} lb`,
        inicial: limpio(m?.saldo_inicial || 0), ingresos: mas(m?.ingresos), devuelto: menos(m?.devuelto),
        consumo: menos(m?.consumo), consumoUsd: dinero(numDec(m?.consumo_dolares)),
        saldoHoy: `${limpio(saldoAlDia)} sacos`, saldoEquiv: `= ${limpio(saldoAlDia * (lps || LIBRAS_POR_SACO))} lb`,
        precio: precio ? dineroExacto(precio) : '—', precioDesde: desde ? corta(desde) : '',
        valor: dinero(valor),
        contado: conteo != null ? limpio(conteo) : '', contadoInfo,
        dif: dif != null ? conSigno(dif) : '', descuadre: descUsd ? dinero(descUsd) : (dif === 0 ? '—' : ''),
        motivo: descMotivo[id] || '',
      })
    })
    filasRep.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    // Solo mostramos las columnas del conteo si hay al menos un producto contado.
    const hayConteo = filasRep.some(f => f.contado !== '')

    const columnas = [
      { titulo: 'Balanceado', campo: 'nombre', sub: 'lotesLinea' },
      { titulo: 'Llega / aplica', campo: 'viaTop', sub: 'viaSub' },
      { titulo: 'Inicial', der: true, campo: 'inicial' },
      { titulo: 'Ingresos', der: true, campo: 'ingresos' },
      { titulo: 'Devuelto', der: true, campo: 'devuelto' },
      { titulo: 'Consumo', der: true, campo: 'consumo' },
      { titulo: 'Saldo', der: true, campo: 'saldoHoy', sub: 'saldoEquiv', destacar: true },
      { titulo: 'Consumo $', der: true, campo: 'consumoUsd' },
      { titulo: 'Precio · desde', der: true, campo: 'precio', sub: 'precioDesde' },
      { titulo: 'Valor', der: true, campo: 'valor' },
      ...(hayConteo ? [
        { titulo: 'Contado', der: true, campo: 'contado', sub: 'contadoInfo' },
        { titulo: 'Dif.', der: true, campo: 'dif' },
        { titulo: 'Descuadre $', der: true, campo: 'descuadre' },
        { titulo: 'Motivo', campo: 'motivo' },
      ] : []),
    ]
    const total = {
      nombre: 'Total', lotesLinea: '', viaTop: '', viaSub: '', inicial: limpio(totIni), ingresos: '+' + limpio(totIng),
      devuelto: totDev ? '−' + limpio(totDev) : '—', consumo: totCon ? '−' + limpio(totCon) : '—',
      saldoHoy: `${limpio(totAlaFecha)} sacos`, saldoEquiv: '', consumoUsd: dinero(totConUsd), precio: '', precioDesde: '',
      valor: dinero(totValor), contado: '', contadoInfo: '',
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

  // Cargar inventario inicial de UN producto (nuevo o sin inventario).
  // Lo registra como CONTEO INICIAL (toma es_inicial), no como ajuste: así el
  // arranque aparece en "Saldo Ini." y la columna "Ajustes" queda solo para
  // correcciones de verdad. Reutiliza el conteo inicial del día si ya existe
  // (para no crear un conteo por cada producto).
  async function guardarInicial() {
    if (!iniForm) return
    const cant = Number(String(iniForm.cantidad).replace(',', '.'))
    if (!isFinite(cant) || cant <= 0) { setAviso({ tipo: 'error', texto: 'Escribe una cantidad válida.' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iniForm.fecha)) { setAviso({ tipo: 'error', texto: 'Fecha inválida.' }); return }
    try {
      // ¿Ya hay un conteo inicial en esa fecha? Si sí, le agrego la línea.
      const { data: ex } = await supabase.schema('produccion').from('toma_balanceado')
        .select('id').eq('finca_id', finca.id).eq('fecha', iniForm.fecha).eq('es_inicial', true).maybeSingle()
      let tomaId = ex?.id
      if (!tomaId) {
        const { data: toma, error } = await supabase.schema('produccion').from('toma_balanceado')
          .insert({ finca_id: finca.id, fecha: iniForm.fecha, es_inicial: true, observacion: 'Inventario inicial' })
          .select('id').single()
        if (error) throw error
        tomaId = toma.id
      }
      // Reemplazo la línea del producto (por si se vuelve a cargar el mismo día).
      await supabase.schema('produccion').from('toma_balanceado_linea')
        .delete().eq('toma_id', tomaId).eq('producto_id', iniForm.productoId)
      const { error: e2 } = await supabase.schema('produccion').from('toma_balanceado_linea')
        .insert({ toma_id: tomaId, producto_id: iniForm.productoId, cantidad_contada: cant,
                  cantidad_sistema: 0, diferencia: cant, motivo_descuadre: null })
      if (e2) throw e2
      setIniForm(null); setAviso({ tipo: 'ok', texto: 'Inventario inicial cargado como conteo inicial.' }); await cargar()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') }) }
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

  // Detalle por lote en "Qué se movió": entró / consumió / queda por lote (FIFO).
  async function abrirMov(productoId) {
    if (movDet === productoId) { setMovDet(null); return }
    setMovDet(productoId)
    if (!lotesMov[productoId]) {
      const { data, error } = await supabase.schema('produccion')
        .rpc('fn_lotes_movimiento_bal', { p_finca: finca.id, p_producto: productoId, p_hasta: hasta })
      setLotesMov(m => ({ ...m, [productoId]: error ? [] : (data || []) }))
    }
  }

  function iniciarCorreccion(productoId, lote) {
    setCorrige({ productoId, fecha: lote.fecha, plazo: lote.plazo, actual: lote.costo_unitario, esConteo: lote.es_conteo })
    setCorrPrecio(lote.costo_unitario != null ? String(lote.costo_unitario) : '')
    setCorrAdelante(false)
  }

  // Corregir el precio de un lote: arregla el catálogo del período (o de ahí
  // en adelante) y recostea. Solo recalcula los consumos de este balanceado.
  async function guardarCorreccionPrecio() {
    if (!corrige) return
    const v = numDec(corrPrecio)
    if (!(v > 0)) { setAviso({ tipo: 'error', texto: 'Pon un precio mayor que cero.' }); return }
    const pid = corrige.productoId
    setGuardandoCorr(true)
    setAviso({ tipo: 'ok', texto: 'Corrigiendo y recalculando consumos… puede tardar unos segundos.' })
    const { error } = await supabase.schema('produccion').rpc('fn_corregir_precio_lote_bal', {
      p_finca: finca.id, p_producto: pid, p_fecha: corrige.fecha,
      p_plazo: corrige.plazo, p_nuevo: v, p_adelante: corrAdelante,
    })
    if (error) { setGuardandoCorr(false); setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return }
    setCorrige(null)
    await cargar()
    // Refrescar el detalle por lote en pantalla (sin recargar la página).
    const { data } = await supabase.schema('produccion')
      .rpc('fn_lotes_movimiento_bal', { p_finca: finca.id, p_producto: pid, p_hasta: hasta })
    setLotesMov(m => ({ ...m, [pid]: data || [] }))
    setGuardandoCorr(false)
    setAviso({ tipo: 'ok', texto: 'Precio corregido y consumos recalculados.' })
  }

  function abrirCorregir(f) {
    setCorrForm(f.producto_id)
    setCorrSaldo(limpio(f.saldo))
    setCorrMotivo('')
    setCorrFecha(alDia)
    setCorrUnidad('sacos')
    setCorrAjustes([])
    setAviso(null)
    // Correcciones (ajustes manuales) de este balanceado, para poder borrarlas.
    supabase.schema('produccion').from('ajuste_balanceado')
      .select('id, fecha, cantidad, motivo').eq('finca_id', finca.id).eq('producto_id', f.producto_id)
      .order('fecha', { ascending: false }).limit(20)
      .then(({ data }) => setCorrAjustes((data || []).filter(a => !/inicial/i.test(a.motivo || ''))))
  }

  async function guardarCorreccion(f) {
    let nuevo = Number(String(corrSaldo).replace(',', '.'))
    if (!isFinite(nuevo)) { setAviso({ tipo: 'error', texto: 'El saldo nuevo no es un número.' }); return }
    // Si se escribió en libras, se convierte a sacos (÷ libras por saco de la finca).
    if (corrUnidad === 'libras' && lps) nuevo = nuevo / lps
    const delta = nuevo - Number(f.saldo)
    if (Math.abs(delta) < 0.001) { setCorrForm(null); return }
    if (!corrMotivo.trim()) { setAviso({ tipo: 'error', texto: 'La corrección necesita un motivo.' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(corrFecha || '')) { setAviso({ tipo: 'error', texto: 'Pon la fecha del descuadre (AAAA-MM-DD).' }); return }
    setGuardandoCorr2(true)
    const { error } = await supabase.schema('produccion').from('ajuste_balanceado')
      .insert({ finca_id: finca.id, fecha: corrFecha, producto_id: f.producto_id, cantidad: delta, motivo: corrMotivo.trim() })
    setGuardandoCorr2(false)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setCorrForm(null); setAviso({ tipo: 'ok', texto: `${f.producto} corregido.` }); await cargar()
  }

  async function borrarCorreccion(id) {
    if (!window.confirm('¿Borrar esta corrección? El saldo se recalcula sin ella.')) return
    const { error } = await supabase.schema('produccion').from('ajuste_balanceado').delete().eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setCorrAjustes(a => a.filter(x => x.id !== id))
    setAviso({ tipo: 'ok', texto: 'Corrección borrada.' })
    await cargar()
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
      <div style={{ display: 'flex', gap: '22px', marginBottom: '18px', flexWrap: 'wrap', alignItems: 'center' }}>
        <TabU on={seccion === 'bodega'} onClick={() => setSeccion('bodega')}>Bodega</TabU>
        <TabU on={seccion === 'ingresos'} onClick={() => { setSeccion('ingresos'); setContando(false) }}>Ingresos</TabU>
        {seccion === 'bodega' && !contando && !cargando && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '9px', alignItems: 'center' }}>
            {esJefe && <BotonDescargar desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} onPDF={exportarPDF} onExcel={exportarExcel} />}
            <button onClick={() => setContando(true)} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL }}>
              {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
            </button>
          </div>
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
      ) : cargando && !saldos.length ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '18px', flexWrap: 'wrap', alignItems: 'center' }}>
            <Seg valor={vista} onCambio={setVista} opciones={[['saldo', 'Cuánto hay'], ['movimientos', 'Qué se movió']]} />
            {vista === 'saldo' && nSinInv > 0 && (
              <GhostBtn on={verSinInv} onClick={() => setVerSinInv(v => !v)}>
                {verSinInv ? 'Ocultar sin inventario' : `Sin inventario (${nSinInv})`}
              </GhostBtn>
            )}
            {vista === 'movimientos' && nSinInvMov > 0 && (
              <GhostBtn on={verSinInv} onClick={() => setVerSinInv(v => !v)}>
                {verSinInv ? 'Ocultar sin inventario' : `Sin inventario (${nSinInvMov})`}
              </GhostBtn>
            )}
            <BuscadorFiltro value={busq} onChange={setBusq}
              opciones={[...new Set(saldos.map(s => s.producto))].sort()}
              placeholder="Buscar balanceado…" />
            {vista === 'saldo' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: GRIS }}>
                al <input type="date" value={alDia} max={hoyISO()} onChange={e => setAlDia(e.target.value)} style={inp} />
              </label>
            ) : (
              <>
                <GhostBtn on={modoMov === 'fechas' && desde === primeroDelMes(hoyISO()) && hasta === hoyISO()}
                  onClick={() => { setModoMov('fechas'); setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()) }}>Este mes</GhostBtn>
                <GhostBtn on={modoMov === 'fechas' && desde === primeroMesPasado(hoyISO()) && hasta === sumarDias(primeroDelMes(hoyISO()), -1)}
                  onClick={() => { setModoMov('fechas'); setDesde(primeroMesPasado(hoyISO())); setHasta(sumarDias(primeroDelMes(hoyISO()), -1)) }}>Mes pasado</GhostBtn>
                <Seg valor={modoMov} onCambio={setModoMov} opciones={[['conteo', 'Por conteo'], ['fechas', 'Por fechas']]} />
                {modoMov === 'conteo' ? (
                  periodos.length ? (
                    <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <button onClick={() => setPeriodoSel(i => Math.min(i + 1, periodos.length - 1))} disabled={periodoSel >= periodos.length - 1}
                        style={{ ...btn, padding: '7px 10px', opacity: periodoSel >= periodos.length - 1 ? 0.4 : 1 }}>‹</button>
                      <select value={periodoSel} onChange={e => setPeriodoSel(Number(e.target.value))} style={{ ...selChip, minWidth: '250px' }}>
                        {periodos.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
                      </select>
                      <button onClick={() => setPeriodoSel(i => Math.max(i - 1, 0))} disabled={periodoSel <= 0}
                        style={{ ...btn, padding: '7px 10px', opacity: periodoSel <= 0 ? 0.4 : 1 }}>›</button>
                    </span>
                  ) : <span style={{ fontSize: '13px', color: GRIS }}>Aún no hay conteos.</span>
                ) : (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: GRIS }}>
                    del <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
                    al <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
                  </label>
                )}
              </>
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
                    <Cel der fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>{corrForm === f.producto_id
                      ? <CampoNumero autoFocus maxDec={2} value={corrSaldo} onChange={setCorrSaldo} style={{ ...inp, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderColor: '#9cc4e8' }} />
                      : sinInv ? <span style={{ fontSize: '12px', color: AMBAR, fontWeight: 400 }}>Sin inventario</span> : <>{limpio(f.saldo)} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></>}</Cel>
                    {esJefe && <Cel der>{f.precio ? <><span style={{ fontSize: '15px', fontWeight: 500, color: NAVY }}>{dineroExacto(f.precio)}</span><span style={{ display: 'block', fontSize: '10px', color: '#a7b4c1', fontWeight: 400 }}>
                      {pi?.aplicado ? `${PLAZO_LBL[pi.aplicado.plazo] || 'catálogo'}${pi.aplicado.desde ? ' · desde ' + corta(pi.aplicado.desde) : ''}` : 'catálogo'}
                      {warn && <span style={{ color: AMBAR }}> · Revisar</span>}
                    </span></> : <span style={{ color: GRIS }}>Sin precio</span>}</Cel>}
                    {esJefe && <Cel der><span style={{ fontSize: '15px', fontWeight: 500, color: NAVY }}>{dinero(Number(valorFifo[f.producto_id] || 0))}</span></Cel>}
                    {esJefe && <div style={{ padding: '6px 10px', textAlign: 'right' }}>
                      {esJefeGlobal && (sinInv
                        ? <button onClick={() => setIniForm({ productoId: f.producto_id, cantidad: '', fecha: hoyISO() })} style={{ background: '#fff', border: '0.5px solid #9cc4e8', color: AZUL, borderRadius: '8px', padding: '5px 11px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>Cargar inicial</button>
                        : <button onClick={() => (corrForm === f.producto_id ? setCorrForm(null) : abrirCorregir(f))} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', color: GRIS, textDecoration: 'underline' }}>{corrForm === f.producto_id ? 'Cerrar' : 'Corregir'}</button>)}
                    </div>}
                  </Fila>
                  {esJefeGlobal && corrForm === f.producto_id && (
                    <div style={{ padding: '10px 14px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <label style={{ fontSize: '12px', color: GRIS, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          Ingresar en
                          <Seg valor={corrUnidad} onCambio={u => {
                            const v = Number(String(corrSaldo).replace(',', '.')) || 0
                            const enSacos = corrUnidad === 'libras' ? v / (lps || 1) : v
                            setCorrSaldo(limpio(u === 'libras' ? enSacos * (lps || 1) : enSacos))
                            setCorrUnidad(u)
                          }} opciones={[['sacos', 'Sacos'], ['libras', 'Libras']]} />
                        </label>
                        <span style={{ fontSize: '12px', color: GRIS }}>Motivo:</span>
                        <input value={corrMotivo} placeholder="Por qué se corrige — queda en la bitácora"
                          onChange={e => setCorrMotivo(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && guardarCorreccion(f)}
                          style={{ ...inp, flex: 1, minWidth: '220px' }} />
                        <label style={{ fontSize: '12px', color: GRIS, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          Fecha
                          <input type="date" value={corrFecha} max={hoyISO()}
                            onChange={e => setCorrFecha(e.target.value)} style={{ ...inp, width: '150px' }} />
                        </label>
                        <Btn onClick={() => setCorrForm(null)}>Cancelar</Btn>
                        <Btn primario onClick={() => guardarCorreccion(f)} disabled={guardandoCorr2}>
                          {guardandoCorr2 ? 'Guardando...' : 'Guardar corrección'}
                        </Btn>
                      </div>
                      {corrAjustes.length > 0 && (
                        <div style={{ marginTop: '11px', fontSize: '12px', color: GRIS }}>
                          <div style={{ marginBottom: '4px' }}>Correcciones de este balanceado (bórralas si fueron un error):</div>
                          {corrAjustes.map(a => (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0' }}>
                              <span>{corta(a.fecha)} · {Number(a.cantidad) > 0 ? '+' : ''}{limpio(a.cantidad)} sacos{a.motivo ? ` · ${a.motivo}` : ''}</span>
                              <button onClick={() => borrarCorreccion(a.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11.5px', color: ROJO }}>borrar</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
                          <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', marginBottom: '10px' }}>Cuánto queda a cada precio</div>
                          <div style={{ position: 'relative', paddingLeft: '20px' }}>
                            <div style={{ position: 'absolute', left: '4px', top: '8px', bottom: '8px', width: '1.5px', background: BORDE }} />
                            {[...(lotes[f.producto_id] || [])].sort((a, b) => ((a.fecha || '0') !== (b.fecha || '0') ? ((a.fecha || '0') < (b.fecha || '0') ? -1 : 1) : (a.es_conteo === b.es_conteo ? 0 : a.es_conteo ? -1 : 1))).map((L, i) => {
                              const distinto = ruling > 0 && (L.costo == null || Math.abs(Number(L.costo) - ruling) > 0.005)
                              return (
                              <div key={i} style={{ position: 'relative', padding: '7px 0' }}>
                                <div style={{ position: 'absolute', left: '-20px', top: '12px', width: '9px', height: '9px', borderRadius: '50%', background: distinto ? '#FAEEDA' : '#fff', border: '1.5px solid ' + (distinto ? '#d9a441' : AZUL) }} />
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                                  <span style={{ fontWeight: 600, fontSize: '13.5px', fontVariantNumeric: 'tabular-nums' }}>{limpio(L.cantidad)} sacos</span>
                                  <span style={{ fontSize: '11.5px', color: distinto ? AMBAR : GRIS }}>{L.costo == null ? 'sin precio' : dineroExacto(L.costo)} · {L.fecha ? 'compra ' + corta(L.fecha) : 'del conteo físico'}{distinto && L.costo != null ? ' · no es el que rige' : ''}</span>
                                  {i === 0 && <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 8px', borderRadius: '20px', background: '#eaf6f0', color: '#0f6e56' }}>se gasta primero</span>}
                                </div>
                                {distinto && esJefeGlobal && (
                                  <button onClick={() => setRecosForm(recosForm === f.producto_id ? null : f.producto_id)}
                                    style={{ marginTop: '6px', fontSize: '12px', padding: '4px 10px', background: '#F5D9A6', color: '#6b3f08', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
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
              <Encabezado gtc={gMov} cols={modoMov === 'fechas'
                ? ['Balanceado', 'Saldo Ini.', 'Ingresos', 'Consumo', 'Antes del conteo', 'Último conteo', 'Saldo hoy', ...(esJefe ? ['Consumo $'] : [])]
                : ['Balanceado', 'Saldo Ini.', 'Ingresos', 'Consumo', 'Devuelto', 'Ajustes', ...(ocultaConteo ? [] : ['Conteo']), 'Saldo Fin.', ...(esJefe ? ['Consumo $'] : [])]} />
              {movs.filter(m => coincide(m.producto) && (verSinInv || !esSinInvMov(m)))
                    .sort((a, b) => (esSinInvMov(a) ? 1 : 0) - (esSinInvMov(b) ? 1 : 0)).map(m => {
                const cq = conteoQuien[m.producto_id]
                // Si el período arranca en un conteo (o en el inventario inicial),
                // ese valor contado ES el Saldo Ini. — no se repite en "Conteo".
                const iniEsConteo = anclaInicio(m)
                const contInicial = iniEsConteo && cq?.esInicial
                const iniMostrar = iniEsConteo ? m.conteo : m.saldo_inicial
                const conteoMostrar = iniEsConteo ? null : m.conteo
                const fechaConteoIni = cq?.fecha || desde
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
                <div key={m.producto_id}>
                <Fila gtc={gMov}>
                  <Cel>
                    <button onClick={() => abrirMov(m.producto_id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, textAlign: 'left' }}>
                      <span style={{ color: GRIS, marginRight: '7px', fontSize: '11px' }}>{movDet === m.producto_id ? '▾' : '▸'}</span>{m.producto}
                    </button>
                  </Cel>
                  <Cel der gris={!iniEsConteo} fuerte={iniEsConteo}>
                    <div>{limpio(iniMostrar)}</div>
                    {contInicial && <>
                      <span style={badgeIni}>Inicial</span>
                      {detalle}
                    </>}
                    {iniEsConteo && !contInicial && (
                      <span style={badgeIni}>Conteo {ddmm(fechaConteoIni)}</span>
                    )}
                  </Cel>
                  <Cel der color={Number(m.ingresos) ? VERDE : '#c3d0db'}>{Number(m.ingresos) ? '+' + limpio(m.ingresos) : '—'}</Cel>
                  <Cel der>{Number(m.consumo) ? '-' + limpio(m.consumo) : '—'}</Cel>
                  {modoMov === 'fechas' ? (() => {
                    const antes = saldoAntes[m.producto_id]
                    const hayCont = m.conteo !== null && m.conteo !== undefined
                    const cont = Number(m.conteo)
                    const dif = (hayCont && antes != null) ? cont - antes : null
                    return (
                      <>
                        <Cel der gris>{antes == null ? '—' : limpio(antes)}</Cel>
                        <Cel der fuerte={hayCont} color={hayCont ? AZUL : '#c3d0db'}>
                          {!hayCont ? '—' : <>
                            <div>{limpio(cont)}{detalle}</div>
                            {dif !== null && Math.abs(dif) >= 0.001 && (
                              <span style={{ display: 'block', fontSize: '10px', fontWeight: 400, color: dif < 0 ? ROJO : AMBAR }}>{dif < 0 ? 'Faltó ' : 'Sobró '}{limpio(Math.abs(dif))}</span>
                            )}
                          </>}
                        </Cel>
                        <Cel der fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>{limpio(m.saldo_final)}</Cel>
                        {esJefe && <Cel der>{dinero(Number(m.consumo_dolares))}</Cel>}
                      </>
                    )
                  })() : (
                    <>
                      <Cel der color={Number(m.devuelto) ? ROJO : '#c3d0db'}>{Number(m.devuelto) ? '−' + limpio(m.devuelto) : '—'}</Cel>
                      <Cel der color={Number(m.ajustes) ? AMBAR : '#c3d0db'}>{Number(m.ajustes) ? (Number(m.ajustes) > 0 ? '+' : '') + limpio(m.ajustes) : '—'}</Cel>
                      {!ocultaConteo && (
                        <Cel der color={conteoMostrar === null ? '#c3d0db' : AZUL}>
                          {conteoMostrar === null ? '—' : <>{limpio(conteoMostrar)}{detalle}</>}
                        </Cel>
                      )}
                      <Cel der fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>{limpio(m.saldo_final)}</Cel>
                      {esJefe && <Cel der>{dinero(Number(m.consumo_dolares))}</Cel>}
                    </>
                  )}
                </Fila>
                {movDet === m.producto_id && (
                  <div style={{ padding: '14px 20px 16px 42px', background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: '340px' }}>
                    {!lotesMov[m.producto_id] ? (
                      <div style={{ fontSize: '12px', color: GRIS }}>Cargando lotes...</div>
                    ) : lotesMov[m.producto_id].length === 0 ? (
                      <div style={{ fontSize: '12px', color: GRIS }}>No hay lotes para mostrar.</div>
                    ) : (() => {
                      const rows = [...lotesMov[m.producto_id]].sort((a, b) => ((a.fecha || '0') !== (b.fecha || '0') ? ((a.fecha || '0') < (b.fecha || '0') ? -1 : 1) : (a.es_conteo === b.es_conteo ? 0 : a.es_conteo ? -1 : 1)))
                      const gtc = esJefe ? '2.3fr .8fr .9fr .8fr 1.1fr' : '2.3fr 1fr 1fr 1fr'
                      const tEntro = rows.reduce((s, r) => s + Number(r.entro || 0), 0)
                      const tCons = rows.reduce((s, r) => s + Number(r.consumio || 0), 0)
                      const tQueda = rows.reduce((s, r) => s + Number(r.queda || 0), 0)
                      const tCosto = rows.reduce((s, r) => s + Number(r.consumio || 0) * Number(r.costo_unitario || 0), 0)
                      const cab = { fontSize: '10px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'right' }
                      const cel = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '12.5px' }
                      const tot = { ...cel, fontWeight: 700, borderTop: '1px solid ' + BORDE, paddingTop: '7px' }
                      const primerQueda = rows.findIndex(r => Number(r.queda) > 0)
                      return (
                        <div style={{ background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px' }}>
                          <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY }}>Detalle por lote</div>
                          <div style={{ fontSize: '10.5px', color: GRIS, marginBottom: '11px' }}>
                            Se consume del más viejo primero · en sacos
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '15px 18px', alignItems: 'baseline' }}>
                            <div style={{ ...cab, textAlign: 'left' }}>Lote</div>
                            <div style={cab}>Entró</div>
                            <div style={cab}>Consumió</div>
                            <div style={cab}>Queda</div>
                            {esJefe && <div style={cab}>Costo consumido</div>}
                            {rows.map((r, i) => (
                              <Fragment key={i}>
                                <div style={{ fontSize: '12.5px', textAlign: 'left', lineHeight: 1.45 }}>
                                  <div style={{ fontWeight: 600 }}>{r.es_conteo ? 'Conteo' : 'Compra'} {r.fecha ? corta(r.fecha) : '—'}</div>
                                  {esJefe && r.costo_unitario != null && <div style={{ color: GRIS, fontSize: '11.5px' }}>{dineroExacto(r.costo_unitario)} /saco</div>}
                                  {i === primerQueda && Number(r.queda) > 0 && <div style={{ fontSize: '10px', color: GRIS }}>se gasta primero</div>}
                                  {esJefe && (
                                    <button onClick={() => iniciarCorreccion(m.producto_id, r)} style={{ marginTop: '3px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', color: AZUL }}>
                                      Corregir precio
                                    </button>
                                  )}
                                </div>
                                <div style={cel}>{limpio(r.entro)}</div>
                                <div style={{ ...cel, color: Number(r.consumio) ? ROJO : '#c3d0db' }}>{Number(r.consumio) ? limpio(r.consumio) : '—'}</div>
                                <div style={{ ...cel, fontWeight: 600 }}>{limpio(r.queda)}</div>
                                {esJefe && <div style={cel}>{dinero(Number(r.consumio) * Number(r.costo_unitario || 0))}</div>}
                              </Fragment>
                            ))}
                            <div style={{ ...tot, textAlign: 'left' }}>Total</div>
                            <div style={tot}>{limpio(tEntro)}</div>
                            <div style={tot}>{limpio(tCons)}</div>
                            <div style={tot}>{limpio(tQueda)}</div>
                            {esJefe && <div style={tot}>{dinero(tCosto)}</div>}
                          </div>
                          {esJefe && corrige && corrige.productoId === m.producto_id && (
                            <div style={{ marginTop: '14px', maxWidth: '720px', background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px' }}>
                              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '2px' }}>Corregir precio · {corrige.esConteo ? 'Conteo' : 'Compra'} {corta(corrige.fecha)}</div>
                              <div style={{ fontSize: '12px', color: GRIS, marginBottom: '11px' }}>
                                Actual {corrige.actual != null ? dineroExacto(corrige.actual) : 's/p'} /saco · {PLAZO_LBL[corrige.plazo] || 'contado'}. Se recalculan solo los consumos de este balanceado.
                              </div>
                              <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                <div>
                                  <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Nuevo precio /saco</div>
                                  <CampoNumero maxDec={6} autoFocus value={corrPrecio} onChange={v => setCorrPrecio(v)} style={{ ...inp, width: '130px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderColor: '#9cc4e8' }} />
                                </div>
                                <div>
                                  <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Aplicar</div>
                                  <Seg valor={corrAdelante ? 'adelante' : 'solo'} onCambio={v => setCorrAdelante(v === 'adelante')} opciones={[['solo', 'Solo este período'], ['adelante', 'De ahí en adelante']]} />
                                </div>
                              </div>
                              <div style={{ fontSize: '11.5px', color: GRIS, margin: '10px 0 12px', lineHeight: 1.5 }}>
                                {corrAdelante ? 'Cambia el precio del catálogo desde esta fecha en adelante (este plazo). Afecta las compras desde aquí.' : 'Corrige el precio del catálogo del período de esta compra, sin mover fechas. Solo afecta las compras de ese período.'}
                              </div>
                              <div style={{ display: 'flex', gap: '9px' }}>
                                <button onClick={guardarCorreccionPrecio} disabled={guardandoCorr} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardandoCorr ? 0.5 : 1 }}>{guardandoCorr ? 'Guardando...' : 'Guardar corrección'}</button>
                                <button onClick={() => setCorrige(null)} style={btn}>Cancelar</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    </div>
                    {modoMov === 'fechas' && conteosRango[m.producto_id] && conteosRango[m.producto_id].length > 0 && (() => {
                      const cs = conteosRango[m.producto_id]
                      return (
                        <div style={{ background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px', minWidth: '300px', maxWidth: '400px' }}>
                          <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY }}>Conteos en el rango</div>
                          <div style={{ fontSize: '10.5px', color: GRIS, marginBottom: '10px' }}>Qué pasó en cada conteo · en sacos</div>
                          {cs.map((c, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'baseline', padding: '8px 0', borderTop: i ? '0.5px solid #f1f6f9' : 'none', fontSize: '12.5px' }}>
                              <span>{corta(c.fecha)} <span style={{ color: GRIS, fontSize: '11.5px' }}>· {c.antes == null ? '' : `sistema ${limpio(c.antes)} → `}contó <b style={{ color: NAVY, fontWeight: 700 }}>{limpio(c.conto)}</b></span></span>
                              {c.dif == null ? <span /> : (
                                <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: Math.abs(c.dif) < 0.001 ? VERDE : (c.dif < 0 ? ROJO : AMBAR) }}>
                                  {Math.abs(c.dif) < 0.001 ? 'Cuadró' : (c.dif < 0 ? 'Faltó ' : 'Sobró ') + limpio(Math.abs(c.dif))}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                )}
                </div>
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
            <div style={{ marginTop: '20px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 12px' }}>Conteos anteriores</h3>
              {tomas.map((t, idx) => {
                const grc = `1.7fr .9fr .9fr 1fr 1.3fr${esJefe ? ' .9fr' : ''}`
                const lins = [...(lineasToma[t.id] || [])].sort((a, b) => nombreProducto(a.producto_id).localeCompare(nombreProducto(b.producto_id)))
                const cons = consumoToma[t.id]
                const autor = nombresU[t.creado_por]
                const nFalt = lins.filter(l => !t.es_inicial && difCorte(l, cons) < -0.001).length
                const hastaTxt = idx === 0 ? 'hoy' : corta(sumarDias(tomas[idx - 1].fecha, -1))
                const alSis = ddmm(sumarDias(t.fecha, -1))
                const cabCel = { fontSize: '10px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'right' }
                const vacia = { color: '#c3d0db' }
                const abierto = t.id in cortesAbiertos ? cortesAbiertos[t.id] : false
                return (
                  <div key={t.id} style={{ ...cajaS, maxHeight: 'none', overflow: 'visible', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '14px 16px' }}>
                      <button onClick={() => setCortesAbiertos(a => ({ ...a, [t.id]: !abierto }))}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', flex: 1, minWidth: '240px' }}>
                        <div style={{ fontSize: '14.5px', fontWeight: 700, color: NAVY }}>
                          <span style={{ color: GRIS, marginRight: '8px', fontSize: '12px' }}>{abierto ? '▾' : '▸'}</span>
                          Conteo del {corta(t.fecha)}
                          <span style={{ fontSize: '10px', fontWeight: 700, borderRadius: '20px', padding: '2px 9px', marginLeft: '8px',
                            background: idx === 0 ? '#E6F1FB' : '#eef2f6', color: idx === 0 ? AZUL : GRIS }}>
                            {idx === 0 ? 'Corte actual' : t.es_inicial ? 'Inventario inicial' : 'Corte anterior'}</span>
                        </div>
                        <div style={{ color: GRIS, fontSize: '11.5px', marginTop: '3px', marginLeft: '20px' }}>
                          {idx === 0 ? 'Desde este conteo hasta hoy' : `${ddmm(t.fecha)} → ${hastaTxt}`}
                          {autor ? ` · contó ${autor}` : ''} · {lins.length} {lins.length === 1 ? 'balanceado' : 'balanceados'} · {nFalt > 0
                            ? <b style={{ color: ROJO }}>{nFalt} {nFalt === 1 ? 'faltante' : 'faltantes'}</b>
                            : <span style={{ color: VERDE }}>todo cuadró</span>}
                        </div>
                      </button>
                      <div style={{ display: 'flex', gap: '7px' }}>
                        <button onClick={() => { if (!reporteBodegaPDF(imprimirCorte(t, idx, lins, cons))) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.' }) }}
                          style={{ ...btn, padding: '6px 12px', fontSize: '12px', background: AZUL, color: '#fff', borderColor: AZUL }}>Imprimir</button>
                        {esJefe && <>
                          <button onClick={() => editarToma(t)} style={{ ...btn, padding: '6px 12px', fontSize: '12px' }}>Editar</button>
                          <button onClick={() => borrarToma(t)} style={{ ...btn, padding: '6px 12px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                        </>}
                      </div>
                    </div>
                    {abierto && <>
                    <div style={{ display: 'grid', gridTemplateColumns: grc, gap: '10px', padding: '8px 16px', background: '#fbfcfe', borderTop: '0.5px solid ' + BORDE, borderBottom: '1px solid ' + BORDE }}>
                      {['Balanceado', 'Sistema', 'Contó', 'Diferencia', 'Motivo / qué pasó', ...(esJefe ? ['Consumo $'] : [])].map((c, i) =>
                        <span key={i} style={{ ...cabCel, textAlign: i === 0 ? 'left' : 'right' }}>{c}</span>)}
                    </div>
                    {!lineasToma[t.id] ? (
                      <div style={{ padding: '12px 16px', fontSize: '12px', color: GRIS }}>Cargando...</div>
                    ) : lins.map((l, i) => {
                      const dif = difCorte(l, cons)
                      const falto = dif < -0.001, sobro = dif > 0.001
                      const editando = motivoEdit && motivoEdit.tomaId === t.id && motivoEdit.productoId === l.producto_id
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: grc, gap: '10px', alignItems: 'baseline', padding: '9px 16px', borderBottom: '0.5px solid #f6f9fb', fontSize: '13px' }}>
                          <span>{nombreProducto(l.producto_id)}</span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {t.es_inicial ? <span style={vacia}>—</span> : <>{limpio(sisCorte(l, cons))}<span style={{ display: 'block', fontSize: '10px', color: '#9fb0bf' }}>al {alSis}</span></>}
                          </span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{limpio(l.cantidad_contada)}</span>
                          <span style={{ textAlign: 'right', color: t.es_inicial ? VERDE : falto ? ROJO : sobro ? AMBAR : VERDE }}>
                            {t.es_inicial ? 'Inicial' : falto ? 'Faltó ' + limpio(Math.abs(dif)) : sobro ? 'Sobró ' + limpio(dif) : 'Cuadró'}
                          </span>
                          <span style={{ textAlign: 'right', fontSize: '11.5px' }}>
                            {t.es_inicial ? <span style={vacia}>—</span>
                              : editando
                                ? <span style={{ display: 'inline-flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                    <select autoFocus value={motivoSel} onChange={e => setMotivoSel(e.target.value)} style={{ ...inp, padding: '3px 7px', fontSize: '12px' }}>
                                      <option value="">Motivo...</option>
                                      {MOTIVOS_DESCUADRE.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                    {motivoSel === 'Otro' && (
                                      <input autoFocus value={motivoVal} onChange={e => setMotivoVal(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') guardarMotivo(t.id, l.producto_id); if (e.key === 'Escape') setMotivoEdit(null) }}
                                        placeholder="Especifica" style={{ ...inp, padding: '3px 7px', fontSize: '12px', width: '100px' }} />
                                    )}
                                    <button onClick={() => guardarMotivo(t.id, l.producto_id)} style={{ ...btnLink, fontSize: '11.5px' }}>Guardar</button>
                                  </span>
                                : l.motivo_descuadre ? <span style={{ color: AMBAR }}>{l.motivo_descuadre}{esJefe && (falto || sobro) && <button onClick={() => abrirMotivo(t.id, l.producto_id, l.motivo_descuadre)} style={{ ...btnLink, fontSize: '10.5px', marginLeft: '6px' }}>cambiar</button>}</span>
                                : (falto || sobro)
                                  ? (esJefe
                                    ? <button onClick={() => abrirMotivo(t.id, l.producto_id, null)} style={{ ...btnLink, fontSize: '11.5px' }}>Poner motivo ›</button>
                                    : <span style={vacia}>—</span>)
                                  : <span style={vacia}>—</span>}
                          </span>
                          {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{cons ? dinero(cons.porProd[l.producto_id] || 0) : '—'}</span>}
                        </div>
                      )
                    })}
                    {esJefe && cons && (
                      <div style={{ display: 'grid', gridTemplateColumns: grc, gap: '10px', padding: '10px 16px', fontWeight: 700, borderTop: '1.5px solid ' + BORDE, fontSize: '13px' }}>
                        <span>Total del corte</span><span /><span /><span /><span />
                        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(cons.total)}</span>
                      </div>
                    )}
                    </>}
                  </div>
                )
              })}
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
  const [editandoDev, setEditandoDev] = useState(null)   // id de la devolución en edición
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())
  const [filtroProd, setFiltroProd] = useState('')   // filtro por balanceado (nombre)
  // Plazo + precio del catálogo (solo jefe).
  const [plazo, setPlazo] = useState(0)
  const [precioCat, setPrecioCat] = useState({})   // productoId -> {plazo: precio por saco}
  const [plazoAct, setPlazoAct] = useState({})      // productoId -> plazo que rige
  function precioSacoCat(productoId, pz) {
    const m = precioCat[productoId]
    if (!m) return null
    return m[pz] != null ? m[pz] : (m[0] != null ? m[0] : null)
  }
  const fmtPre = n => (n != null ? String(n) : '')
  useEffect(() => {
    let vivo = true
    ;(async () => {
      const [{ data: pr }, { data: pz }] = await Promise.all([
        esJefe
          ? supabase.schema('produccion').from('precio_producto')
              .select('producto_id, plazo, precio_saco').eq('finca_id', finca.id).is('vigente_hasta', null)
          : Promise.resolve({ data: [] }),
        supabase.schema('produccion').from('plazo_producto')
          .select('producto_id, plazo').eq('finca_id', finca.id).is('vigente_hasta', null),
      ])
      if (!vivo) return
      const cat = {}; (pr || []).forEach(x => { (cat[x.producto_id] = cat[x.producto_id] || {})[Number(x.plazo)] = Number(x.precio_saco) })
      setPrecioCat(cat)
      const pa = {}; (pz || []).forEach(x => { pa[x.producto_id] = Number(x.plazo) })
      setPlazoAct(pa)
    })()
    return () => { vivo = false }
  }, [finca.id, esJefe])

  // Datos que NO dependen de las fechas: se cargan una vez por finca. Así los
  // chips de fecha (Hoy, Este mes, Mes pasado) solo recargan lo del rango.
  const cargarFijo = useCallback(async () => {
    const [{ data: pr }, { data: pd }, { data: pend }, { data: sol }, { data: auth }, { data: us }] = await Promise.all([
      supabase.schema('produccion').from('producto').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('pedido_balanceado')
        .select('id, fecha, fecha_esperada, proveedor, estado, creado_por, creado_en, pedido_balanceado_linea(producto_id, cantidad)')
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
      supabase.schema('produccion').from('vw_pedido_balanceado_pendiente')
        .select('pedido_id, producto_id, producto, pedida, recibida, pendiente').eq('finca_id', finca.id),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, registro_id, valor_propuesto, motivo, estado')
        .eq('finca_id', finca.id).eq('tabla', 'ingreso_balanceado').eq('estado', 'pendiente'),
      supabase.auth.getUser(),
      supabase.schema('produccion').from('vw_usuario').select('id, nombre'),
    ])
    setProductos(pr || []); setPedidos(pd || []); setSolicitudes(sol || []); setUserId(auth?.user?.id || null)
    const pp = {}; (pend || []).forEach(r => { (pp[r.pedido_id] = pp[r.pedido_id] || []).push(r) }); setPendientes(pp)
    const um = {}; (us || []).forEach(u => { um[u.id] = u.nombre }); setUsuarios(um)
  }, [finca.id])
  // Datos del rango de fechas: ingresos y devoluciones.
  const cargarRango = useCallback(async () => {
    const [{ data: g }, { data: dev }] = await Promise.all([
      supabase.schema('produccion').from('ingreso_balanceado')
        .select('id, fecha, numero_guia, proveedor, creado_por, creado_en, ingreso_balanceado_linea(producto_id, cantidad, plazo, costo_unitario)')
        .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }).limit(200),
      supabase.schema('produccion').from('devolucion_balanceado')
        .select('id, fecha, producto_id, cantidad, motivo, creado_por, creado_en')
        .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }).limit(200),
    ])
    setLista(g || []); setDevoluciones(dev || [])
  }, [finca.id, desde, hasta])
  const cargar = useCallback(async () => { await Promise.all([cargarFijo(), cargarRango()]) }, [cargarFijo, cargarRango])
  useEffect(() => { cargarFijo() }, [cargarFijo])
  useEffect(() => { cargarRango() }, [cargarRango])

  const nombre = id => productos.find(p => p.id === id)?.nombre || ''
  // Filtro por balanceado (por nombre). Afecta la lista y el reporte.
  const listaF = lista.filter(g => !filtroProd || (g.ingreso_balanceado_linea || []).some(l => nombre(l.producto_id) === filtroProd))
  const devolucionesF = devoluciones.filter(d => !filtroProd || nombre(d.producto_id) === filtroProd)

  // Reporte de Ingresos + Devoluciones de balanceado (mismo formato que insumos).
  function construirReporte() {
    const quien = id => (id ? usuarios[id] : '') || ''
    const filasIng = []; let nItems = 0; const provs = new Set()
    ;[...listaF].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).forEach(g => {
      if (g.proveedor) provs.add(g.proveedor)
      ;(g.ingreso_balanceado_linea || []).forEach((l, i) => {
        nItems++
        filasIng.push({
          fecha: i === 0 ? corta(g.fecha) : '', guia: i === 0 ? (g.numero_guia || 'Sin guía') : '',
          proveedor: i === 0 ? (g.proveedor || '') : '', producto: nombre(l.producto_id),
          cantidad: `${miles(numDec(l.cantidad))} sacos`, registro: i === 0 ? quien(g.creado_por) : '',
        })
      })
    })
    const filasDev = [...devolucionesF].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).map(d => ({
      fecha: corta(d.fecha), producto: nombre(d.producto_id), cantidad: `${miles(numDec(d.cantidad))} sacos`,
      motivo: d.motivo || '', registro: quien(d.creado_por),
    }))
    const bloques = [
      { titulo: 'Ingresos a bodega',
        columnas: [{ titulo: 'Fecha', campo: 'fecha' }, { titulo: 'Guía', campo: 'guia' }, { titulo: 'Proveedor', campo: 'proveedor' },
          { titulo: 'Balanceado', campo: 'producto' }, { titulo: 'Cantidad', der: true, campo: 'cantidad' }, { titulo: 'Registró', campo: 'registro' }],
        filas: filasIng,
        total: { fecha: '', guia: '', proveedor: '', producto: 'Total ingresos', cantidad: `${nItems} ítems`, registro: '' } },
      { titulo: 'Devoluciones',
        columnas: [{ titulo: 'Fecha', campo: 'fecha' }, { titulo: 'Balanceado', campo: 'producto' },
          { titulo: 'Cantidad', der: true, campo: 'cantidad' }, { titulo: 'Motivo', campo: 'motivo' }, { titulo: 'Registró', campo: 'registro' }],
        filas: filasDev,
        total: { fecha: '', producto: 'Total devoluciones', cantidad: `${filasDev.length}`, motivo: '', registro: '' } },
    ]
    const cards = [
      { k: 'Ingresos (guías)', v: '' + listaF.length }, { k: 'Ítems ingresados', v: '' + nItems },
      { k: 'Devoluciones', v: '' + devolucionesF.length }, { k: 'Proveedores', v: '' + provs.size },
    ]
    return {
      titulo: 'Ingresos y Devoluciones — Balanceado', finca: finca.nombre, subtitulo: '',
      meta: [{ k: 'Rango', v: `${corta(desde)} – ${corta(hasta)}` }, { k: 'Impreso', v: corta(hoyISO()) }],
      cards, bloques,
      pie: 'Los ingresos se listan una fila por balanceado de cada guía. Cantidades en sacos.',
    }
  }
  function exportarExcel() { reporteBodegaExcel(construirReporte()) }
  function exportarPDF() {
    if (!reporteBodegaPDF(construirReporte())) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para exportar a PDF.' })
  }
  const validas = lineas.filter(l => l.productoId && numDec(l.cantidad))
  const [revisando, setRevisando] = useState(false)
  const [rev, setRev] = useState([])
  const setRevLinea = (i, campo) => setRev(rs => rs.map((r, j) => j === i ? { ...r, ...campo } : r))
  function abrirRevision() {
    setRev(validas.map(l => {
      const pa = plazoAct[l.productoId] != null ? plazoAct[l.productoId] : 0
      return { productoId: l.productoId, qSacos: numDec(l.cantidad), plazo: pa, precio: fmtPre(precioSacoCat(l.productoId, pa)), scope: 'solo' }
    }))
    setRevisando(true)
  }
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
        const filas = esJefe
          ? rev.map(r => {
              const fila = { ingreso_id: g.id, producto_id: r.productoId, cantidad: r.qSacos, plazo: r.plazo }
              const pu = numDec(r.precio)
              if (pu > 0) fila.costo_unitario = pu
              return fila
            })
          : validas.map(l => {
              const fila = { ingreso_id: g.id, producto_id: l.productoId, cantidad: numDec(l.cantidad) }
              const pa = plazoAct[l.productoId]
              if (pa != null) fila.plazo = pa
              return fila
            })
        const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea').insert(filas)
        if (e2) throw e2
        setRevisando(false)
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Seg valor={modo} onCambio={m => { setModo(m); setNuevo(null) }}
             opciones={[['ingresos', 'Ingresos a bodega'], ['devoluciones', 'Devoluciones']]} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '9px', alignItems: 'center' }}>
          {esJefe && (lista.length > 0 || devoluciones.length > 0) && (
            <BotonDescargar desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} onPDF={exportarPDF} onExcel={exportarExcel} conRango={false} />
          )}
          {!nuevo && (
            <button onClick={() => setNuevo(modo === 'ingresos' ? 'ingreso' : modo === 'pedidos' ? 'pedido' : 'devolucion')}
              style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL }}>
              {modo === 'ingresos' ? 'Registrar ingreso' : modo === 'pedidos' ? 'Registrar pedido' : 'Registrar devolución'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <span style={{ color: GRIS, fontSize: '13px' }}>Del</span>
        <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
        <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
        <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
        <GhostBtn on={desde === hoyISO() && hasta === hoyISO()} onClick={() => { setDesde(hoyISO()); setHasta(hoyISO()) }}>Hoy</GhostBtn>
        <GhostBtn on={desde === primeroDelMes(hoyISO()) && hasta === hoyISO()} onClick={() => { setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()) }}>Este mes</GhostBtn>
        <GhostBtn on={desde === primeroMesPasado(hoyISO()) && hasta === sumarDias(primeroDelMes(hoyISO()), -1)} onClick={() => { setDesde(primeroMesPasado(hoyISO())); setHasta(sumarDias(primeroDelMes(hoyISO()), -1)) }}>Mes pasado</GhostBtn>
        <select value={filtroProd} onChange={e => setFiltroProd(e.target.value)}
                style={{ ...selChip, marginLeft: 'auto', minWidth: '210px' }}>
          <option value="">Todos los balanceados</option>
          {[...productos].map(p => p.nombre).sort().map(n => <option key={n} value={n}>{n}</option>)}
        </select>
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
            <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={l.productoId} onChange={e => { const v = e.target.value; setLineas(ls => ls.map((x, j) => j === i ? { ...x, productoId: v } : x)) }} style={{ ...inp, flex: 1, minWidth: '180px' }}>
                <option value="">Elegir balanceado</option>
                {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
              <CampoNumero maxDec={2} value={l.cantidad} placeholder="Sacos"
                onChange={v => setLineas(ls => ls.map((x, j) => j === i ? { ...x, cantidad: v } : x))} style={{ ...inp, width: '120px' }} />
              {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
            </div>
          ))}
          <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ Otra línea</button>
          <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button onClick={limpiarForm} style={btn}>Cancelar</button>
            <button onClick={() => { if (esJefe && nuevo === 'ingreso') abrirRevision(); else guardar() }} disabled={!validas.length} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: validas.length ? 1 : 0.5 }}>
              {nuevo === 'ingreso' ? (esJefe ? 'Revisar y guardar' : 'Guardar ingreso') : nuevo === 'pedido' ? 'Guardar pedido' : 'Guardar devolución'}
            </button>
          </div>
          {revisando && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px', zIndex: 50 }}
                 onClick={e => { if (e.target === e.currentTarget) setRevisando(false) }}>
              <div style={{ background: '#fff', borderRadius: '14px', padding: '18px 20px', maxWidth: '680px', width: '100%', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(2,40,71,.25)' }}>
                <div style={{ fontSize: '15px', fontWeight: 600 }}>Revisa los precios antes de guardar</div>
                <div style={{ fontSize: '12px', color: GRIS, marginBottom: '14px' }}>Cada balanceado trae el precio del catálogo. Cambia el plazo o el precio si hace falta.</div>
                {rev.map((r, i) => {
                  const catP = precioSacoCat(r.productoId, r.plazo)
                  const cambiado = catP == null || Math.abs(numDec(r.precio) - catP) > 0.0001
                  return (
                    <div key={i} style={{ padding: '11px 0', borderTop: i ? '0.5px solid #eef3f7' : 'none' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1.1fr', gap: '10px', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, fontSize: '13px' }}>{nombre(r.productoId)} <span style={{ color: GRIS, fontWeight: 400 }}>· {miles(r.qSacos)} sacos</span></span>
                        <select value={r.plazo} onChange={e => setRevLinea(i, { plazo: Number(e.target.value), precio: fmtPre(precioSacoCat(r.productoId, Number(e.target.value))) })}
                          style={{ ...inp, padding: '6px 8px', fontSize: '12.5px' }}>
                          {[0, 30, 60, 90].map(p => <option key={p} value={p}>{PLAZO_LBL[p]}</option>)}
                        </select>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
                          <span style={{ fontSize: '12px', color: GRIS }}>$</span>
                          <CampoNumero maxDec={6} value={r.precio ?? ''} placeholder="precio" onChange={v => setRevLinea(i, { precio: v })}
                            style={{ ...inp, width: '96px', borderColor: '#9cc4e8' }} />
                          <span style={{ fontSize: '11px', color: GRIS }}>/saco</span>
                        </div>
                      </div>
                      <div style={{ fontSize: '11.5px', marginTop: '5px', textAlign: 'right' }}>
                        {catP == null ? <span style={{ color: '#BA7517' }}>sin precio en catálogo</span>
                          : !cambiado ? <span style={{ color: '#0f6e56' }}>= catálogo</span>
                          : <span style={{ color: '#9A6A00' }}>catálogo {dineroExacto(catP)} · solo para este ingreso</span>}
                      </div>
                    </div>
                  )
                })}
                <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '16px' }}>
                  <button onClick={() => setRevisando(false)} style={btn}>Volver</button>
                  <button onClick={guardar} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL }}>Guardar ingreso</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* LISTAS */}
      {modo === 'ingresos' ? (
        listaF.length === 0 ? (
          <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>{filtroProd ? 'No hay ingresos de ese balanceado en el rango.' : 'Todavía no hay ingresos. Cuando llegue balanceado, regístralo con su guía.'}</div></Caja>
        ) : (<>{listaF.map(g => {
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
              {(g.ingreso_balanceado_linea || []).map((l, i) => {
                const q = numDec(l.cantidad); const pu = Number(l.costo_unitario) || 0
                const sub = [esJefe && pu > 0 ? `${dinero(pu)}/saco` : '', l.plazo != null ? PLAZO_LBL[l.plazo] : ''].filter(Boolean).join(' · ')
                return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0', alignItems: 'baseline', gap: '12px' }}>
                  <span>{nombre(l.producto_id)}</span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>+{miles(q)} sacos
                    {sub && <span style={{ display: 'block', fontSize: '11px', color: GRIS }}>{sub}</span>}
                  </span>
                </div>
              )})}
            </div>
            {editando === g.id && (
              <EditorIngBal g={g} productos={productos} esJefe={esJefe} finca={finca} userId={userId}
                onHecho={async (msg) => { setEditando(null); await cargar(); onCambio && onCambio(); setAviso({ tipo: 'ok', texto: msg }) }}
                onCancelar={() => setEditando(null)} setAviso={setAviso} />
            )}
          </div>
          )
        })}
        {(() => {
          const porProd = {}
          listaF.forEach(g => (g.ingreso_balanceado_linea || []).forEach(l => {
            const k = l.producto_id
            if (!porProd[k]) porProd[k] = { n: 0, qty: 0, valor: 0 }
            porProd[k].n += 1
            porProd[k].qty += numDec(l.cantidad)
            porProd[k].valor += numDec(l.cantidad) * (Number(l.costo_unitario) || 0)
          }))
          const filas = Object.entries(porProd).sort((a, b) => b[1].n - a[1].n)
          if (!filas.length) return null
          const totalVal = filas.reduce((s, [, v]) => s + v.valor, 0)
          const gtc = esJefe ? '1fr 100px 120px 120px' : '1fr 110px 120px'
          const cab = { fontSize: '10px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'center' }
          return (
            <div style={{ marginTop: '14px', background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px' }}>
              <div style={{ fontSize: '12px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '10px' }}>Resumen por balanceado</div>
              <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', paddingBottom: '6px', borderBottom: '0.5px solid ' + BORDE }}>
                <span style={{ ...cab, textAlign: 'left' }}>Balanceado</span>
                <span style={cab}>Ingresos</span>
                <span style={{ ...cab, textAlign: 'right' }}>Cantidad</span>
                {esJefe && <span style={{ ...cab, textAlign: 'right' }}>Valor</span>}
              </div>
              {filas.map(([k, v]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', padding: '7px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px', alignItems: 'baseline' }}>
                  <span>{nombre(k)}</span>
                  <span style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}><b>{v.n}</b></span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{miles(Math.round(v.qty * 100) / 100)} sacos</span>
                  {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(v.valor)}</span>}
                </div>
              ))}
              {esJefe && (
                <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', padding: '9px 0 0', fontSize: '13px', fontWeight: 700 }}>
                  <span>Total</span><span /><span />
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(totalVal)}</span>
                </div>
              )}
            </div>
          )
        })()}
        </>)
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
        devolucionesF.length === 0 ? (
          <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>{filtroProd ? 'No hay devoluciones de ese balanceado en el rango.' : 'Todavía no hay devoluciones. Una devolución a CostaMarket resta del saldo.'}</div></Caja>
        ) : devolucionesF.map(d => (
          <div key={d.id} style={{ ...cajaS, padding: '15px 17px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(d.fecha)}</div>
                <div style={{ fontSize: '13px', color: NAVY, marginTop: '3px' }}>{nombre(d.producto_id)}: <b style={{ fontWeight: 600 }}>−{miles(num(d.cantidad))}</b> sacos</div>
                {d.motivo && <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '2px' }}>{d.motivo}</div>}
                {autoria(d) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(d)}</div>}
              </div>
              {esJefe && editandoDev !== d.id && (
                <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                  <button onClick={() => setEditandoDev(d.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Editar</button>
                  <button onClick={() => borrarDevolucion(d)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                </div>
              )}
            </div>
            {esJefe && editandoDev === d.id && (
              <EditorDevBal
                d={d}
                onGuardado={(nueva) => {
                  setDevoluciones(prev => prev.map(x => x.id === d.id ? { ...x, ...nueva } : x))
                  setEditandoDev(null)
                  onCambio && onCambio()
                  setAviso({ tipo: 'ok', texto: 'Devolución actualizada.' })
                }}
                onCancelar={() => setEditandoDev(null)} setAviso={setAviso} />
            )}
          </div>
        ))
      )}
    </div>
  )
}

// Editor de una devolución de balanceado (jefe): corrige fecha, cantidad y motivo.
function EditorDevBal({ d, onGuardado, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(d.fecha)
  const [cantidad, setCantidad] = useState(String(d.cantidad))
  const [motivo, setMotivo] = useState(d.motivo || '')
  const [enviando, setEnviando] = useState(false)

  async function guardar() {
    if (!numDec(cantidad)) { setAviso({ tipo: 'error', texto: 'Pon una cantidad.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('devolucion_balanceado')
      .update({ fecha, cantidad: numDec(cantidad), motivo: motivo.trim() || null }).eq('id', d.id)
    setEnviando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    onGuardado({ fecha, cantidad: numDec(cantidad), motivo: motivo.trim() || null })
  }

  return (
    <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '14px', marginTop: '11px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>Editar devolución</div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'flex-end' }}>
        <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} /></Campo>
        <Campo label="Cantidad">
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <CampoNumero maxDec={2} value={cantidad} placeholder="Cantidad" onChange={setCantidad} style={{ ...inp, width: '110px' }} />
            <span style={{ fontSize: '13px', color: GRIS, minWidth: '42px' }}>sacos</span>
          </div>
        </Campo>
      </div>
      <Campo label="Motivo"><input value={motivo} placeholder="Opcional" onChange={e => setMotivo(e.target.value)} style={{ ...inp, width: '100%' }} /></Campo>
      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' }}>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
        <button onClick={guardar} disabled={enviando} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: enviando ? 0.6 : 1 }}>{enviando ? 'Guardando...' : 'Guardar cambios'}</button>
      </div>
    </div>
  )
}

// Editor de un ingreso de balanceado: el jefe guarda directo, el bodeguero pide.
function EditorIngBal({ g, productos, esJefe, finca, userId, onHecho, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(g.fecha)
  const [guia, setGuia] = useState(g.numero_guia || '')
  const [prov, setProv] = useState(g.proveedor || '')
  const [lineas, setLineas] = useState((g.ingreso_balanceado_linea || []).map(l => ({ productoId: l.producto_id, cantidad: String(l.cantidad), precio: l.costo_unitario != null ? String(l.costo_unitario) : '' })))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [plazo, setPlazo] = useState(() => { const p = (g.ingreso_balanceado_linea || [])[0]?.plazo; return p != null ? Number(p) : 0 })
  const [precioCat, setPrecioCat] = useState({})
  const setLinea = (i, c, v) => setLineas(ls => ls.map((l, j) => j === i ? { ...l, [c]: v } : l))
  const validas = lineas.filter(l => l.productoId && numDec(l.cantidad))
  const precioSacoCat = (pid, pz) => { const m = precioCat[pid]; return m ? (m[pz] != null ? m[pz] : (m[0] != null ? m[0] : null)) : null }
  const fmtPre = n => (n != null ? String(n) : '')
  useEffect(() => {
    if (!esJefe) return
    let vivo = true
    ;(async () => {
      const { data: pr } = await supabase.schema('produccion').from('precio_producto')
        .select('producto_id, plazo, precio_saco').eq('finca_id', finca.id).is('vigente_hasta', null)
      if (!vivo) return
      const cat = {}; (pr || []).forEach(x => { (cat[x.producto_id] = cat[x.producto_id] || {})[Number(x.plazo)] = Number(x.precio_saco) })
      setPrecioCat(cat)
    })()
    return () => { vivo = false }
  }, [finca.id, esJefe])

  async function guardarJefe() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('ingreso_balanceado')
      .update({ fecha, numero_guia: guia || null, proveedor: prov || null }).eq('id', g.id)
    if (error) { setEnviando(false); setAviso({ tipo: 'error', texto: error.message }); return }
    await supabase.schema('produccion').from('ingreso_balanceado_linea').delete().eq('ingreso_id', g.id)
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
      .insert(validas.map(l => {
        const fila = { ingreso_id: g.id, producto_id: l.productoId, cantidad: numDec(l.cantidad), plazo }
        const pu = numDec(l.precio)
        if (pu > 0) fila.costo_unitario = pu
        return fila
      }))
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
      {esJefe && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Plazo de pago</div>
          <Seg valor={plazo}
               onCambio={pz => { setPlazo(pz); setLineas(ls => ls.map(l => l.productoId ? { ...l, precio: fmtPre(precioSacoCat(l.productoId, pz)) } : l)) }}
               opciones={[0, 30, 60, 90].map(p => [p, PLAZO_LBL[p]])} />
        </div>
      )}
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Balanceados (en sacos)</div>
      {lineas.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={l.productoId} onChange={e => { const v = e.target.value; setLinea(i, 'productoId', v); if (esJefe) setLinea(i, 'precio', fmtPre(precioSacoCat(v, plazo))) }} style={{ ...inp, flex: 1, minWidth: '170px' }}>
            <option value="">Elegir balanceado</option>
            {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <CampoNumero maxDec={2} value={l.cantidad} placeholder="Cantidad" onChange={v => setLinea(i, 'cantidad', v)} style={{ ...inp, width: '100px' }} />
            <span style={{ fontSize: '13px', color: GRIS, minWidth: '42px' }}>sacos</span>
          </div>
          {esJefe && l.productoId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Precio del catálogo según el plazo. Puedes cambiarlo solo para este ingreso.">
              <span style={{ fontSize: '12px', color: GRIS }}>$</span>
              <CampoNumero maxDec={6} value={l.precio ?? ''} placeholder="precio" onChange={v => setLinea(i, 'precio', v)} style={{ ...inp, width: '100px', borderColor: '#9cc4e8' }} />
              <span style={{ fontSize: '11px', color: GRIS }}>/saco</span>
            </div>
          )}
          {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
        </div>
      ))}
      <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ Otra línea</button>
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
  return <div style={{ background: '#fbfcfe', border: '1px solid ' + (alerta ? '#e8d5b0' : BORDE), borderRadius: '14px', padding: '15px 18px', minWidth: '190px' }}>
    <div style={{ fontSize: '11.5px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.04em' }}>{k}</div>
    <div style={{ fontSize: '23px', fontWeight: 700, marginTop: '5px', letterSpacing: '-.01em', color: alerta ? AMBAR : NAVY }}>{v}</div>
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
const badgeIni = { display: 'block', fontSize: '9.5px', fontWeight: 400, color: '#9fb0bf', marginTop: '2px', letterSpacing: '.01em' }
const inp = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const btn = { padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const btnLink = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: '13px', color: AZUL, fontWeight: 500 }
