import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, dinero, dineroExacto, numDec, sumarDias } from '../lib/fechas'
import Ingresos from './Ingresos'
import PreciosInsumos from './PreciosInsumos'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'
import BotonDescargar from '../components/BotonDescargar'
import { TabU, Seg, GhostBtn, selChip, BuscadorFiltro } from '../components/controles'
import TarjetaBajas from '../components/TarjetaBajas'

// Inventario de insumos · modulo Produccion
//
// Contar la bodega no suma ni resta: FIJA el saldo. Y la diferencia
// contra lo que el sistema tenia calculado no se esconde: se muestra
// antes de guardar y queda en la bitacora. Si el sistema decia 40 sacos
// de cal y hay 33, el dato util no es "ahora hay 33", es que faltan 7.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#8A2F2E'
const VERDE = '#0F6E56'
const AMBAR = '#854F0B'

// Sin abreviaturas: el bodeguero no tiene por que descifrar "lt".
// El inventario se muestra en unidad de compra (tambores, botellas,
// sacos), que es lo que devuelven las funciones de saldo.
const UNIDAD = {
  sacos: 'Sacos', litros: 'Litros', ml: 'Mililitros', gramos: 'Gramos',
  libras: 'Libras', kg: 'Kilos', unidad: 'Unidades',
  tambor: 'Tambores', botella: 'Botellas',
}
const UNIDADES = ['sacos', 'litros', 'ml', 'gramos', 'libras', 'kg', 'unidad']
// Abreviatura corta para el subtítulo de "Llega / se aplica" (ej. 5 L, 5000 mg).
const ABREV_U = { litros: 'L', ml: 'mL', mililitros: 'mL', gramos: 'g', g: 'g', mg: 'mg',
  kg: 'kg', kilos: 'kg', libras: 'lb', unidad: 'u', sacos: 'sacos', tambor: 'tambores', botella: 'botellas' }
const abrevU = u => ABREV_U[String(u || '').toLowerCase()] || UNIDAD[u] || u
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
// "Unidades" es genérico (contar los envases): no vale mostrar "Saco → Unidad".
// En cambio kilos/litros/gramos SÍ son unidades de uso reales aunque el factor sea 1.
const esUnidadGenerica = u => { const x = String(u || '').toLowerCase(); return !x || x === 'unidad' || x === 'unidades' || x === 'u' || x === 'un' || x === 'unid' }

// Primer dia del mes de una fecha, para el atajo "este mes".
const primeroDelMes = iso => iso.slice(0, 8) + '01'
const primeroMesPasado = iso => { let y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1; if (m === 0) { m = 12; y-- }; return `${y}-${String(m).padStart(2, '0')}-01` }
const ddmm = iso => corta(iso).slice(0, 5)
const badgeIni = { display: 'block', fontSize: '9.5px', fontWeight: 400, color: '#9fb0bf', marginTop: '2px', letterSpacing: '.01em' }
const navBtn = { padding: '7px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }

const ANCHOS_SALDO      = '1.3fr 200px 130px 120px 130px'
const ANCHOS_SALDO_JEFE = '1fr 180px 160px 195px 150px 115px'   // sin "Equivale a" (lo reemplaza el toggle)
const ANCHOS_SALDO_BOD  = '1.4fr 220px 160px 160px' // bodeguero: Saldo + Equivalente (sin toggle)
// Contar la bodega: recuento añade columna Equivalente; inicial no.
const ANCHOS_CONTEO_REC = '0.8fr 150px 95px 125px 235px 135px'
const ANCHOS_CONTEO_INI = '1fr 185px 95px 250px 115px'
// Editar conteo: Había antes · Contó · Consumo del día · Diferencia · Queda.
const ANCHOS_CONTEO_EDIT = '0.9fr 140px 95px 215px 110px 100px 95px'
// Capitaliza cualquier texto (POMA / poma / Poma -> Poma).
const cap1 = s => { const t = String(s || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t }
const ANCHOS_MOV        = '1fr 100px 110px 100px 100px 100px 100px 110px 120px'
const ANCHOS_MOV_BOD    = '1fr 100px 110px 100px 100px 100px 100px 110px'   // sin Consumo $
const ANCHOS_MOV2       = '1.3fr 180px 90px 90px 90px 90px 95px 95px 100px'   // inicial, entró, aplicó, devuelto, ajuste, conteo, queda
const MOTIVOS_DESCUADRE = ['Merma', 'Rotura', 'Robo', 'Error de registro', 'Otro']

export default function Inventario({ finca, esJefe, esJefeGlobal, abrirIngresos, abrirPrecios, onCorreccion }) {
  // Dos secciones: la bodega (saldo y conteos) y el movimiento de
  // producto (ingresos y pedidos).
  const [seccion, setSeccion] = useState('bodega')

  // Cuando el jefe entra desde el aviso de "correcciones por aprobar",
  // abrimos directo la seccion de ingresos.
  useEffect(() => {
    if (abrirIngresos) setSeccion('movimiento')
  }, [abrirIngresos])
  const [saldos, setSaldos] = useState([])
  const [movs, setMovs] = useState([])
  const [precios, setPrecios] = useState({})
  const [precioInfo, setPrecioInfo] = useState({})  // insumoId -> { plazo, desde } del que rige
  const [valorFifo, setValorFifo] = useState({})   // insumoId -> valor FIFO
  const [lotes, setLotes] = useState({})           // insumoId -> [{fecha, cantidad, costo, valor}] (FIFO, solo jefe)
  const [iniForm, setIniForm] = useState(null)     // { insumoId, cantidad, fecha } al cargar inventario inicial de un insumo
  const [verSinInv, setVerSinInv] = useState(false)  // mostrar también los insumos sin inventario
  const [unidadMov, setUnidadMov] = useState('compra')  // 'compra' | 'aplica' — en qué unidad ver "Qué se movió"
  const [unidadSaldo, setUnidadSaldo] = useState('compra')  // 'compra' | 'aplica' — en qué unidad ver "Cuánto hay"
  const [recosForm, setRecosForm] = useState(null)   // insumo_id con la confirmación de recosteo abierta
  const [recosteando, setRecosteando] = useState(false)
  const [desglose, setDesglose] = useState({})     // insumoId -> [{plazo, cantidad, valor}]
  const [abierto, setAbierto] = useState(null)     // insumoId con desglose expandido
  const [movDet, setMovDet] = useState(null)       // insumoId con el detalle por lote abierto en "Qué se movió"
  const [lotesMov, setLotesMov] = useState({})     // insumoId -> [{fecha, costo_unitario, plazo, entro, consumio, queda, es_conteo}]
  const [movAbierto, setMovAbierto] = useState({}) // 'insumoId|entro'|'insumoId|aplico' -> true (flechita de Entró/Se aplicó)
  const [entroDet, setEntroDet] = useState({})     // insumoId -> [{fecha, cant}] ingresos del rango (unidad de compra)
  const [aplicoDet, setAplicoDet] = useState({})   // insumoId -> [{fecha, cant}] consumos del rango (unidad de compra)
  const [corrige, setCorrige] = useState(null)     // { insumoId, fecha, plazo, actual } lote en corrección de precio
  const [corrPrecio, setCorrPrecio] = useState('') // nuevo precio (por unidad de compra)
  const [corrAdelante, setCorrAdelante] = useState(false)  // false = solo este período · true = de ahí en adelante
  const [guardandoCorr, setGuardandoCorr] = useState(false)
  const [minimos, setMinimos] = useState({})       // insumoId -> stock mínimo (unidad de aplicación)
  const [conteos, setConteos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [bajaOpen, setBajaOpen] = useState(false)      // modal "Dar de baja" (robo/merma)
  const [bajas, setBajas] = useState([])               // bajas registradas (ajustes negativos con precio FIFO)

  // Dos formas de mirar: cuanto hay a una fecha, o que paso entre dos.
  const [vista, setVista] = useState('saldo')     // 'saldo' | 'movimientos'
  const [conteoQuien, setConteoQuien] = useState({})  // insumo_id -> {fecha, autor, esInicial} del conteo
  const [iniRango, setIniRango] = useState({})        // insumo_id -> {fecha, valor} del inventario inicial DENTRO del rango
  const [descMotivo, setDescMotivo] = useState({})    // insumo_id -> motivo del descuadre (para el reporte)
  const [nombresU, setNombresU] = useState({})        // id usuario -> nombre
  const [lineasToma, setLineasToma] = useState({})    // toma_id -> [líneas completas] (resumen Conteos anteriores)
  const [consumoToma, setConsumoToma] = useState({})  // toma_id -> { porProd, sis, total } del corte
  const [consumoDiaToma, setConsumoDiaToma] = useState({})  // toma_id -> { insumo_id -> consumo del día (unidad compra) } calculado en vivo
  const [factores, setFactores] = useState({})       // insumoId -> { factor, uApp } (se usa en el efecto de consumo del día)
  const [motivoEdit, setMotivoEdit] = useState(null)  // { tomaId, insumoId } línea editando motivo
  const [motivoSel, setMotivoSel] = useState('')      // opción del dropdown
  const [motivoVal, setMotivoVal] = useState('')      // texto libre cuando es "Otro"
  const [cortesAbiertos, setCortesAbiertos] = useState({})  // toma_id -> abierto/cerrado
  const [saldoAntes, setSaldoAntes] = useState({})    // insumo_id -> saldo víspera del último conteo del rango (Por fechas)
  const [conteosRango, setConteosRango] = useState({}) // insumo_id -> [{fecha, conto, antes, dif}] conteos del rango (Por fechas)
  const [conteoDet, setConteoDet] = useState(null)    // insumo_id con el detalle del conteo abierto
  const [busq, setBusq] = useState('')            // filtro por nombre de insumo (dropdown)
  const coincide = nom => !busq || String(nom).toLowerCase().includes(busq.toLowerCase())
  const [alDia, setAlDia] = useState(hoyISO())
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())
  const [modoMov, setModoMov] = useState('conteo')  // 'conteo' | 'fechas' — cómo elegir el período en "Qué se movió"
  const [periodoSel, setPeriodoSel] = useState(0)   // índice del período entre conteos
  // Al entrar a "Qué se movió" siempre arranca Por conteo, en el último conteo.
  useEffect(() => { if (vista === 'movimientos') { setModoMov('conteo'); setPeriodoSel(0) } }, [vista])
  // El detalle por lote depende de la fecha "hasta" y la finca; si cambian,
  // se limpia la caché para no mostrar lotes de otro corte.
  useEffect(() => { setLotesMov({}); setMovDet(null) }, [hasta, finca.id])

  // Detalle de Entró (ingresos) y Se aplicó (consumos) por fecha, para las
  // flechitas de esas columnas en "Qué se movió". En unidad de COMPRA (como
  // las columnas): ingresos ya vienen en compra; consumo se ÷ por el factor.
  useEffect(() => {
    if (vista !== 'movimientos') return
    let vivo = true
    setMovAbierto({})
    ;(async () => {
      const [{ data: ings }, { data: cons }] = await Promise.all([
        supabase.schema('produccion').from('ingreso_insumo_linea')
          .select('insumo_id, cantidad, ingreso_insumo!inner(fecha, finca_id)')
          .eq('ingreso_insumo.finca_id', finca.id)
          .gte('ingreso_insumo.fecha', desde).lte('ingreso_insumo.fecha', hasta),
        supabase.schema('produccion').from('consumo_insumo')
          .select('insumo_id, cantidad, fecha, piscina!inner(finca_id)')
          .eq('piscina.finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta),
      ])
      if (!vivo) return
      const eAgg = {}
      ;(ings || []).forEach(r => { const f = r.ingreso_insumo?.fecha; if (!r.insumo_id || !f) return; const k = r.insumo_id + '|' + f; eAgg[k] = (eAgg[k] || 0) + Number(r.cantidad || 0) })
      const em = {}
      Object.entries(eAgg).forEach(([k, v]) => { const i = k.indexOf('|'); const id = k.slice(0, i), f = k.slice(i + 1); (em[id] = em[id] || []).push({ fecha: f, cant: v }) })
      Object.values(em).forEach(arr => arr.sort((a, b) => (a.fecha < b.fecha ? -1 : 1)))
      setEntroDet(em)
      const aAgg = {}
      ;(cons || []).forEach(r => { if (!r.insumo_id || !r.fecha) return; const k = r.insumo_id + '|' + r.fecha; aAgg[k] = (aAgg[k] || 0) + Number(r.cantidad || 0) })
      const am = {}
      Object.entries(aAgg).forEach(([k, v]) => { const i = k.indexOf('|'); const id = k.slice(0, i), f = k.slice(i + 1); const fa = factores[id]?.factor || 1; (am[id] = am[id] || []).push({ fecha: f, cant: v / fa }) })
      Object.values(am).forEach(arr => arr.sort((a, b) => (a.fecha < b.fecha ? -1 : 1)))
      setAplicoDet(am)
    })()
    return () => { vivo = false }
  }, [vista, desde, hasta, finca.id, factores])
  // Carga por adelantado los conteos del rango y el saldo la víspera de cada
  // uno (Diseño A, Por fechas), para que el ▸ y "Antes del conteo" salgan ya.
  useEffect(() => {
    if (modoMov !== 'fechas') { setConteosRango({}); setSaldoAntes({}); return }
    const cs = conteos.filter(c => c.fecha > desde && c.fecha <= hasta).sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    if (!cs.length) { setConteosRango({}); setSaldoAntes({}); return }
    let vivo = true
    ;(async () => {
      const { data: lins } = await supabase.schema('produccion').from('toma_inventario_linea')
        .select('toma_id, insumo_id, cantidad_contada').in('toma_id', cs.map(c => c.id))
      const antesPorFecha = {}
      await Promise.all(cs.map(c =>
        supabase.schema('produccion').rpc('fn_saldo_insumo', { p_finca: finca.id, p_hasta: sumarDias(c.fecha, -1) })
          .then(r => { const m = {}; (r.data || []).forEach(x => { m[x.insumo_id] = Number(x.saldo) }); antesPorFecha[c.fecha] = m })
      ))
      if (!vivo) return
      const porIns = {}
      cs.forEach(c => (lins || []).filter(l => l.toma_id === c.id).forEach(l => {
        const conto = Number(l.cantidad_contada)
        const antes = antesPorFecha[c.fecha]?.[l.insumo_id]
        ;(porIns[l.insumo_id] = porIns[l.insumo_id] || []).push({ fecha: c.fecha, conto, antes: antes == null ? null : antes, dif: antes == null ? null : conto - antes })
      }))
      setConteosRango(porIns)
      setSaldoAntes(antesPorFecha[cs[cs.length - 1].fecha] || {})
    })()
    return () => { vivo = false }
  }, [modoMov, desde, hasta, finca.id, conteos])

  // Períodos "entre conteos": de cada conteo hasta el siguiente (o hasta hoy).
  const periodos = useMemo(() => {
    const ts = [...conteos].sort((a, b) => (a.fecha < b.fecha ? 1 : -1))  // más reciente primero
    return ts.map((t, i) => ({
      desde: t.fecha,
      hasta: i === 0 ? hoyISO() : sumarDias(ts[i - 1].fecha, -1),
      label: i === 0 ? `Conteo ${corta(t.fecha)} → Hoy` : `Conteo ${corta(t.fecha)} → Conteo ${corta(ts[i - 1].fecha)}`,
    }))
  }, [conteos])
  // En modo "por conteo", el período elegido fija desde/hasta.
  useEffect(() => {
    if (modoMov !== 'conteo') return
    const p = periodos[periodoSel]
    if (p) { setDesde(p.desde); setHasta(p.hasta) }
  }, [modoMov, periodoSel, periodos])

  // El conteo "fija" el saldo: si el período arranca justo en un conteo (o en el
  // inventario inicial), ese valor contado ES el Saldo Ini. — en todos los modos.
  const anclaInicio = m => {
    if (m.conteo === null || m.conteo === undefined) return false
    const c = conteoQuien[m.insumo_id]
    if (c && c.fecha === desde) return true
    if (c?.esInicial && Math.abs(Number(m.saldo_inicial)) < 0.0001) return true
    return false
  }
  // Si el inventario inicial cae DENTRO del rango y antes no había nada (saldo
  // víspera ≈ 0), ese valor contado ES la apertura (Saldo Ini.), aunque luego
  // haya conteos posteriores. Devuelve el valor de apertura o null.
  const aperturaInicial = m => {
    const ini = iniRango[m.insumo_id]
    // iniRango solo tiene inventarios iniciales DENTRO del rango (fecha ≥ desde),
    // así que si existe, ese valor contado ES la apertura del corte.
    if (ini) return ini.valor
    return null
  }
  // La columna "Conteo" solo aparece si hay algún conteo a media vista (no al inicio).
  const hayConteoSuelto = movs.some(m => m.conteo !== null && m.conteo !== undefined && !anclaInicio(m))
  const ocultaConteo = !hayConteoSuelto
  // En "Por fechas" usamos el Diseño A: Saldo Ini. · Entró · Se aplicó ·
  // Antes del conteo · Último conteo · Queda. Sin Devuelto/Ajuste.
  const colsMov = modoMov === 'fechas'
    ? ['Insumo', 'Llega / se aplica', 'Saldo Ini.', 'Entró', 'Se aplicó', 'Antes del conteo', 'Último conteo', 'Queda']
    : ['Insumo', 'Llega / se aplica', ocultaConteo ? 'Saldo Ini.' : (movs.some(m => m.conteo != null) ? 'Antes del conteo' : 'Inicial'), 'Entró', 'Se aplicó', 'Devuelto', 'Ajuste', ...(ocultaConteo ? [] : ['Conteo']), 'Queda']
  const anchosMov = modoMov === 'fechas'
    ? '1.5fr 150px 105px 90px 100px 115px 115px 115px'
    : (ocultaConteo ? '1.4fr 160px 110px 95px 105px 105px 95px 120px' : '1.4fr 160px 120px 95px 105px 105px 95px 105px 120px')
  const minMov = modoMov === 'fechas' ? '1020px' : (ocultaConteo ? '960px' : '1060px')

  // Resumen de "Conteos anteriores": todas las líneas de cada conteo + el
  // consumo $ y el sistema (saldo_inicial) del corte. Se carga una vez.
  useEffect(() => {
    if (!conteos.length) { setLineasToma({}); setConsumoToma({}); setConsumoDiaToma({}); return }
    let vivo = true
    ;(async () => {
      const ids = conteos.map(c => c.id)
      const { data: lins } = await supabase.schema('produccion').from('toma_inventario_linea')
        .select('toma_id, insumo_id, cantidad_sistema, cantidad_contada, consumo_dia, diferencia, motivo_descuadre').in('toma_id', ids)
      if (!vivo) return
      const byToma = {}; (lins || []).forEach(l => { (byToma[l.toma_id] = byToma[l.toma_id] || []).push(l) })
      setLineasToma(byToma)

      // Consumo del día de CADA conteo (en vivo), para mostrarlo también en los
      // conteos viejos (que no lo guardaron). Se pasa a unidad de compra (÷factor).
      const fechas = [...new Set(conteos.map(c => c.fecha))]
      const { data: cons } = await supabase.schema('produccion').from('consumo_insumo')
        .select('insumo_id, cantidad, fecha, piscina!inner(finca_id)')
        .eq('piscina.finca_id', finca.id).in('fecha', fechas)
      if (!vivo) return
      const porFecha = {}
      ;(cons || []).forEach(r => { if (!r.insumo_id) return; const k = r.fecha + '|' + r.insumo_id; porFecha[k] = (porFecha[k] || 0) + Number(r.cantidad || 0) })
      const cdm = {}
      conteos.forEach(c => {
        const mm = {}
        ;(byToma[c.id] || []).forEach(l => {
          const raw = porFecha[c.fecha + '|' + l.insumo_id]
          if (raw != null) { const fa = factores[l.insumo_id]?.factor || 1; mm[l.insumo_id] = raw / fa }
        })
        cdm[c.id] = mm
      })
      setConsumoDiaToma(cdm)
      if (!esJefe) return
      const res = await Promise.all(conteos.map((c, i) => {
        const h = i === 0 ? hoyISO() : sumarDias(conteos[i - 1].fecha, -1)
        return supabase.schema('produccion').rpc('fn_movimiento_insumo', { p_finca: finca.id, p_desde: c.fecha, p_hasta: h })
          .then(r => ({ id: c.id, rows: r.data || [] }))
      }))
      if (!vivo) return
      const cmap = {}
      res.forEach(({ id, rows }) => {
        const porProd = {}, sis = {}; let total = 0
        rows.forEach(r => { const d = Number(r.consumo_dolares) || 0; porProd[r.insumo_id] = d; total += d; sis[r.insumo_id] = Number(r.saldo_inicial) })
        cmap[id] = { porProd, total, sis }
      })
      setConsumoToma(cmap)
    })()
    return () => { vivo = false }
  }, [conteos, finca.id, esJefe, factores])

  // Sistema "en vivo" del corte = saldo del sistema la mañana del conteo
  // (saldo_inicial recalculado). Si no hay dato, usa lo guardado en la línea.
  // El Sistema del conteo se RECALCULA con los datos de hoy (cons.sis = saldo la
  // mañana del conteo, de fn_movimiento por corte). Así siempre refleja la
  // realidad actual, no un número viejo guardado con datos incompletos. Si no hay
  // recálculo disponible, usa lo guardado como respaldo.
  const sisCorte = (l, cons) => (cons && cons.sis[l.insumo_id] != null) ? cons.sis[l.insumo_id] : Number(l.cantidad_sistema)
  const difCorte = (l, cons) => Number(l.cantidad_contada) - sisCorte(l, cons)
  const unidadIns = id => { const u = (saldos.find(s => s.insumo_id === id)?.unidad) || ''; return (UNIDAD[u] || u || '').toLowerCase() }

  function abrirMotivoC(tomaId, insumoId, actual) {
    setMotivoEdit({ tomaId, insumoId })
    if (actual && MOTIVOS_DESCUADRE.includes(actual)) { setMotivoSel(actual); setMotivoVal('') }
    else if (actual) { setMotivoSel('Otro'); setMotivoVal(actual) }
    else { setMotivoSel(''); setMotivoVal('') }
  }
  async function guardarMotivoC(tomaId, insumoId) {
    const v = motivoSel === 'Otro' ? (motivoVal || '').trim() : motivoSel
    if (!v) { setMotivoEdit(null); return }
    const { error } = await supabase.schema('produccion').from('toma_inventario_linea')
      .update({ motivo_descuadre: v }).eq('toma_id', tomaId).eq('insumo_id', insumoId)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar el motivo. ' + error.message }); return }
    setLineasToma(m => ({ ...m, [tomaId]: (m[tomaId] || []).map(l => l.insumo_id === insumoId ? { ...l, motivo_descuadre: v } : l) }))
    setMotivoEdit(null); setMotivoSel(''); setMotivoVal('')
  }

  // Acta de un corte para imprimir (PDF), con Sistema en vivo.
  function imprimirCorte(c, idx, lins, cons) {
    const autor = nombresU[c.creado_por]
    const nFalt = lins.filter(l => !c.es_inicial && difCorte(l, cons) < -0.001).length
    const hastaTxt = idx === 0 ? 'hoy' : corta(sumarDias(conteos[idx - 1].fecha, -1))
    // Consumo del día: el congelado si existe; si no (conteos viejos), el calculado en vivo.
    const cdDe = l => l.consumo_dia != null ? Number(l.consumo_dia) : (consumoDiaToma[c.id]?.[l.insumo_id] ?? null)
    const hayConsDia = lins.some(l => { const v = cdDe(l); return v != null && v > 0.0001 })
    const filas = [...lins].sort((a, b) => nombreInsumo(a.insumo_id).localeCompare(nombreInsumo(b.insumo_id))).map(l => {
      const dif = difCorte(l, cons)
      const cd = cdDe(l)
      return {
        insumo: nombreInsumo(l.insumo_id),
        unidad: cap1(unidadIns(l.insumo_id)),
        sistema: c.es_inicial ? '—' : limpio(sisCorte(l, cons)),
        contado: limpio(l.cantidad_contada),
        // "Contó" = lo que había al inicio del día (incluye lo de ese día).
        consDia: cd != null && cd > 0.0001 ? `${limpio(cd)}` : '—',
        diferencia: c.es_inicial ? 'Inicial' : Math.abs(dif) < 0.001 ? 'Cuadró' : (dif < 0 ? 'Faltó ' : 'Sobró ') + limpio(Math.abs(dif)),
        motivo: l.motivo_descuadre || (c.es_inicial || Math.abs(dif) < 0.001 ? '' : 'sin motivo'),
        consumo: cons ? dinero(cons.porProd[l.insumo_id] || 0) : '',
      }
    })
    const total = esJefe && cons ? { insumo: 'Total del corte', unidad: '', sistema: '', contado: '', consDia: '', diferencia: '', motivo: '', consumo: dinero(cons.total) } : null
    const ok = reporteBodegaPDF({
      titulo: 'Acta de conteo de bodega', finca: String(finca.nombre).toUpperCase(), categoria: 'Insumos',
      subtitulo: `Conteo del ${corta(c.fecha)}${c.es_inicial ? ' (inventario inicial)' : ''}`,
      pie: '<b>Cómo se lee:</b> Sistema = lo que debía haber la mañana del conteo. Contó = lo que había al inicio del día. ' + (hayConsDia ? 'Consumo del día = lo aplicado ese día (congelado). ' : '') + 'Diferencia = Contó − Sistema. Consumo $ = lo consumido del corte.',
      meta: [
        { k: 'Período', v: idx === 0 ? `${corta(c.fecha)} – hoy` : `${corta(c.fecha)} – ${hastaTxt}` },
        { k: 'Contó', v: autor || '—' },
        { k: 'Faltantes', v: String(nFalt) },
        { k: 'Impreso', v: corta(hoyISO()) },
      ],
      columnas: [
        { titulo: 'Insumo', campo: 'insumo' },
        { titulo: 'Unidad', campo: 'unidad' },
        { titulo: 'Sistema', campo: 'sistema', der: true },
        { titulo: 'Contó', campo: 'contado', der: true },
        ...(hayConsDia ? [{ titulo: 'Consumo del día', campo: 'consDia', der: true }] : []),
        { titulo: 'Diferencia', campo: 'diferencia', der: true },
        { titulo: 'Motivo', campo: 'motivo' },
        ...(esJefe ? [{ titulo: 'Consumo $', campo: 'consumo', der: true }] : []),
      ],
      filas, total,
    })
    if (!ok) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.' })
  }

  // "Conteos anteriores": tarjetas colapsables por corte. Se muestra igual en
  // "Cuánto hay" y en "Qué se movió". Nacen todas cerradas; el usuario abre.
  function renderBajas() {
    return (
      <TarjetaBajas esJefe={esJefe} rows={bajas.map(b => {
        const s = saldos.find(x => x.insumo_id === b.insumo_id)
        const cant = Math.abs(Number(b.cantidad) || 0)
        const u = unidadIns(b.insumo_id)
        const fmt = n => Number(n || 0).toLocaleString('es-EC', { maximumFractionDigits: 2 })
        return { id: b.id, fecha: b.fecha, item: s?.insumo || '—', cantTxt: `${fmt(cant)}${u ? ' ' + u : ''}`,
          motivo: b.motivo || 'Otro', autor: b.autor, registrada: b.creado_en,
          perdido: cant * (Number(b.precio_unitario) || 0), quedaTxt: s ? `${fmt(s.saldo)}${u ? ' ' + u : ''}` : '—' }
      })} />
    )
  }
  function renderConteosAnteriores() {
    if (!conteos.length) return renderBajas()
    return (
      <>
            {renderBajas()}
            <div style={{ marginTop: '20px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 12px' }}>Conteos anteriores</h3>
              {conteos.map((c, idx) => {
                const grc = `1.9fr .9fr .9fr 1fr 1.3fr${esJefe ? ' .9fr' : ''}`
                const lins = [...(lineasToma[c.id] || [])].sort((a, b) => nombreInsumo(a.insumo_id).localeCompare(nombreInsumo(b.insumo_id)))
                const cons = consumoToma[c.id]
                const autor = nombresU[c.creado_por]
                const nFalt = lins.filter(l => !c.es_inicial && difCorte(l, cons) < -0.001).length
                const nSobr = lins.filter(l => !c.es_inicial && difCorte(l, cons) > 0.001).length
                const hastaTxt = idx === 0 ? 'hoy' : corta(sumarDias(conteos[idx - 1].fecha, -1))
                const alSis = ddmm(sumarDias(c.fecha, -1))
                const cabCel = { fontSize: '10px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'right' }
                const vacia = { color: '#c3d0db' }
                const link = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', color: AZUL, fontWeight: 500 }
                const abierto = c.id in cortesAbiertos ? cortesAbiertos[c.id] : false
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
                            {idx === 0 ? 'Corte actual' : c.es_inicial ? 'Inventario inicial' : 'Corte anterior'}</span>
                        </div>
                        <div style={{ color: GRIS, fontSize: '11.5px', marginTop: '3px', marginLeft: '20px' }}>
                          {autor ? `Contó ${autor} · ` : ''}{lins.length} {lins.length === 1 ? 'insumo' : 'insumos'} · {(nFalt + nSobr) === 0
                            ? <span style={{ color: VERDE }}>todo cuadró</span>
                            : <>
                                {nFalt > 0 && <b style={{ color: ROJO }}>{nFalt} {nFalt === 1 ? 'faltante' : 'faltantes'}</b>}
                                {nFalt > 0 && nSobr > 0 && ' · '}
                                {nSobr > 0 && <b style={{ color: AMBAR }}>{nSobr} {nSobr === 1 ? 'sobrante' : 'sobrantes'}</b>}
                              </>}
                        </div>
                      </button>
                      <div style={{ display: 'flex', gap: '7px' }}>
                        <button onClick={() => imprimirCorte(c, idx, lins, cons)}
                          style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid ' + AZUL, borderRadius: '8px', background: AZUL, color: '#fff', cursor: 'pointer' }}>Imprimir</button>
                        {esJefe && <>
                          <button onClick={() => editarConteo(c)} style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: 'white', color: NAVY, cursor: 'pointer' }}>Editar</button>
                          <button onClick={() => borrarConteo(c)} style={{ padding: '6px 12px', fontSize: '12px', fontFamily: 'inherit', border: '0.5px solid #e7cccb', borderRadius: '8px', background: 'white', color: ROJO, cursor: 'pointer' }}>Borrar</button>
                        </>}
                      </div>
                    </div>
                    {abierto && <>
                    {(() => {
                      const hayCons = (lineasToma[c.id] || []).some(l => (l.consumo_dia != null ? Number(l.consumo_dia) : (consumoDiaToma[c.id]?.[l.insumo_id] ?? 0)) > 0.0001)
                      if (!c.es_inicial && esJefe && hayCons) return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap', padding: '10px 16px', background: '#f8fbfd', borderTop: '0.5px solid ' + BORDE, fontSize: '12.5px' }}>
                          <span style={{ color: NAVY, fontWeight: 600 }}>Se contó {c.conto_despues ? 'después' : 'antes'} de alimentar.</span>
                          {corrOpen !== c.id
                            ? <button onClick={() => setCorrOpen(c.id)} style={{ border: 'none', background: 'none', color: AZUL, fontWeight: 600, fontFamily: 'inherit', fontSize: '12.5px', cursor: 'pointer', padding: 0 }}>Corregir</button>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 8px' }}>
                                <span style={{ color: GRIS, fontSize: '12px' }}>¿Se contó…?</span>
                                {[['Antes', false], ['Después', true]].map(([txt, val]) => {
                                  const on = !!c.conto_despues === val
                                  return <button key={txt} disabled={corrigiendoDec === c.id} onClick={() => { if (!on) corregirDecision(c, val); setCorrOpen(null) }}
                                    style={{ border: '0.5px solid ' + (on ? AZUL : '#bcd3ec'), background: on ? AZUL : '#fff', color: on ? '#fff' : AZUL, fontWeight: 600, fontFamily: 'inherit', fontSize: '12px', padding: '4px 11px', borderRadius: '7px', cursor: 'pointer' }}>{txt}</button>
                                })}
                                <button onClick={() => setCorrOpen(null)} style={{ border: 'none', background: 'none', color: GRIS, fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer' }}>✕</button>
                              </span>}
                          {corrigiendoDec === c.id && <span style={{ color: AZUL, fontSize: '11.5px' }}>Corrigiendo…</span>}
                        </div>
                      )
                      return null
                    })()}
                    <div style={{ display: 'grid', gridTemplateColumns: grc, gap: '10px', padding: '8px 16px', background: '#fbfcfe', borderTop: '0.5px solid ' + BORDE, borderBottom: '1px solid ' + BORDE }}>
                      {['Insumo', 'Sistema', 'Contó', 'Diferencia', 'Motivo / qué pasó', ...(esJefe ? ['Consumo $'] : [])].map((t, i) =>
                        <span key={i} style={{ ...cabCel, textAlign: i === 0 ? 'left' : 'right' }}>{t}</span>)}
                    </div>
                    {!lineasToma[c.id] ? (
                      <div style={{ padding: '12px 16px', fontSize: '12px', color: GRIS }}>Cargando...</div>
                    ) : lins.map((l, i) => {
                      const dif = difCorte(l, cons)
                      const falto = dif < -0.001, sobro = dif > 0.001
                      const uni = unidadIns(l.insumo_id)
                      const cdLine = l.consumo_dia != null ? Number(l.consumo_dia) : (consumoDiaToma[c.id]?.[l.insumo_id] ?? 0)
                      const skey = c.id + '|' + l.insumo_id
                      const editando = motivoEdit && motivoEdit.tomaId === c.id && motivoEdit.insumoId === l.insumo_id
                      return (
                        <Fragment key={i}>
                        <div style={{ display: 'grid', gridTemplateColumns: grc, gap: '10px', alignItems: 'baseline', padding: '9px 16px', borderBottom: sisDet === skey ? 'none' : '0.5px solid #f6f9fb', fontSize: '13px' }}>
                          <span>{nombreInsumo(l.insumo_id)}{uni && <span style={{ display: 'block', fontSize: '10px', color: '#9fb0bf' }}>{cap1(uni)}</span>}</span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {c.es_inicial ? <span style={vacia}>—</span> : <>
                              {cdLine > 0.0001
                                ? <button onClick={() => setSisDet(x => x === skey ? null : skey)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, fontVariantNumeric: 'tabular-nums' }}>{limpio(sisCorte(l, cons))} <span style={{ color: AZUL, fontSize: '9px' }}>{sisDet === skey ? '▾' : '▸'}</span></button>
                                : limpio(sisCorte(l, cons))}
                              <span style={{ display: 'block', fontSize: '10px', color: '#9fb0bf' }}>al {alSis}</span>
                            </>}
                          </span>
                          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {limpio(l.cantidad_contada)}
                          </span>
                          <span style={{ textAlign: 'right', color: c.es_inicial ? VERDE : falto ? ROJO : sobro ? AMBAR : VERDE }}>
                            {c.es_inicial ? 'Inicial' : falto ? 'Faltó ' + limpio(Math.abs(dif)) : sobro ? 'Sobró ' + limpio(dif) : 'Cuadró'}
                            {esJefe && !c.es_inicial && (falto || sobro) && (
                              <span style={{ display: 'block', fontSize: '10px', fontWeight: 400, color: falto ? ROJO : AMBAR }}>
                                {falto ? '−' : '+'}{dinero(Math.abs(dif) * precioFifoDe(l.insumo_id))}
                              </span>
                            )}
                          </span>
                          <span style={{ textAlign: 'right', fontSize: '11.5px' }}>
                            {c.es_inicial ? <span style={vacia}>—</span>
                              : editando
                                ? <span style={{ display: 'inline-flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                    <select autoFocus value={motivoSel} onChange={e => setMotivoSel(e.target.value)} style={{ ...entrada, padding: '3px 7px', fontSize: '12px' }}>
                                      <option value="">Motivo...</option>
                                      {MOTIVOS_DESCUADRE.map(mo => <option key={mo} value={mo}>{mo}</option>)}
                                    </select>
                                    {motivoSel === 'Otro' && (
                                      <input value={motivoVal} onChange={e => setMotivoVal(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') guardarMotivoC(c.id, l.insumo_id); if (e.key === 'Escape') setMotivoEdit(null) }}
                                        placeholder="Especifica" style={{ ...entrada, padding: '3px 7px', fontSize: '12px', width: '100px' }} />
                                    )}
                                    <button onClick={() => guardarMotivoC(c.id, l.insumo_id)} style={{ ...link, fontSize: '11.5px' }}>Guardar</button>
                                  </span>
                                : l.motivo_descuadre ? <span style={{ color: AMBAR }}>{l.motivo_descuadre}{esJefe && (falto || sobro) && <button onClick={() => abrirMotivoC(c.id, l.insumo_id, l.motivo_descuadre)} style={{ ...link, fontSize: '10.5px', marginLeft: '6px' }}>cambiar</button>}</span>
                                : (falto || sobro)
                                  ? (esJefe
                                    ? <button onClick={() => abrirMotivoC(c.id, l.insumo_id, null)} style={{ ...link, fontSize: '11.5px' }}>Poner motivo ›</button>
                                    : <span style={vacia}>—</span>)
                                  : <span style={vacia}>—</span>}
                          </span>
                          {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{cons ? dinero(cons.porProd[l.insumo_id] || 0) : '—'}</span>}
                        </div>
                        {sisDet === skey && (() => {
                          const otra = c.conto_despues ? 'antes' : 'después'
                          const uCap = cap1(uni)
                          const altDif = dif + (c.conto_despues ? -cdLine : cdLine)
                          const hayDesc = Math.abs(dif) > 0.001
                          const cuadra = Math.abs(altDif) < 0.001
                          const baja = Math.abs(altDif) < Math.abs(dif) - 0.001
                          const amber = { fontSize: '12px', color: '#8a6a1e', background: '#FDF3DF', border: '0.5px solid #eedcb0', borderRadius: '8px', padding: '8px 12px', marginTop: '8px', maxWidth: '640px', lineHeight: 1.6 }
                          return (
                            <div style={{ padding: '2px 16px 14px 44px', background: '#f8fbfd', borderBottom: '0.5px solid #f6f9fb' }}>
                              <div style={{ fontSize: '12px', color: GRIS, lineHeight: 1.8, maxWidth: '640px' }}>
                                El sistema esperaba <b style={{ color: NAVY }}>{limpio(sisCorte(l, cons))} {uCap}</b> y contaste <b style={{ color: NAVY }}>{limpio(Number(l.cantidad_contada))}</b>. Ese día se consumió <b style={{ color: NAVY }}>{limpio(cdLine)} {uCap}</b> {c.conto_despues ? 'antes' : 'después'} de contar{l.consumo_dia == null ? ' (estimado)' : ''}.
                              </div>
                              {hayDesc && (cuadra
                                ? <div style={amber}>Si en realidad se contó <b>{otra}</b> de alimentar, este conteo <b style={{ color: VERDE }}>cuadraría</b>. Toca <b>Corregir</b> (arriba) para arreglarlo.</div>
                                : baja
                                  ? <div style={amber}>Si se contó <b>{otra}</b> de alimentar, el descuadre <b>baja de {limpio(Math.abs(dif))} a {limpio(Math.abs(altDif))} {uCap}</b>. Revisa con <b>Corregir</b> (arriba).</div>
                                  : <div style={{ fontSize: '12px', color: GRIS, background: '#f1f5f9', borderRadius: '8px', padding: '8px 12px', marginTop: '8px', maxWidth: '640px', lineHeight: 1.6 }}>Este descuadre <b style={{ color: NAVY }}>no viene de la hora del conteo</b> (el consumo del día ya está contado). Revisa el consumo o el registro.</div>)}
                            </div>
                          )
                        })()}
                        </Fragment>
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
      </>
    )
  }

  const [contando, setContando] = useState(false)
  const [editToma, setEditToma] = useState(null)   // conteo que se está editando
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})
  const [noContados, setNoContados] = useState('mantiene')  // 'mantiene' | 'cero' — qué pasa con lo que no se cuenta
  const [sobrante, setSobrante] = useState({})       // insumoId -> sobrante en unidad de aplicación
  const [sobranteOn, setSobranteOn] = useState({})   // insumoId -> mostrar casilla de sobrante
  const [contoDespues, setContoDespues] = useState(false) // conteo hecho DESPUÉS de aplicar ese día
  const [consumoDia, setConsumoDia] = useState({})   // insumoId -> consumo del día (editable), en unidad de compra
  const [consDiaRef, setConsDiaRef] = useState({})   // insumoId -> consumo del día REGISTRADO HOY (referencia), unidad de compra
  const [saldoFecha, setSaldoFecha] = useState({})   // insumoId -> saldo del sistema A LA FECHA del conteo (conteo nuevo con fecha pasada)
  const [sistemaEdit, setSistemaEdit] = useState({}) // insumoId -> cantidad_sistema GUARDADA (al editar un conteo)
  const [motivoDesc, setMotivoDesc] = useState({})   // insumoId -> categoría del descuadre
  const [motivoOtro, setMotivoOtro] = useState({})   // insumoId -> texto libre si es "Otro"
  const [detToma, setDetToma] = useState(null)       // conteo expandido (ver descuadres)
  const [detLineas, setDetLineas] = useState({})     // toma_id -> líneas con descuadre
  const [guardando, setGuardando] = useState(false)

  // Agregar insumos que faltan, varios a la vez, sin salir del conteo.
  const [nuevos, setNuevos] = useState([])
  const [guardandoNuevos, setGuardandoNuevos] = useState(false)

  // Correccion en linea del jefe: que insumo se esta editando, el saldo
  // nuevo y el motivo. Todo dentro de la fila, sin ventanas.
  const [editando, setEditando] = useState(null)
  const [nuevoSaldo, setNuevoSaldo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [fechaAj, setFechaAj] = useState('')
  const [guardandoAj, setGuardandoAj] = useState(false)
  const [corrUnidad, setCorrUnidad] = useState('compra')  // en qué unidad se escribe el saldo al corregir
  const [corrAjustes, setCorrAjustes] = useState([])       // correcciones (ajustes manuales) del insumo en edición

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: s, error: eS }, { data: m }, { data: p }, { data: t }, { data: ins }, { data: vf }, { data: ovFactor }, { data: dpz }, { data: plzAct }, { data: lt }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_saldo_insumo',
          { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_movimiento_insumo',
          { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
        supabase.schema('produccion').from('precio_insumo')
          .select('insumo_id, finca_id, precio_unitario, plazo, vigente_desde')
          .is('vigente_hasta', null)
          .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
        supabase.schema('produccion').from('toma_inventario')
          .select('id, fecha, observacion, es_inicial, creado_por, conto_despues')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
        supabase.schema('produccion').from('insumo').select('id, factor, unidad').eq('activo', true),
        supabase.schema('produccion').rpc('fn_valor_bodega_fifo',
          { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').from('insumo_finca')
          .select('insumo_id, factor, stock_minimo, unidad, contenido, unidad_contenido').eq('finca_id', finca.id),
        supabase.schema('produccion').rpc('fn_saldo_insumo_plazo',
          { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').from('plazo_insumo')
          .select('insumo_id, finca_id, plazo').is('vigente_hasta', null)
          .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
        // Lotes por precio (FIFO): solo se piden si es jefe/contadora.
        esJefe ? supabase.schema('produccion').rpc('fn_lotes_insumo', { p_finca: finca.id, p_hasta: alDia }) : Promise.resolve({ data: [] }),
      ])
      if (eS) throw eS

      // El factor convierte el precio (por unidad de consumo) a precio
      // por unidad de compra. Se resuelve por finca (override o catálogo).
      const factor = {}
      ;(ins || []).forEach(x => { factor[x.id] = Number(x.factor) || 1 })
      ;(ovFactor || []).forEach(x => { factor[x.insumo_id] = Number(x.factor) || 1 })

      // Factor + unidad de aplicación por insumo (para el "sobrante" del conteo).
      const facMap = {}
      ;(ins || []).forEach(x => { facMap[x.id] = { factor: Number(x.factor) || 1, uApp: x.unidad } })
      ;(ovFactor || []).forEach(x => { facMap[x.insumo_id] = { factor: Number(x.factor) || 1, uApp: x.unidad || facMap[x.insumo_id]?.uApp,
        contenido: Number(x.contenido) || null, uCont: x.unidad_contenido || null } })
      setFactores(facMap)

      // Mínimo por insumo (en unidad de aplicación). Guardamos el min en
      // unidad de aplicación, el factor y la unidad para comparar y mostrar.
      const minMap = {}
      ;(ovFactor || []).forEach(x => {
        if (x.stock_minimo != null) minMap[x.insumo_id] = { min: Number(x.stock_minimo), factor: Number(x.factor) || 1, unidad: x.unidad }
      })
      setMinimos(minMap)

      // Plazo que rige por insumo (el de la finca gana al general). Es el
      // mismo que muestra el catálogo, para que el precio coincida.
      const plazoRige = {}
      ;(plzAct || []).forEach(x => {
        if (plazoRige[x.insumo_id] != null && !x.finca_id) return
        plazoRige[x.insumo_id] = Number(x.plazo)
      })
      // El precio de la finca le gana al general, Y se toma el del plazo que
      // rige (no cualquiera). Si no hay precio en ese plazo, se usa el que haya.
      const pr = {}, prRespaldo = {}, pinfo = {}, pinfoResp = {}
      ;(p || []).forEach(x => {
        const val = Number(x.precio_unitario) * (factor[x.insumo_id] || 1)
        const rige = plazoRige[x.insumo_id] ?? 0
        const esFinca = !!x.finca_id
        // Precio del plazo que rige (preferir finca sobre general). Guardamos
        // también el plazo y "desde cuándo rige" para mostrarlo.
        if (Number(x.plazo) === rige && (pr[x.insumo_id] == null || esFinca)) {
          pr[x.insumo_id] = val; pinfo[x.insumo_id] = { plazo: rige, desde: x.vigente_desde }
        }
        // Respaldo: cualquier precio (preferir finca), por si el plazo que
        // rige no tiene precio cargado.
        if (prRespaldo[x.insumo_id] == null || esFinca) {
          prRespaldo[x.insumo_id] = val; pinfoResp[x.insumo_id] = { plazo: Number(x.plazo), desde: x.vigente_desde }
        }
      })
      ;(p || []).forEach(x => {
        if (pr[x.insumo_id] == null && prRespaldo[x.insumo_id] != null) {
          pr[x.insumo_id] = prRespaldo[x.insumo_id]; pinfo[x.insumo_id] = pinfoResp[x.insumo_id]
        }
      })
      setPrecioInfo(pinfo)

      const vfMap = {}
      ;(vf || []).forEach(x => { vfMap[x.insumo_id] = Number(x.valor) })
      setValorFifo(vfMap)

      const ltm = {}
      ;(lt || []).forEach(x => { (ltm[x.insumo_id] = ltm[x.insumo_id] || []).push({ fecha: x.fecha, cantidad: Number(x.cantidad), costo: x.costo_unitario == null ? null : Number(x.costo_unitario), valor: Number(x.valor), plazo: x.plazo == null ? null : Number(x.plazo) }) })
      setLotes(ltm)

      const dgm = {}
      ;(dpz || []).forEach(x => { (dgm[x.insumo_id] = dgm[x.insumo_id] || []).push({ plazo: Number(x.plazo), cantidad: Number(x.cantidad), valor: Number(x.valor) }) })
      setDesglose(dgm)

      // movs y saldos se cargan YA (no dependen de la consulta de tomas/usuarios
      // de abajo): si esa falla, la tabla "Qué se movió" igual se muestra.
      // iniRango se limpia aquí y se llena abajo (la apertura se dibuja con el
      // saldo_inicial mientras tanto, no con un valor viejo).
      setSaldos(s || []); setPrecios(pr); setConteos(t || []); setMovs(m || []); setIniRango({})

      // Autoría del conteo por insumo (quién y cuándo), para mostrarlo en la
      // columna Conteo / Inicial de "Qué se movió". Va en su propio try: si falla
      // (ej. vw_usuario), la tabla ya se mostró arriba y solo se pierde la autoría.
      try {
      const [{ data: tomasP }, { data: usuarios }] = await Promise.all([
        supabase.schema('produccion').from('toma_inventario')
          .select('fecha, creado_por, es_inicial, toma_inventario_linea(insumo_id, consumo_dia, cantidad_contada, motivo_descuadre, diferencia)')
          .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
          .order('fecha', { ascending: true }),
        supabase.schema('produccion').from('vw_usuario').select('id, nombre'),
      ])
      const nombreU = {}; (usuarios || []).forEach(u => { nombreU[u.id] = u.nombre })
      const cq = {}, dm = {}, iniR = {}
      ;(tomasP || []).forEach(tt => (tt.toma_inventario_linea || []).forEach(l => {
        cq[l.insumo_id] = { fecha: tt.fecha, autor: nombreU[tt.creado_por] || null, esInicial: !!tt.es_inicial,
          consDia: l.consumo_dia != null ? Number(l.consumo_dia) : null, habia: Number(l.cantidad_contada) }
        if (l.motivo_descuadre && Math.abs(Number(l.diferencia) || 0) > 0.001) dm[l.insumo_id] = l.motivo_descuadre
        // El inventario inicial del rango (el más antiguo; tomasP viene ascendente) = la apertura.
        if (tt.es_inicial && !iniR[l.insumo_id]) iniR[l.insumo_id] = { fecha: tt.fecha, valor: Number(l.cantidad_contada) }
      }))
      setConteoQuien(cq); setDescMotivo(dm); setNombresU(nombreU); setIniRango(iniR)

      // Bajas (robo/merma/daño): ajustes NEGATIVOS que guardaron un precio FIFO.
      const { data: bj } = await supabase.schema('produccion').from('ajuste_insumo')
        .select('id, fecha, insumo_id, cantidad, motivo, precio_unitario, creado_por, creado_en')
        .eq('finca_id', finca.id).lt('cantidad', 0).not('precio_unitario', 'is', null)
        .order('fecha', { ascending: false }).limit(100)
      setBajas((bj || []).map(b => ({ ...b, autor: nombreU[b.creado_por] || null })))
      } catch { /* la autoría es opcional: si falla, la tabla igual se muestra */ }
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, alDia, desde, hasta, esJefe])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = conteos.length === 0

  // Consumo (aplicación) registrado EL DÍA del conteo, por insumo, pasado a la
  // unidad de COMPRA (÷ factor) para poder reconstruir el "había".
  useEffect(() => {
    if (!contando || primeraVez) { setConsumoDia({}); setConsDiaRef({}); return }
    let vivo = true
    ;(async () => {
      const { data } = await supabase.schema('produccion').from('consumo_insumo')
        .select('insumo_id, cantidad, piscina!inner(finca_id)')
        .eq('piscina.finca_id', finca.id).eq('fecha', fecha)
      if (!vivo) return
      const m = {}
      ;(data || []).forEach(r => { if (r.insumo_id) m[r.insumo_id] = (m[r.insumo_id] || 0) + Number(r.cantidad || 0) })
      const sac = {}
      Object.entries(m).forEach(([id, v]) => { const fa = factores[id]?.factor || 1; sac[id] = String(Math.round((v / fa) * 1e6) / 1e6) })
      setConsDiaRef(sac)   // referencia: lo registrado hasta ahora
      // Conteo nuevo: el consumo editable arranca del registrado.
      // Al EDITAR: se usa el CONGELADO donde exista (ya cargado en editarConteo);
      // donde NO haya congelado (conteos viejos con consumo_dia NULL) cae al
      // valor en vivo, para que el conteo viejo se vea igual que siempre.
      if (!editToma) setConsumoDia(sac)
      else setConsumoDia(prev => ({ ...sac, ...prev }))
    })()
    return () => { vivo = false }
  }, [contando, fecha, finca.id, primeraVez, factores, editToma])

  // Saldo del sistema A LA FECHA del conteo (para conteos con fecha pasada: el
  // sistema debe mostrar lo de ESE día, no el de hoy). Al editar se usa el guardado.
  useEffect(() => {
    // Se recalcula también al EDITAR (para que el Sistema sea el real de hoy, no
    // el viejo guardado). Solo se omite el inventario inicial (no tiene Sistema).
    if (!contando || primeraVez || (editToma && editToma.es_inicial)) { setSaldoFecha({}); return }
    let vivo = true
    ;(async () => {
      // Al EDITAR, el conteo ya está guardado en `fecha` y ancla el saldo a lo
      // contado, así que se pide la VÍSPERA (el "había" antes del conteo). En un
      // conteo nuevo aún no hay toma en `fecha`, así que se pide a la fecha.
      const hasta = editToma ? sumarDias(fecha, -1) : fecha
      const { data } = await supabase.schema('produccion').rpc('fn_saldo_insumo', { p_finca: finca.id, p_hasta: hasta })
      if (!vivo) return
      const m = {}; (data || []).forEach(r => { m[r.insumo_id] = Number(r.saldo) })
      setSaldoFecha(m)
    })()
    return () => { vivo = false }
  }, [contando, fecha, finca.id, primeraVez, editToma])
  const ultimo = conteos[0]

  // El valor se calcula a PRECIO ACTUAL: saldo × precio vigente. Así, al
  // cambiar el precio (con su "rige desde"), el valor de la bodega se
  // actualiza enseguida y cuadra con las columnas Saldo y Precio.
  // Valor de la bodega = costo REAL FIFO (lo que se pagó por cada lote), no
  // precio de catálogo. Así cuadra con el desglose "cuánto queda a cada precio".
  const valorBodega = useMemo(
    () => saldos.reduce((t, s) => t + Number(valorFifo[s.insumo_id] || 0), 0),
    [saldos, valorFifo])
  // Precio FIFO real por insumo (valor del saldo ÷ saldo) para costear faltantes.
  const precioFifoDe = id => { const sld = Number(saldos.find(s => s.insumo_id === id)?.saldo); return sld > 0.0001 ? Number(valorFifo[id] || 0) / sld : (precios[id] || 0) }
  const conSaldo = saldos.filter(s => Number(s.saldo) > 0).length
  const negativos = saldos.filter(s => Number(s.saldo) < 0).length
  // Sin inventario: saldo ~0 y sin lotes. Se ocultan por defecto en la bodega.
  const esSinInvFila = f => Math.abs(Number(f.saldo)) < 0.001 && !((lotes[f.insumo_id] || []).length)
  // En "Qué se movió": sin inventario = quedó en 0 y sin lotes, y tampoco se movió nada en el rango.
  const esSinInvMov = m => Math.abs(Number(m.saldo_final)) < 0.001 && !((lotes[m.insumo_id] || []).length) &&
    !Number(m.ingresos) && !Number(m.consumo) && !Number(m.devuelto) && !Number(m.ajustes) && (m.conteo === null || m.conteo === undefined)
  // Insumos cuya valorización sale $0: tienen un lote SIN costo (sin precio que
  // cubra la fecha del lote — p. ej. el inventario inicial sin precio cargado).
  // Si aún no cargaron lotes (no jefe), caemos al chequeo de precio vigente.
  const sinPrecioList = saldos.filter(s => {
    const lts = lotes[s.insumo_id] || []
    if (lts.length) return lts.some(L => L.costo == null && Number(L.cantidad) > 0.0001)
    return Math.abs(Number(s.saldo)) > 0.0001 && !precios[s.insumo_id]
  })
  const sinPrecio = sinPrecioList.length
  const nombreInsumo = id => saldos.find(s => s.insumo_id === id)?.insumo || ''

  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.insumo_id]
    const hayMain = txt !== undefined && txt !== ''
    const fac = factores[s.insumo_id]?.factor || 1
    const sob = sobrante[s.insumo_id]
    const haySob = sob !== undefined && sob !== '' && Number(sob) !== 0
    // El conteo se guarda en unidad de compra (presentación). El sobrante
    // viene en unidad de aplicación → se divide por el factor para sumarlo.
    const c = (hayMain || haySob) ? (hayMain ? Number(txt) : 0) + (haySob ? Number(String(sob).replace(',', '.')) / fac : 0) : null
    // Modelo "había": el conteo guarda lo que había al INICIO del día (en unidad
    // de compra). s.saldo ya tiene restado el consumo de hoy, así que había =
    // s.saldo + lo de hoy. Si contó DESPUÉS, escribió lo que quedó → se le suma
    // lo de hoy. "El sistema dice" muestra el había (antes) o lo de ahora (después).
    // El sistema es el saldo recalculado: en conteo nuevo = saldo a la fecha (fin
    // de día); al EDITAR = saldo de la víspera (= el "había" antes del conteo).
    const sis = (saldoFecha[s.insumo_id] != null) ? Number(saldoFecha[s.insumo_id]) : Number(s.saldo)
    const cons = numDec(String(consumoDia[s.insumo_id] ?? ''))
    const consRef = numDec(String(consDiaRef[s.insumo_id] ?? ''))
    // Al editar, sis YA es la víspera (el había); no se le suma el consumo.
    const habiaSistema = editToma ? sis : (cons > 0.0001 ? sis + cons : sis)
    const esperado = (contoDespues && cons > 0.0001) ? sis : habiaSistema
    const habiaContado = c === null ? null : ((contoDespues && cons > 0.0001) ? c + cons : c)
    const saldoFinal = habiaContado === null ? null : habiaContado - (cons > 0.0001 ? cons : 0)
    return { ...s, precio: precios[s.insumo_id] || 0,
             contado: c, cons, consRef, esperado, habiaSistema, habiaContado, saldoFinal,
             // Redondeada a 2 decimales para que una diferencia minúscula por la
             // conversión cuente como "cuadra", no "sobran 0".
             diferencia: habiaContado === null ? null : Math.round((habiaContado - habiaSistema) * 100) / 100 }
  }), [saldos, precios, contado, sobrante, factores, consumoDia, consDiaRef, contoDespues, saldoFecha, editToma])

  const descuadres = filas.filter(f => f.diferencia !== null && Math.abs(f.diferencia) > 0.0001)
  const llenadas = filas.filter(f => f.contado !== null).length
  // Editar un inventario inicial: se muestra como la carga inicial (solo las
  // cantidades, sin Sistema ni Diferencia), porque el inicial ES el punto de partida.
  const editaInicial = !!(editToma && editToma.es_inicial)
  const modoIni = primeraVez || editaInicial

  // Reporte de bodega: junta "Cuánto hay" y "Qué se movió" en un solo documento.
  // Cruza saldos (al día) con movimientos (del rango), lotes, precio·vigencia y
  // el conteo con su motivo. Un mismo botón para Excel y PDF.
  function construirReporte() {
    const nd = v => Number(v) || 0
    const mas = v => { const x = nd(v); return x > 0.001 ? '+' + limpio(x) : '—' }
    const menos = v => { const x = nd(v); return x > 0.001 ? '−' + limpio(x) : '—' }
    const conSigno = v => { const x = nd(v); if (Math.abs(x) < 0.001) return '0'; return (x > 0 ? '+' : '−') + limpio(Math.abs(x)) }
    const movById = {}; (movs || []).forEach(m => { movById[m.insumo_id] = m })
    const sById = {}; (saldos || []).forEach(s => { sById[s.insumo_id] = s })
    const ids = [...new Set([...(saldos || []).map(s => s.insumo_id), ...(movs || []).map(m => m.insumo_id)])]
    const tieneMov = m => m && (nd(m.ingresos) || nd(m.consumo) || nd(m.devuelto) || nd(m.ajustes) || m.conteo != null)

    let totIni = 0, totIng = 0, totDev = 0, totCon = 0, totConUsd = 0, totSaldo = 0, totValor = 0, totDif = 0, totDesc = 0, nDesc = 0
    const filasRep = []
    ids.forEach(id => {
      const s = sById[id]; const m = movById[id]
      const nombre = (s && s.insumo) || (m && m.insumo) || ''
      if (!coincide(nombre)) return
      const saldoAlDia = s ? Number(s.saldo) : 0
      const sinInv = Math.abs(saldoAlDia) < 0.001 && !((lotes[id] || []).length)
      if (sinInv && !tieneMov(m) && !verSinInv) return

      const fac = factores[id]
      const uPres = cap1(UNIDAD[(s && s.unidad) || (m && m.unidad)] || (s && s.unidad) || (m && m.unidad) || '')
      const uApp = fac && fac.uApp ? cap1(UNIDAD[fac.uApp] || fac.uApp) : ''
      const factorN = fac?.factor || 1
      const convR = fac && fac.uApp && !esUnidadGenerica(fac.uApp) && uApp !== uPres
      const precio = precios[id] || 0
      const pdesde = precioInfo[id]?.desde
      const valor = Number(valorFifo[id] || 0)
      // Si el período arranca en el inventario inicial (o en un conteo), ese
      // valor contado ES el Saldo Ini. — igual que en pantalla.
      const iniEsConteo = anclaInicio(m)
      const apertura = aperturaInicial(m)
      const conteoRaw = m && m.conteo != null ? Number(m.conteo) : null
      const conteo = iniEsConteo ? null : conteoRaw
      const iniVal = apertura != null ? apertura : (iniEsConteo ? conteoRaw : nd(m?.saldo_inicial))
      const teorico = m ? Number(m.saldo_final) : saldoAlDia
      const dif = conteo != null ? conteo - teorico : null
      // Faltante/sobrante al precio FIFO real del saldo (no catálogo).
      const precioFifo = saldoAlDia > 0.0001 ? valor / saldoAlDia : precio
      const descUsd = (dif != null && Math.abs(dif) > 0.001) ? dif * precioFifo : null
      const cq = conteoQuien[id]
      // Lotes en una sola línea, solo si hay más de uno (agrupa el caso "todos al mismo precio").
      const lts = lotes[id] || []
      let lotesLinea = ''
      if (lts.length > 1) {
        const u = uPres.toLowerCase()
        const costos = [...new Set(lts.map(L => L.costo == null ? 's/p' : Number(L.costo).toFixed(6)))]
        if (costos.length === 1) {
          const pr = lts[0].costo == null ? 'sin precio' : dineroExacto(lts[0].costo)
          lotesLinea = `Lotes: ${lts.map(L => limpio(L.cantidad)).join(' · ')} ${u} (todos a ${pr})`
        } else {
          lotesLinea = 'Lotes: ' + lts.map(L => `${limpio(L.cantidad)} a ${L.costo == null ? 's/p' : dineroExacto(L.costo)}`).join(' · ')
        }
      }
      const contadoInfo = (!iniEsConteo && cq?.fecha) ? corta(cq.fecha) + (cq.autor ? ' · ' + cq.autor : '') + (cq.esInicial ? ' (inicial)' : '') : ''
      // Consumo del día congelado del conteo: valor + desglose "contó F + C = H había".
      const cd = cq && cq.consDia != null && cq.consDia > 0.0001 ? cq.consDia : null
      const uLow = uPres.toLowerCase()
      const consDia = cd != null ? `${limpio(cd)} ${uLow} · congelado` : ''
      const consDiaCalc = (cd != null && cq.habia != null) ? `contó ${limpio(cq.habia - cd)} + ${limpio(cd)} = ${limpio(cq.habia)} había` : ''

      totIni += iniVal; totIng += nd(m?.ingresos); totDev += nd(m?.devuelto)
      totCon += nd(m?.consumo); totConUsd += nd(m?.consumo_dolares); totSaldo += saldoAlDia; totValor += valor
      if (dif != null) { totDif += dif; if (descUsd) { totDesc += descUsd; nDesc++ } }

      filasRep.push({
        nombre, lotesLinea,
        viaTop: convR ? `${uPres} → ${uApp}` : uPres, viaSub: convR ? `1 ${uPres} = ${limpio(factorN)} ${uApp}` : '',
        inicial: limpio(iniVal || 0), ingresos: mas(m?.ingresos), devuelto: menos(m?.devuelto),
        consumo: menos(m?.consumo), consumoUsd: dinero(nd(m?.consumo_dolares)),
        saldoHoy: `${limpio(saldoAlDia)} ${uPres.toLowerCase()}`,
        saldoEquiv: convR ? `= ${limpio(saldoAlDia * factorN)} ${uApp.toLowerCase()}` : '',
        precio: precio ? dineroExacto(precio) : '—', precioDesde: pdesde ? corta(pdesde) : '',
        valor: dinero(valor),
        contado: conteo != null ? limpio(conteo) : '', contadoInfo,
        consDia, consDiaCalc,
        dif: dif != null ? conSigno(dif) : '', descuadre: descUsd ? dinero(descUsd) : (dif === 0 ? '—' : ''),
        motivo: descMotivo[id] || '',
      })
    })
    filasRep.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    const hayConteo = filasRep.some(f => f.contado !== '')
    const hayConsDiaRep = filasRep.some(f => f.consDia !== '')

    const columnas = [
      { titulo: 'Insumo', campo: 'nombre', sub: 'lotesLinea' },
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
        ...(hayConsDiaRep ? [{ titulo: 'Consumo del día', der: true, campo: 'consDia', sub: 'consDiaCalc' }] : []),
        { titulo: 'Dif.', der: true, campo: 'dif' },
        { titulo: 'Descuadre $', der: true, campo: 'descuadre' },
        { titulo: 'Motivo', campo: 'motivo' },
      ] : []),
    ]
    const total = {
      nombre: 'Total', lotesLinea: '', viaTop: '', viaSub: '', inicial: limpio(totIni), ingresos: '+' + limpio(totIng),
      devuelto: totDev ? '−' + limpio(totDev) : '—', consumo: totCon ? '−' + limpio(totCon) : '—',
      saldoHoy: '', saldoEquiv: '', consumoUsd: dinero(totConUsd), precio: '', precioDesde: '',
      valor: dinero(totValor), contado: '', contadoInfo: '', consDia: '', consDiaCalc: '',
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
      titulo: 'Reporte de Bodega — Insumos', finca: finca.nombre, categoria: 'Insumos',
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

  // ¿Bajo mínimo? El saldo está en unidad de compra; el mínimo en unidad de
  // aplicación. Convierto el saldo a aplicación (saldo × factor) y comparo.
  const bajoMin = f => {
    const m = minimos[f.insumo_id]; if (!m) return null
    const saldoApp = Number(f.saldo) * (m.factor || 1)
    return saldoApp < m.min ? { saldoApp, ...m } : null
  }
  const porReponer = filas.map(f => ({ f, a: bajoMin(f) })).filter(x => x.a)

  // Cargar inventario inicial de UN insumo (nuevo o sin inventario).
  // Lo registra como CONTEO INICIAL (toma es_inicial), no como ajuste: así el
  // arranque aparece en "Saldo Ini." y "Ajustes" queda solo para correcciones.
  // Reutiliza el conteo inicial del día si ya existe.
  async function guardarInicial() {
    if (!iniForm) return
    const cant = Number(String(iniForm.cantidad).replace(',', '.'))
    if (!isFinite(cant) || cant <= 0) { setAviso({ tipo: 'error', texto: 'Escribe una cantidad válida.' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iniForm.fecha)) { setAviso({ tipo: 'error', texto: 'Fecha inválida.' }); return }
    try {
      const { data: ex } = await supabase.schema('produccion').from('toma_inventario')
        .select('id').eq('finca_id', finca.id).eq('fecha', iniForm.fecha).eq('es_inicial', true).maybeSingle()
      let tomaId = ex?.id
      if (!tomaId) {
        const { data: toma, error } = await supabase.schema('produccion').from('toma_inventario')
          .insert({ finca_id: finca.id, fecha: iniForm.fecha, es_inicial: true, observacion: 'Inventario inicial' })
          .select('id').single()
        if (error) throw error
        tomaId = toma.id
      }
      await supabase.schema('produccion').from('toma_inventario_linea')
        .delete().eq('toma_id', tomaId).eq('insumo_id', iniForm.insumoId)
      const { error: e2 } = await supabase.schema('produccion').from('toma_inventario_linea')
        .insert({ toma_id: tomaId, insumo_id: iniForm.insumoId, cantidad_contada: cant,
                  cantidad_sistema: 0, diferencia: cant, motivo_descuadre: null })
      if (e2) throw e2
      setIniForm(null); setAviso({ tipo: 'ok', texto: 'Inventario inicial cargado como conteo inicial.' }); await cargar()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') }) }
  }

  // Recostear un insumo: sus lotes y su consumo pasan al precio que rige
  // (los lotes conservan su fecha de compra; cambia precio y plazo). Manual.
  async function recostear(f) {
    setRecosteando(true)
    const { error } = await supabase.schema('produccion')
      .rpc('fn_recostear_producto_finca_insumo', { p_finca: finca.id, p_insumo: f.insumo_id })
    setRecosteando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo recostear. ' + error.message }); return }
    setRecosForm(null)
    setAviso({ tipo: 'ok', texto: `${f.insumo} recosteado al precio que rige.` })
    await cargar()
  }

  // Detalle por lote en "Qué se movió": entró / consumió / queda por lote,
  // respetando FIFO (el viejo se gasta primero). Se carga al abrir la flechita.
  async function abrirMov(insumoId) {
    if (movDet === insumoId) { setMovDet(null); return }
    setMovDet(insumoId)
    if (!lotesMov[insumoId]) {
      const { data, error } = await supabase.schema('produccion')
        .rpc('fn_lotes_movimiento_insumo', { p_finca: finca.id, p_insumo: insumoId, p_hasta: hasta })
      setLotesMov(m => ({ ...m, [insumoId]: error ? [] : (data || []) }))
    }
  }

  // Abrir el formulario de corrección de precio de un lote concreto.
  async function iniciarCorreccion(insumoId, lote) {
    // Un conteo no tiene plazo de compra: se valora con el precio del plazo que
    // REGÍA EN SU FECHA (no hoy). Lo buscamos en plazo_insumo para precargar el
    // plazo correcto; si usáramos lote.plazo (viene como Contado/0) o el plazo
    // de hoy, corregiríamos un plazo que el conteo no usa y no cambiaría nada.
    let plazo = lote.plazo
    if (lote.es_conteo) {
      const { data } = await supabase.schema('produccion').from('plazo_insumo')
        .select('plazo, finca_id, vigente_desde')
        .eq('insumo_id', insumoId)
        .lte('vigente_desde', lote.fecha)
        .or(`vigente_hasta.is.null,vigente_hasta.gte.${lote.fecha}`)
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`)
      if (data?.length) {
        const pick = [...data].sort((a, b) =>
          (!!a.finca_id !== !!b.finca_id) ? (a.finca_id ? -1 : 1)
          : (a.vigente_desde < b.vigente_desde ? 1 : -1))[0]
        if (pick?.plazo != null) plazo = Number(pick.plazo)
      }
    }
    setCorrige({ insumoId, fecha: lote.fecha, plazo, actual: lote.costo_unitario, esConteo: lote.es_conteo })
    setCorrPrecio(lote.costo_unitario != null ? String(lote.costo_unitario) : '')
    setCorrAdelante(false)
  }

  // Corregir el precio de un lote: arregla el catálogo del período (o de ahí
  // en adelante) y recostea. Solo recalcula los consumos de este insumo.
  async function guardarCorreccionPrecio() {
    if (!corrige) return
    const v = numDec(corrPrecio)
    if (!(v > 0)) { setAviso({ tipo: 'error', texto: 'Pon un precio mayor que cero.' }); return }
    const insId = corrige.insumoId
    setGuardandoCorr(true)
    setAviso({ tipo: 'ok', texto: 'Corrigiendo y recalculando consumos… puede tardar unos segundos.' })
    const { error } = await supabase.schema('produccion').rpc('fn_corregir_precio_lote_insumo', {
      p_finca: finca.id, p_insumo: insId, p_fecha: corrige.fecha,
      p_plazo: corrige.plazo, p_nuevo_compra: v, p_adelante: corrAdelante,
    })
    if (error) { setGuardandoCorr(false); setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return }
    setCorrige(null)
    await cargar()
    // Refrescar el detalle por lote en pantalla (sin recargar la página).
    const { data } = await supabase.schema('produccion')
      .rpc('fn_lotes_movimiento_insumo', { p_finca: finca.id, p_insumo: insId, p_hasta: hasta })
    setLotesMov(m => ({ ...m, [insId]: data || [] }))
    setGuardandoCorr(false)
    setAviso({ tipo: 'ok', texto: 'Precio corregido y consumos recalculados.' })
  }

  function abrirCorregir(f) {
    setEditando(f.insumo_id)
    setNuevoSaldo(limpio(f.saldo))
    setMotivo('')
    setFechaAj(alDia)
    setCorrUnidad('compra')
    setCorrAjustes([])
    setAviso(null)
    // Correcciones (ajustes manuales) de este insumo, para poder borrarlas.
    supabase.schema('produccion').from('ajuste_insumo')
      .select('id, fecha, cantidad, motivo').eq('finca_id', finca.id).eq('insumo_id', f.insumo_id)
      .order('fecha', { ascending: false }).limit(20)
      .then(({ data }) => setCorrAjustes((data || []).filter(a => !/inicial/i.test(a.motivo || ''))))
  }

  async function borrarCorreccion(id) {
    if (!window.confirm('¿Borrar esta corrección? El saldo se recalcula sin ella.')) return
    const { error } = await supabase.schema('produccion').from('ajuste_insumo').delete().eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setCorrAjustes(a => a.filter(x => x.id !== id))
    setAviso({ tipo: 'ok', texto: 'Corrección borrada.' })
    await cargar()
  }

  // Corregir el saldo de un insumo suelto. Solo jefes y con motivo: un
  // ajuste es donde se tapa un descuadre, y sin el porque no sirve.
  async function guardarCorreccion(f) {
    let nuevo = Number(String(nuevoSaldo).replace(',', '.'))
    if (!isFinite(nuevo)) {
      setAviso({ tipo: 'error', texto: 'El saldo nuevo no es un número.' }); return
    }
    // Si se escribió en la unidad de aplicación, se convierte a la de compra.
    const facC = factores[f.insumo_id]
    if (corrUnidad === 'aplica' && facC?.factor) nuevo = nuevo / facC.factor
    const delta = nuevo - Number(f.saldo)
    if (Math.abs(delta) < 0.0001) { setEditando(null); return }
    if (!motivo.trim()) {
      setAviso({ tipo: 'error', texto: 'La corrección necesita un motivo.' }); return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaAj || '')) {
      setAviso({ tipo: 'error', texto: 'Pon la fecha del descuadre (AAAA-MM-DD).' }); return
    }

    setGuardandoAj(true)
    const { error } = await supabase.schema('produccion').from('ajuste_insumo')
      .insert({ finca_id: finca.id, fecha: fechaAj, insumo_id: f.insumo_id,
                cantidad: delta, motivo: motivo.trim() })
    setGuardandoAj(false)
    if (error) {
      setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return
    }
    setEditando(null)
    setAviso({ tipo: 'ok', texto: `${f.insumo} corregido a ${limpio(nuevo)}.` })
    await cargar()
  }

  const filaNueva = () => ({ nombre: '', unidad: 'kg', compraDistinta: false, unidadCompra: '', factor: '' })
  const setNuevo = (i, campo, val) => setNuevos(ns => ns.map((n, j) => j === i ? { ...n, [campo]: val } : n))

  async function guardarNuevos() {
    const validos = nuevos.filter(n => n.nombre.trim())
    if (!validos.length) { setNuevos([]); return }
    const rows = validos.map(n => ({
      nombre: n.nombre.trim(),
      unidad: n.unidad,
      unidad_compra: (n.compraDistinta ? n.unidadCompra.trim() : n.unidad) || n.unidad,
      factor: n.compraDistinta ? (Number(String(n.factor).replace(',', '.')) || 1) : 1,
    }))
    setGuardandoNuevos(true)
    if (esJefeGlobal) {
      const { error } = await supabase.schema('produccion').from('insumo').insert(rows)
      setGuardandoNuevos(false)
      if (error) {
        const dup = /duplicate|unique/i.test(error.message)
        setAviso({ tipo: 'error', texto: dup ? 'Alguno ya existe con ese nombre.' : 'No se pudo agregar. ' + error.message })
        return
      }
      setAviso({ tipo: 'ok', texto: `${rows.length} ${rows.length === 1 ? 'insumo agregado' : 'insumos agregados'}. Ya puedes contarlos abajo.` })
    } else {
      // Bodeguero/contadora: no crea, PIDE al jefe.
      const { data: au } = await supabase.auth.getUser()
      const solis = rows.map(r => ({
        finca_id: finca.id, tabla: 'nuevo_insumo', registro_id: crypto.randomUUID(),
        valor_propuesto: r, motivo: 'Insumo que falta en la lista', solicitado_por: au?.user?.id }))
      const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert(solis)
      setGuardandoNuevos(false)
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido enviado al jefe. Lo agregará al catálogo.' })
    }
    setNuevos([])
    await cargar()
  }

  async function editarConteo(c) {
    const { data } = await supabase.schema('produccion').from('toma_inventario_linea')
      .select('insumo_id, cantidad_contada, cantidad_sistema, consumo_dia, motivo_descuadre').eq('toma_id', c.id)
    const mapa = {}, md = {}, mo = {}, cd = {}, sis = {}
    ;(data || []).forEach(l => {
      mapa[l.insumo_id] = String(l.cantidad_contada)
      if (l.consumo_dia != null) cd[l.insumo_id] = String(l.consumo_dia)
      if (l.cantidad_sistema != null) sis[l.insumo_id] = Number(l.cantidad_sistema)
      if (l.motivo_descuadre) {
        if (MOTIVOS_DESCUADRE.includes(l.motivo_descuadre)) md[l.insumo_id] = l.motivo_descuadre
        else { md[l.insumo_id] = 'Otro'; mo[l.insumo_id] = l.motivo_descuadre }
      }
    })
    // El campo "Contó" guarda el HABÍA (inicio del día). Al editar se interpreta
    // tal cual (no se le vuelve a sumar el consumo) → contoDespues = false aquí.
    // La decisión antes/después se mantiene aparte (toggle de Conteos anteriores).
    setConsumoDia(cd); setSistemaEdit(sis)
    setContado(mapa); setMotivoDesc(md); setMotivoOtro(mo)
    setFecha(c.fecha); setObs(c.observacion || '')
    setContoDespues(false); setEditToma(c); setContando(true); setAviso(null)
  }

  // Corregir la decisión "antes/después" de un conteo ya guardado, sin reabrir el
  // editor. El "había" guardado cambia en ± el consumo del día de cada producto.
  const [corrigiendoDec, setCorrigiendoDec] = useState(null)   // toma_id en proceso
  const [sisDet, setSisDet] = useState(null)                   // 'toma|insumo' con el detalle de Sistema abierto
  const [corrOpen, setCorrOpen] = useState(null)               // toma_id con la opción "Corregir" (antes/después) visible
  async function corregirDecision(c, nuevoDespues) {
    if (!!c.conto_despues === nuevoDespues || corrigiendoDec) return
    setCorrigiendoDec(c.id); setAviso(null)
    try {
      const lins = lineasToma[c.id] || []
      const signo = nuevoDespues ? 1 : -1   // antes→después suma el consumo; después→antes lo resta
      for (const l of lins) {
        const cons = l.consumo_dia != null ? Number(l.consumo_dia) : (consumoDiaToma[c.id]?.[l.insumo_id] ?? 0)
        if (!(cons > 0.0001)) continue
        const nuevaContada = Number(l.cantidad_contada) + signo * cons
        const upd = { cantidad_contada: nuevaContada, diferencia: nuevaContada - Number(l.cantidad_sistema) }
        if (l.consumo_dia == null) upd.consumo_dia = cons   // congela el consumo usado
        const { error } = await supabase.schema('produccion').from('toma_inventario_linea')
          .update(upd).eq('toma_id', c.id).eq('insumo_id', l.insumo_id)
        if (error) throw error
      }
      const { error: eT } = await supabase.schema('produccion').from('toma_inventario')
        .update({ conto_despues: nuevoDespues }).eq('id', c.id)
      if (eT) throw eT
      setAviso({ tipo: 'ok', texto: `Conteo corregido: se contó ${nuevoDespues ? 'después' : 'antes'} de aplicar.` })
      await cargar()
    } catch (err) { setAviso({ tipo: 'error', texto: err.message || 'No se pudo corregir.' }) }
    finally { setCorrigiendoDec(null) }
  }

  async function verDescuadres(c) {
    if (detToma === c.id) { setDetToma(null); return }
    setDetToma(c.id)
    if (!detLineas[c.id]) {
      const { data } = await supabase.schema('produccion').from('toma_inventario_linea')
        .select('insumo_id, cantidad_sistema, cantidad_contada, diferencia, motivo_descuadre').eq('toma_id', c.id)
      const desc = (data || []).filter(l => Math.abs(Number(l.diferencia) || 0) > 0.0001)
      setDetLineas(m => ({ ...m, [c.id]: desc }))
    }
  }

  // Imprimir el acta de un conteo: por cada insumo, sistema · contó · diferencia · motivo.
  async function imprimirConteo(c) {
    const uIns = id => (saldos.find(s => s.insumo_id === id)?.unidad) || ''
    const { data } = await supabase.schema('produccion').from('toma_inventario_linea')
      .select('insumo_id, cantidad_sistema, cantidad_contada, diferencia, motivo_descuadre').eq('toma_id', c.id)
    const filas = (data || []).map(l => {
      const dif = Number(l.diferencia) || 0
      const sinDif = Math.abs(dif) < 0.001
      return {
        insumo: nombreInsumo(l.insumo_id),
        unidad: cap1(UNIDAD[uIns(l.insumo_id)] || uIns(l.insumo_id) || ''),
        sistema: limpio(l.cantidad_sistema),
        contado: limpio(l.cantidad_contada),
        diferencia: sinDif ? 'Se mantiene' : (dif < 0 ? 'faltó ' : 'sobró ') + limpio(Math.abs(dif)),
        motivo: sinDif ? '' : (l.motivo_descuadre || ''),
      }
    }).sort((a, b) => String(a.insumo).localeCompare(String(b.insumo)))
    const ok = reporteBodegaPDF({
      titulo: 'Reporte de conteo de bodega',
      finca: String(finca.nombre).toUpperCase(),
      categoria: 'Insumos',
      subtitulo: 'Saldo, conteo y diferencias · insumos',
      pie: '<b>Cómo se lee:</b> Sistema = lo que decía el sistema. Contó = lo contado físicamente. Diferencia: "faltó" = menos de lo que decía; "sobró" = más; "Se mantiene" = cuadró.',
      meta: [
        { k: 'Fecha del conteo', v: corta(c.fecha) },
        { k: 'Tipo', v: c.es_inicial ? 'Inventario inicial' : 'Conteo' },
        ...(c.observacion ? [{ k: 'Observación', v: c.observacion }] : []),
      ],
      columnas: [
        { titulo: 'Insumo', campo: 'insumo' },
        { titulo: 'Unidad', campo: 'unidad' },
        { titulo: 'Sistema', campo: 'sistema', der: true },
        { titulo: 'Contó', campo: 'contado', der: true },
        { titulo: 'Diferencia', campo: 'diferencia', der: true },
        { titulo: 'Motivo', campo: 'motivo' },
      ],
      filas,
    })
    if (!ok) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.' })
  }

  async function borrarConteo(c) {
    if (!window.confirm(`¿Borrar el conteo del ${corta(c.fecha)}?\n\nEl saldo vuelve a calcularse desde el conteo anterior (o desde cero si no hay otro). No se puede deshacer.`)) return
    const { error } = await supabase.schema('produccion').from('toma_inventario').delete().eq('id', c.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Conteo borrado.' })
    await cargar()
  }

  async function guardar() {
    if (!llenadas) {
      setAviso({ tipo: 'error', texto: 'No has contado ningún insumo todavía.' })
      return
    }

    const texto = editToma
      ? `Vas a guardar los cambios del conteo del ${corta(editToma.fecha)}.\n\n¿Guardar?`
      : primeraVez
      ? `Vas a cargar el inventario inicial con ${llenadas} insumos contados.\n\n` +
        `De aquí en adelante el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra a bodega.\n\n¿Guardar?`
      : descuadres.length
        ? `${descuadres.length} insumos no cuadran con lo que el sistema tenía calculado.\n\n` +
          descuadres.slice(0, 5).map(d =>
            `${d.insumo}: el sistema decía ${limpio(d.saldo)}, contaste ${limpio(d.contado)} (${d.diferencia > 0 ? 'sobran ' : 'faltan '}${limpio(Math.abs(d.diferencia))})`
          ).join('\n') +
          (descuadres.length > 5 ? `\n...y ${descuadres.length - 5} más` : '') +
          `\n\nLas diferencias quedan registradas con tu nombre y la fecha. ¿Guardar?`
        : `Todo cuadra con lo que el sistema tenía calculado. ¿Guardar el conteo?`

    if (!window.confirm(texto)) return

    setGuardando(true); setAviso(null)
    try {
      let tomaId
      if (editToma) {
        // Editar un conteo existente: actualiza cabecera y reemplaza líneas.
        const { error: eU } = await supabase.schema('produccion').from('toma_inventario')
          .update({ fecha, observacion: obs || null, conto_despues: !!editToma.conto_despues }).eq('id', editToma.id)
        if (eU) throw eU
        await supabase.schema('produccion').from('toma_inventario_linea').delete().eq('toma_id', editToma.id)
        tomaId = editToma.id
      } else {
        const { data: toma, error } = await supabase.schema('produccion')
          .from('toma_inventario')
          .insert({ finca_id: finca.id, fecha, observacion: obs || null, es_inicial: conteos.length === 0, conto_despues: contoDespues })
          .select('id').single()
        if (error) throw error
        tomaId = toma.id
      }

      // Los contados. Si el modo es "Queda en 0", también los no contados que
      // tenían saldo (se ponen en 0). "Se mantiene" = solo los contados.
      const contadas = filas.filter(f => f.contado !== null)
      const enCero = (!primeraVez && !editToma && noContados === 'cero')
        ? filas.filter(f => f.contado === null && !esSinInvFila(f))
        : []
      const lineas = [...contadas, ...enCero].map(f => {
        const contadoVal = f.contado !== null ? f.habiaContado : 0
        // Se graba el Sistema RECALCULADO a la fecha del conteo (f.habiaSistema),
        // tanto al crear como al editar, para que quede el valor real de hoy.
        const sistemaVal = f.contado !== null ? Number(f.habiaSistema) : Number(f.saldo)
        const difVal = f.contado !== null ? (contadoVal - Number(sistemaVal)) : (0 - Number(f.saldo))
        // En un recuento normal, hay descuadre si la diferencia no es cero.
        // Al editar, conservamos el motivo que ya se había cargado.
        const hayDesc = !primeraVez && (editToma || Math.abs(difVal || 0) > 0.0001)
        const cat = motivoDesc[f.insumo_id]
        const motivoD = hayDesc && cat
          ? (cat === 'Otro' ? (motivoOtro[f.insumo_id]?.trim() || 'Otro') : cat)
          : null
        return {
          toma_id: tomaId, insumo_id: f.insumo_id,
          cantidad_contada: contadoVal,
          cantidad_sistema: Number(sistemaVal),
          diferencia: difVal,
          motivo_descuadre: motivoD,
          // Consumo del día CONGELADO (lo que se aplicó antes de contar). Queda
          // fijo aunque luego registren alimentación de ese día.
          consumo_dia: f.cons > 0.0001 ? f.cons : null,
        }
      })
      const { error: e2 } = await supabase.schema('produccion')
        .from('toma_inventario_linea').insert(lineas)
      if (e2) throw e2

      setAviso({ tipo: 'ok',
        texto: editToma ? 'Conteo actualizado.' : primeraVez ? 'Inventario inicial cargado.' : `Conteo guardado. ${lineas.length} insumos.` })
      setContando(false); setEditToma(null); setContado({}); setSobrante({}); setSobranteOn({}); setObs(''); setMotivoDesc({}); setMotivoOtro({}); setContoDespues(false)
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>Inventario de insumos</h2>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            Bodega de {String(finca.nombre).toUpperCase()}.
          </p>
        </div>
        {seccion === 'bodega' && !contando && !cargando && (
          <div style={{ display: 'flex', gap: '9px', alignItems: 'center' }}>
            {esJefe && <BotonDescargar desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} onPDF={exportarPDF} onExcel={exportarExcel} />}
            {esJefe && <button onClick={() => setBajaOpen(true)} style={{ padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid #e7cccb', borderRadius: '9px', background: 'white', color: ROJO, cursor: 'pointer' }}>Dar de baja</button>}
            <Btn primario onClick={() => { setContoDespues(false); setContando(true); }}>
              {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
            </Btn>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '22px', marginBottom: '18px', alignItems: 'center' }}>
        <TabU on={seccion === 'bodega'} onClick={() => { setSeccion('bodega'); cargar() }}>Bodega</TabU>
        <TabU on={seccion === 'movimiento'} onClick={() => { setSeccion('movimiento'); setContando(false) }}>Ingresos</TabU>
      </div>

      {seccion === 'movimiento' ? (
        <Ingresos finca={finca} esJefe={esJefe} onCorreccion={onCorreccion} onCambio={cargar} />
      ) : (
      <>
      {/* --- seccion bodega --- */}

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>
          {aviso.texto}
        </div>
      )}

      {esJefe && bajaOpen && (
        <ModalBajaIns finca={finca} insumos={filas.filter(f => Number(f.saldo) > 0.001)}
          precioFifoDe={precioFifoDe}
          onCerrar={() => setBajaOpen(false)}
          onHecho={async m => { setBajaOpen(false); setAviso({ tipo: 'ok', texto: m }); await cargar() }} />
      )}

      {!contando && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap',
                      marginBottom: '14px' }}>
          <Seg valor={vista} onCambio={setVista} opciones={[['saldo', 'Cuánto hay'], ['movimientos', 'Qué se movió']]} />
          {/* El bodeguero ve Saldo + Equivalente en columnas (sin toggle). El jefe mantiene el toggle. */}
          {vista === 'saldo' && esJefe && (
            <>
              <span style={{ fontSize: '12.5px', color: GRIS }}>Ver en:</span>
              <Seg valor={unidadSaldo} onCambio={setUnidadSaldo}
                   opciones={[['compra', 'Como se compra'], ['aplica', 'Como se aplica']]} />
            </>
          )}
          {vista === 'saldo' && filas.filter(f => coincide(f.insumo) && esSinInvFila(f)).length > 0 && (
            <GhostBtn on={verSinInv} onClick={() => setVerSinInv(v => !v)}>
              {verSinInv ? 'Ocultar sin inventario' : `Sin inventario (${filas.filter(f => coincide(f.insumo) && esSinInvFila(f)).length})`}
            </GhostBtn>
          )}
          <BuscadorFiltro value={busq} onChange={setBusq}
            opciones={[...new Set(saldos.map(s => s.insumo))].sort()}
            placeholder="Buscar insumo…" />
          {vista === 'saldo' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: GRIS }}>al</span>
              <input type="date" value={alDia} max={hoyISO()}
                     onChange={e => setAlDia(e.target.value)} style={entrada} />
              {alDia !== hoyISO() && (
                <button onClick={() => setAlDia(hoyISO())}
                        style={{ background: 'none', border: 'none', cursor: 'pointer',
                                 fontFamily: 'inherit', fontSize: '12px', color: AZUL }}>
                  volver a hoy
                </button>
              )}
            </label>
          ) : null}
        </div>
      )}

      {!contando && !cargando && vista === 'saldo' && (
        <>
          {/* Resumen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                        gap: '11px', marginBottom: '14px' }}>
            {/* El valor en dolares es solo para el jefe. */}
            {esJefe && <Kpi titulo="Valor de la bodega" valor={dinero(valorBodega)} />}
            <Kpi titulo="Insumos con saldo" valor={`${conSaldo} de ${saldos.length}`} />
            <Kpi titulo="Último conteo"
                 valor={ultimo ? corta(ultimo.fecha) : 'Nunca'}
                 nota={ultimo ? null : 'todo arranca en cero'}
                 alerta={!ultimo} />
            <Kpi titulo="Con problema"
                 valor={negativos + sinPrecio === 0 ? 'Ninguno' : String(negativos + sinPrecio)}
                 nota={negativos ? `${negativos} en negativo` : sinPrecio ? `${sinPrecio} sin precio` : null}
                 alerta={negativos + sinPrecio > 0} />
          </div>

          {primeraVez && (
            filas.some(f => Number(f.saldo) !== 0) ? (
              <Nota color={AMBAR} fondo="#FAEEDA">
                Aún no has hecho un conteo físico de esta finca. El saldo de arriba viene de los
                ingresos registrados. Cuando cuentes la bodega con <b>Cargar inventario inicial</b>,
                ese conteo fija el punto de partida.
              </Nota>
            ) : (
              <Nota color={AMBAR} fondo="#FAEEDA">
                Todavía no se ha contado la bodega de esta finca, así que todo está en cero.
                Cuenta lo que hay y guárdalo con <b>Cargar inventario inicial</b>. De ahí en adelante
                el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra.
              </Nota>
            )
          )}

          {negativos > 0 && (
            <Nota color={ROJO} fondo="#FBEAEA">
              Hay {negativos} {negativos === 1 ? 'insumo' : 'insumos'} con saldo negativo: {' '}
              <b>{saldos.filter(s => Number(s.saldo) < 0).map(s => `${s.insumo} (${limpio(s.saldo)})`).join(', ')}</b>.
              {' '}Se registró más consumo del que entró a bodega: falta cargar un ingreso, o hay que volver a contar.
            </Nota>
          )}

          {esJefe && sinPrecio > 0 && (
            <Nota color={AMBAR} fondo="#FBF5E9">
              Hay {sinPrecio} {sinPrecio === 1 ? 'insumo' : 'insumos'} sin precio que cubra su lote: {' '}
              <b>{sinPrecioList.map(s => s.insumo).join(', ')}</b>.
              {' '}Su saldo y su consumo valen $0 (si es el <b>inventario inicial</b>, carga el precio en <b>Catálogo</b> con vigencia desde la fecha del inicial, o antes).
            </Nota>
          )}
        </>
      )}

      {cargando && !saldos.length ? (
        <Caja><div style={{ padding: '34px', textAlign: 'center', fontSize: '13px', color: GRIS }}>
          Cargando...
        </div></Caja>

      ) : contando ? (
        <Caja>
          {editToma && (
            <div style={{ padding: '11px 16px', background: '#E6F1FB', color: AZUL, fontSize: '13px',
                          borderBottom: '0.5px solid ' + BORDE }}>
              Editando el conteo del {corta(editToma.fecha)}. Cambia las cantidades y guarda.
            </div>
          )}
          <div style={{ padding: '15px 16px', borderBottom: '0.5px solid ' + BORDE,
                        display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <Etiqueta>Fecha del conteo</Etiqueta>
              <input type="date" value={fecha} max={hoyISO()}
                     onChange={e => setFecha(e.target.value)} style={entrada} />
            </div>
            <div style={{ flex: 1, minWidth: '240px' }}>
              <Etiqueta>Observación</Etiqueta>
              <input value={obs} placeholder="Quién contó, qué se encontró"
                     onChange={e => setObs(e.target.value)} style={{ ...entrada, width: '100%' }} />
            </div>
          </div>

          {!primeraVez && !editToma && (
            <div style={{ padding: '13px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#F4F9FF' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <span style={{ color: AZUL, fontSize: '15px', lineHeight: 1.2 }}>i</span>
                <div style={{ fontSize: '13px', color: NAVY }}>
                  Cuenta solo lo que verifiques. <b style={{ fontWeight: 600 }}>Lo que dejes en blanco se mantiene</b> en su saldo actual — no se pone en 0.
                </div>
              </div>
            </div>
          )}

          {!modoIni && Object.values(consumoDia).some(v => v > 0.0001) && (
            <div style={{ padding: '13px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#FDF3DF',
                          display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', color: '#6b4e12', fontWeight: 600, flex: 1, minWidth: '240px' }}>
                Ese día ya hay consumos registrados. ¿Contaste antes o después de aplicar?
              </span>
              <Seg valor={contoDespues ? 'despues' : 'antes'}
                   onCambio={v => setContoDespues(v === 'despues')}
                   opciones={[['antes', 'Conté antes de aplicar'], ['despues', 'Conté después']]} />
            </div>
          )}

          <Tabla
            columnas={modoIni
              ? ['Insumo', 'Llega / se aplica', '', 'Inventario inicial', '']
              : ['Insumo', 'Llega / se aplica', editToma ? 'Había antes' : 'Sistema', 'Contó', 'Consumo del día', 'Diferencia', 'Queda']}
            anchos={modoIni ? ANCHOS_CONTEO_INI : ANCHOS_CONTEO_EDIT}
            alinear={modoIni ? undefined : ['left', 'left', 'center', 'center', 'center', 'center', 'center']}
          >
            {(() => {
              const esRecuento = !(primeraVez || editToma)
              const lista = esRecuento
                ? [...filas].sort((a, b) => {
                    const ia = Number(a.esperado) > 0.0001 ? 0 : 1, ib = Number(b.esperado) > 0.0001 ? 0 : 1
                    return ia !== ib ? ia - ib : String(a.insumo).localeCompare(String(b.insumo), 'es')
                  })
                : filas
              const primeraSin = esRecuento ? lista.findIndex(f => !(Number(f.esperado) > 0.0001)) : -1
              return lista.map((f, idx) => {
              const facF = factores[f.insumo_id]
              const convF = facF && (facF.factor || 1) !== 1
              const conPesoF = !convF && facF && facF.contenido && facF.contenido !== 1 && facF.uCont
              const uPresF = cap1(UNIDAD[f.unidad] || f.unidad || '')
              const uAppF = facF && facF.uApp ? cap1(UNIDAD[facF.uApp] || facF.uApp || '') : ''
              return (
              <Fragment key={f.insumo_id}>
              {esRecuento && primeraSin > 0 && idx === primeraSin && (
                <div style={{ padding: '9px 16px', background: '#fbfcfe', borderTop: '1px solid ' + BORDE, borderBottom: '0.5px solid ' + BORDE, fontSize: '11px', fontWeight: 600, color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em' }}>Sin inventario</div>
              )}
              <Fila anchos={modoIni ? ANCHOS_CONTEO_INI : ANCHOS_CONTEO_EDIT}>
                <Celda>{f.insumo}</Celda>
                <Celda gris>
                  <span style={{ color: NAVY, fontWeight: 500 }}>{cap1(UNIDAD[f.unidad] || f.unidad)}</span>
                  {convF && <>
                    {' '}<span style={{ color: '#c3d0db' }}>→</span> {cap1(UNIDAD[facF.uApp] || facF.uApp)}
                    <div style={{ fontSize: '10px', color: GRIS }}>1 {cap1(UNIDAD[f.unidad] || f.unidad)} = {limpio(facF.factor)} {cap1(UNIDAD[facF.uApp] || facF.uApp)}</div>
                  </>}
                  {conPesoF && <div style={{ fontSize: '10px', color: GRIS }}>1 {cap1(UNIDAD[f.unidad] || f.unidad)} = {limpio(facF.contenido)} {cap1(UNIDAD[facF.uCont] || facF.uCont)}</div>}
                </Celda>
                {modoIni ? (<>
                  <Celda derecha gris></Celda>
                  <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f1f6f9' }}>
                    {convF ? (<>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                          <span style={{ fontSize: '10px', color: GRIS }}>{cap1(UNIDAD[f.unidad] || f.unidad)}</span>
                          <CampoNumero maxDec={2} value={contado[f.insumo_id] ?? ''} placeholder="0" onChange={v => setContado(c => ({ ...c, [f.insumo_id]: v }))} style={{ ...entrada, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                        </div>
                        <span style={{ color: '#c3d0db', paddingBottom: '8px' }}>+</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                          <span style={{ fontSize: '10px', color: GRIS }}>{cap1(UNIDAD[facF.uApp] || facF.uApp)}</span>
                          <CampoNumero maxDec={2} value={sobrante[f.insumo_id] ?? ''} placeholder="0" onChange={v => setSobrante(s => ({ ...s, [f.insumo_id]: v }))} style={{ ...entrada, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                        </div>
                      </div>
                      {f.contado !== null && <div style={{ fontSize: '10.5px', color: VERDE, marginTop: '4px', textAlign: 'right' }}>= {limpio(f.contado)} {cap1(UNIDAD[f.unidad] || f.unidad)} · {limpio(f.contado * (facF.factor || 1))} {cap1(UNIDAD[facF.uApp] || facF.uApp)}</div>}
                    </>) : (
                      <CampoNumero maxDec={2} value={contado[f.insumo_id] ?? ''} placeholder="—" onChange={v => setContado(c => ({ ...c, [f.insumo_id]: v }))} style={{ ...entrada, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                    )}
                  </div>
                  <Celda></Celda>
                </>) : (<>
                  {/* Sistema / Había antes (recalculado a la fecha del conteo) */}
                  <Celda centro gris>
                    <><span style={{ fontWeight: 600 }}>{limpio(f.esperado)}</span><div style={{ fontSize: '10px', color: '#aab8c6' }}>{uPresF}</div></>
                  </Celda>
                  {/* Contó (input + equivalencia chiquita) */}
                  <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f1f6f9' }}>
                    {convF ? (<>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end', justifyContent: 'center' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontSize: '10px', color: GRIS }}>{cap1(UNIDAD[f.unidad] || f.unidad)}</span>
                          <CampoNumero maxDec={2} value={contado[f.insumo_id] ?? ''} placeholder="0" onChange={v => setContado(c => ({ ...c, [f.insumo_id]: v }))} style={{ ...entrada, width: '72px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                        </div>
                        <span style={{ color: '#c3d0db', paddingBottom: '8px' }}>+</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontSize: '10px', color: GRIS }}>{cap1(UNIDAD[facF.uApp] || facF.uApp)}</span>
                          <CampoNumero maxDec={2} value={sobrante[f.insumo_id] ?? ''} placeholder="0" onChange={v => setSobrante(s => ({ ...s, [f.insumo_id]: v }))} style={{ ...entrada, width: '72px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                        </div>
                      </div>
                      {f.contado !== null && <div style={{ fontSize: '9.5px', color: GRIS, marginTop: '4px', textAlign: 'center' }}>= {limpio(f.contado)} {cap1(UNIDAD[f.unidad] || f.unidad)} · {limpio(f.contado * (facF.factor || 1))} {cap1(UNIDAD[facF.uApp] || facF.uApp)}</div>}
                    </>) : (
                      <CampoNumero maxDec={2} value={contado[f.insumo_id] ?? ''} placeholder="—" onChange={v => setContado(c => ({ ...c, [f.insumo_id]: v }))} style={{ ...entrada, width: '100%', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
                    )}
                  </div>
                  {/* Consumo del día */}
                  <Celda centro>
                    {f.cons > 0.0001
                      ? <span style={{ display: 'inline-block', background: '#FDF3DF', border: '0.5px solid #eedcb0', borderRadius: '8px', padding: '5px 9px' }}><b style={{ color: '#7a5410', fontSize: '13px' }}>{limpio(f.cons)}</b><span style={{ display: 'block', fontSize: '9px', color: '#BA7517' }}>{editToma ? 'del ' + ddmm(fecha) : 'hoy'}</span></span>
                      : <span style={{ color: '#c3d0db' }}>—</span>}
                  </Celda>
                  {/* Diferencia (Contó − Sistema recalculado) */}
                  <Celda centro color={f.diferencia === null ? '#c3d0db' : f.diferencia < 0 ? ROJO : f.diferencia > 0 ? AMBAR : VERDE}>
                    {f.diferencia === null ? (noContados === 'cero' ? 'Queda en 0' : 'Se mantiene') : f.diferencia === 0 ? 'Cuadra' : (f.diferencia < 0 ? 'Faltan ' : 'Sobran ') + limpio(Math.abs(f.diferencia))}
                  </Celda>
                  {/* Queda (Contó − Consumo del día; si no has contado, el esperado = Sistema − Consumo) */}
                  <Celda centro fuerte color={NAVY}>
                    {f.contado !== null
                      ? <><span style={{ fontWeight: 700 }}>{limpio(f.saldoFinal)}</span><div style={{ fontSize: '10px', color: GRIS }}>{uPresF}</div></>
                      : <><span style={{ fontWeight: 600, color: GRIS }}>{limpio(Number(f.saldo))}</span><div style={{ fontSize: '10px', color: '#aab8c6' }}>{uPresF}</div></>}
                  </Celda>
                </>)}
                {/* Motivo del descuadre: solo cuando no cuadra (recuento). */}
                {!modoIni && f.contado !== null && Math.abs(f.diferencia || 0) > 0.0001 && (
                  <div style={{ gridColumn: '1 / -1', padding: '0 12px 11px 12px',
                                display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                                borderBottom: '0.5px solid #f1f6f9', marginTop: '-2px' }}>
                    <span style={{ fontSize: '11px', color: GRIS }}>
                      {f.diferencia < 0 ? '¿Por qué faltan?' : '¿Por qué sobran?'}
                    </span>
                    <select value={motivoDesc[f.insumo_id] || ''}
                      onChange={e => setMotivoDesc(m => ({ ...m, [f.insumo_id]: e.target.value }))}
                      style={{ ...entrada, width: '180px', padding: '5px 8px' }}>
                      <option value="">Elegir motivo</option>
                      {MOTIVOS_DESCUADRE.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    {motivoDesc[f.insumo_id] === 'Otro' && (
                      <input value={motivoOtro[f.insumo_id] || ''} placeholder="Especifica el motivo"
                        onChange={e => setMotivoOtro(m => ({ ...m, [f.insumo_id]: e.target.value }))}
                        style={{ ...entrada, flex: 1, minWidth: '160px', padding: '5px 8px' }} />
                    )}
                  </div>
                )}
              </Fila>
              </Fragment>
            )})
            })()}
          </Tabla>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: GRIS, marginRight: 'auto' }}>
              {llenadas} de {saldos.length} contados
              {!primeraVez && descuadres.length > 0 && ` · ${descuadres.length} no cuadran`}
            </span>
            <Btn onClick={() => { setContando(false); setContado({}); setSobrante({}); setSobranteOn({}); setMotivoDesc({}); setMotivoOtro({}); setEditToma(null); setContoDespues(false) }}>Cancelar</Btn>
            <Btn primario onClick={guardar} disabled={guardando || !llenadas}>
              {guardando ? 'Guardando...' : editToma ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
            </Btn>
          </div>
        </Caja>

      ) : vista === 'movimientos' ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px 20px', marginBottom: '14px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12.5px', color: GRIS }}>Ver en:</span>
              <Seg valor={unidadMov} onCambio={setUnidadMov}
                   opciones={[['compra', 'Como se compra'], ['aplica', 'Como se aplica']]} />
              {(() => {
                const n = movs.filter(m => coincide(m.insumo) && esSinInvMov(m)).length
                return n > 0 && (
                  <GhostBtn on={verSinInv} onClick={() => setVerSinInv(v => !v)}>
                    {verSinInv ? 'Ocultar sin inventario' : `Sin inventario (${n})`}
                  </GhostBtn>
                )
              })()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '9px', flexWrap: 'wrap' }}>
              <GhostBtn on={modoMov === 'fechas' && desde === primeroDelMes(hoyISO()) && hasta === hoyISO()}
                onClick={() => { setModoMov('fechas'); setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()) }}>Este mes</GhostBtn>
              <GhostBtn on={modoMov === 'fechas' && desde === primeroMesPasado(hoyISO()) && hasta === sumarDias(primeroDelMes(hoyISO()), -1)}
                onClick={() => { setModoMov('fechas'); setDesde(primeroMesPasado(hoyISO())); setHasta(sumarDias(primeroDelMes(hoyISO()), -1)) }}>Mes pasado</GhostBtn>
              <Seg valor={modoMov} onCambio={setModoMov} opciones={[['conteo', 'Por conteo'], ['fechas', 'Por fechas']]} />
              {modoMov === 'conteo' ? (
                periodos.length ? (
                  <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button onClick={() => setPeriodoSel(i => Math.min(i + 1, periodos.length - 1))} disabled={periodoSel >= periodos.length - 1}
                      style={{ ...navBtn, opacity: periodoSel >= periodos.length - 1 ? 0.4 : 1 }}>‹</button>
                    <select value={periodoSel} onChange={e => setPeriodoSel(Number(e.target.value))} style={{ ...selChip, minWidth: '240px' }}>
                      {periodos.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
                    </select>
                    <button onClick={() => setPeriodoSel(i => Math.max(i - 1, 0))} disabled={periodoSel <= 0}
                      style={{ ...navBtn, opacity: periodoSel <= 0 ? 0.4 : 1 }}>›</button>
                  </span>
                ) : <span style={{ fontSize: '13px', color: GRIS }}>Aún no hay conteos.</span>
              ) : (
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '13px', color: GRIS }}>del</span>
                  <input type="date" value={desde} max={hasta}
                         onChange={e => setDesde(e.target.value)} style={entrada} />
                  <span style={{ fontSize: '13px', color: GRIS }}>al</span>
                  <input type="date" value={hasta} min={desde} max={hoyISO()}
                         onChange={e => setHasta(e.target.value)} style={entrada} />
                  <GhostBtn onClick={() => { setDesde(hoyISO().slice(0, 4) + '-01-01'); setHasta(hoyISO()) }}>Este año</GhostBtn>
                </label>
              )}
            </div>
          </div>
          <Tabla
            caja min={minMov}
            columnas={colsMov}
            anchos={anchosMov}
          >
            {movs.filter(m => coincide(m.insumo) && (verSinInv || !esSinInvMov(m))).map(m => {
              const fac = factores[m.insumo_id]
              // Hay conversión cuando la unidad de uso es real (kilos, litros…) y
              // distinta del envase. "Unidades" es genérico → no cuenta.
              const conv = fac && fac.uApp && !esUnidadGenerica(fac.uApp) && cap1(UNIDAD[fac.uApp] || fac.uApp) !== cap1(UNIDAD[m.unidad] || m.unidad)
              // El interruptor decide en qué unidad se ven los números.
              const enUso = unidadMov === 'aplica' && conv
              const factor = enUso ? (fac.factor || 1) : 1
              const uLabel = (enUso ? (UNIDAD[fac.uApp] || fac.uApp) : (UNIDAD[m.unidad] || m.unidad) || '').toLowerCase()
              const val = v => limpio(Number(v) * factor)
              const iniEsConteo = anclaInicio(m)
              const apertura = aperturaInicial(m)                 // inventario inicial del rango como apertura
              const usaApertura = apertura != null
              const contInicial = usaApertura || (iniEsConteo && conteoQuien[m.insumo_id]?.esInicial)
              const iniMostrar = usaApertura ? apertura : (iniEsConteo ? m.conteo : m.saldo_inicial)
              const iniEsAncla = usaApertura || iniEsConteo
              const conteoMostrar = iniEsConteo ? null : m.conteo
              const fechaConteoIni = iniRango[m.insumo_id]?.fecha || conteoQuien[m.insumo_id]?.fecha || desde
              const cq = conteoQuien[m.insumo_id]
              const abierto2 = conteoDet === m.insumo_id
              const porQuien = cq && (
                <>
                  <button onClick={() => setConteoDet(abierto2 ? null : m.insumo_id)}
                    title="Ver quién contó y cuándo"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL,
                             fontSize: '10px', padding: '0 0 0 5px', lineHeight: 1 }}>{abierto2 ? '▾' : '▸'}</button>
                  {abierto2 && <div style={{ fontSize: '9.5px', color: GRIS, marginTop: '2px', fontWeight: 400 }}>
                    {cq.autor || 'desconocido'} · {corta(cq.fecha)}
                  </div>}
                </>
              )
              // Flechitas de Entró / Se aplicó: lista vertical por fecha bajo su columna.
              const keyE = m.insumo_id + '|entro', keyA = m.insumo_id + '|aplico'
              const entroList = entroDet[m.insumo_id] || [], aplicoList = aplicoDet[m.insumo_id] || []
              const openE = !!movAbierto[keyE] && entroList.length > 0
              const openA = !!movAbierto[keyA] && aplicoList.length > 0
              // Desglose del saldo (Queda): cómo se arma. Solo en "Por fechas".
              const keyS = m.insumo_id + '|saldo'
              const openS = modoMov === 'fechas' && !!movAbierto[keyS]
              const sIni = Number(iniMostrar) || 0, sIng = Number(m.ingresos) || 0, sCon = Number(m.consumo) || 0
              const sResta = sIni + sIng - sCon
              const sFin = Number(m.saldo_final) || 0
              const sAjuste = sFin - sResta
              const listaMov = (list, signo, color) => {
                const suma = list.reduce((t, x) => t + Number(x.cant || 0), 0)
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontVariantNumeric: 'tabular-nums' }}>
                    {list.map((it, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', fontSize: '11.5px' }}>
                        <span style={{ color: '#aab8c6' }}>{ddmm(it.fecha)}</span>
                        <span style={{ color, minWidth: '40px' }}>{signo}{val(it.cant)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', fontSize: '11.5px', fontWeight: 700, color: NAVY, borderTop: '1px solid ' + BORDE, marginTop: '2px', paddingTop: '2px' }}>
                      <span style={{ fontWeight: 600, color: GRIS }}>Total</span>
                      <span style={{ minWidth: '40px' }}>{signo}{val(suma)}</span>
                    </div>
                  </div>
                )
              }
              return (
              <div key={m.insumo_id}>
              <Fila anchos={anchosMov}>
                <Celda>
                  <button onClick={() => abrirMov(m.insumo_id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, textAlign: 'left' }}>
                    <span style={{ color: GRIS, marginRight: '7px', fontSize: '11px' }}>{movDet === m.insumo_id ? '▾' : '▸'}</span>{m.insumo}
                  </button>
                </Celda>
                <Celda gris>
                  <span style={{ color: NAVY, fontWeight: 500 }}>{cap1(UNIDAD[m.unidad] || m.unidad)}</span>
                  {conv && <> <span style={{ color: '#c3d0db' }}>→</span> {cap1(UNIDAD[fac.uApp] || fac.uApp)}
                    <span style={{ display: 'block', fontSize: '10px', color: GRIS }}>{fac.factor} {abrevU(fac.uApp)}</span></>}
                </Celda>
                <Celda derecha gris={!iniEsAncla} fuerte={iniEsAncla}>
                  {iniMostrar === null || iniMostrar === undefined ? '—' : <>
                    <div>{val(iniMostrar)}</div>
                    {contInicial && <><span style={badgeIni}>Inicial</span>{usaApertura
                      ? <span style={{ display: 'block', fontSize: '9.5px', color: GRIS }}>{corta(fechaConteoIni)}</span>
                      : porQuien}</>}
                    {iniEsConteo && !contInicial && <span style={badgeIni}>Conteo {ddmm(fechaConteoIni)}</span>}
                  </>}
                </Celda>
                <Celda derecha color={Number(m.ingresos) ? VERDE : '#c3d0db'}>
                  {Number(m.ingresos) ? (entroList.length > 0
                    ? <button onClick={() => setMovAbierto(x => ({ ...x, [keyE]: !x[keyE] }))} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: VERDE, fontVariantNumeric: 'tabular-nums' }}>+{val(m.ingresos)} <span style={{ color: AZUL, fontSize: '9px' }}>{openE ? '▾' : '▸'}</span></button>
                    : '+' + val(m.ingresos)) : '—'}
                </Celda>
                <Celda derecha color={Number(m.consumo) ? ROJO : '#c3d0db'}>
                  {Number(m.consumo) ? (aplicoList.length > 0
                    ? <button onClick={() => setMovAbierto(x => ({ ...x, [keyA]: !x[keyA] }))} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: ROJO, fontVariantNumeric: 'tabular-nums' }}>−{val(m.consumo)} <span style={{ color: AZUL, fontSize: '9px' }}>{openA ? '▾' : '▸'}</span></button>
                    : '−' + val(m.consumo)) : '—'}
                </Celda>
                {modoMov === 'fechas' ? (() => {
                  const antes = saldoAntes[m.insumo_id]
                  const hayCont = m.conteo !== null && m.conteo !== undefined
                  const cont = Number(m.conteo)
                  const dif = (hayCont && antes != null) ? cont - antes : null
                  return (
                    <>
                      <Celda derecha gris>{antes == null ? '—' : val(antes)}</Celda>
                      <Celda derecha fuerte={hayCont} color={hayCont ? AZUL : '#c3d0db'}>
                        {!hayCont ? '—' : <>
                          <div>{val(cont)}{porQuien}</div>
                          {dif !== null && Math.abs(dif) >= 0.001 && (
                            <span style={{ display: 'block', fontSize: '10px', fontWeight: 400, color: dif < 0 ? ROJO : AMBAR }}>{dif < 0 ? 'Faltó ' : 'Sobró '}{val(Math.abs(dif))}</span>
                          )}
                        </>}
                      </Celda>
                      <Celda derecha fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>
                        <button onClick={() => setMovAbierto(x => ({ ...x, [keyS]: !x[keyS] }))}
                          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', fontWeight: 'inherit', color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                          {val(m.saldo_final)} <span style={{ color: AZUL, fontSize: '9px' }}>{openS ? '▾' : '▸'}</span>
                        </button> <span style={{ fontSize: '11px', fontWeight: 400, color: GRIS }}>{uLabel}</span>
                      </Celda>
                    </>
                  )
                })() : (
                  <>
                    <Celda derecha color={Number(m.devuelto) ? ROJO : '#c3d0db'}>
                      {Number(m.devuelto) ? '−' + val(m.devuelto) : '—'}
                    </Celda>
                    <Celda derecha color={Number(m.ajustes) ? (Number(m.ajustes) < 0 ? ROJO : VERDE) : '#c3d0db'}>
                      {Number(m.ajustes) ? (Number(m.ajustes) > 0 ? '+' : '−') + val(Math.abs(Number(m.ajustes))) : '—'}
                    </Celda>
                    {!ocultaConteo && (
                      <Celda derecha color={conteoMostrar === null || conteoMostrar === undefined ? '#c3d0db' : AZUL}>
                        {conteoMostrar === null || conteoMostrar === undefined ? '—' : <>{val(conteoMostrar)}{porQuien}</>}
                      </Celda>
                    )}
                    <Celda derecha fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>
                      {val(m.saldo_final)} <span style={{ fontSize: '11px', fontWeight: 400, color: GRIS }}>{uLabel}</span>
                    </Celda>
                  </>
                )}
              </Fila>
              {(openE || openA) && (
                <div style={{ display: 'grid', gridTemplateColumns: anchosMov, background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9' }}>
                  {colsMov.map((_, ci) => (
                    <div key={ci} style={{ padding: '6px 18px 12px' }}>
                      {ci === 3 && openE ? listaMov(entroList, '+', VERDE)
                        : ci === 4 && openA ? listaMov(aplicoList, '−', ROJO)
                        : null}
                    </div>
                  ))}
                </div>
              )}
              {openS && (
                <div style={{ background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', padding: '9px 20px 12px 42px', fontSize: '12.5px', color: NAVY, lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
                  Cómo se arma el saldo:{' '}
                  <b style={{ fontWeight: 600 }}>{val(sIni)}</b> inicial
                  {sIng > 0.001 && <> · <span style={{ color: VERDE }}>+{val(sIng)}</span> entró</>}
                  {sCon > 0.001 && <> · <span style={{ color: ROJO }}>−{val(sCon)}</span> se aplicó</>}
                  {' = '}<b style={{ fontWeight: 600 }}>{val(sResta)}</b>
                  {Math.abs(sAjuste) > 0.001
                    ? <> · el conteo <span style={{ color: sAjuste > 0 ? AMBAR : ROJO }}>{sAjuste > 0 ? 'sobró ' : 'faltó '}{val(Math.abs(sAjuste))}</span> · = <b style={{ fontWeight: 700 }}>{val(sFin)}</b>
                        <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px', lineHeight: 1.5 }}>El saldo sigue el conteo físico (lo que de verdad había), por eso no da la pura resta.</div></>
                    : <span style={{ color: GRIS }}> (sin ajuste de conteo)</span>}
                </div>
              )}
              {movDet === m.insumo_id && (
                <div style={{ padding: '14px 20px 16px 42px', background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: '340px' }}>
                  {!lotesMov[m.insumo_id] ? (
                    <div style={{ fontSize: '12px', color: GRIS }}>Cargando lotes...</div>
                  ) : lotesMov[m.insumo_id].length === 0 ? (
                    <div style={{ fontSize: '12px', color: GRIS }}>No hay lotes para mostrar.</div>
                  ) : (() => {
                    const rows = [...lotesMov[m.insumo_id]].sort((a, b) => ((a.fecha || '0') !== (b.fecha || '0') ? ((a.fecha || '0') < (b.fecha || '0') ? -1 : 1) : (a.es_conteo === b.es_conteo ? 0 : a.es_conteo ? -1 : 1)))
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
                          Se consume del más viejo primero{uLabel ? ` · en ${uLabel}` : ''}
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
                                {esJefe && r.costo_unitario != null && <div style={{ color: GRIS, fontSize: '11.5px' }}>{dineroExacto(r.costo_unitario)} /{(UNIDAD[m.unidad] || m.unidad || '').toLowerCase()}</div>}
                                {i === primerQueda && Number(r.queda) > 0 && <div style={{ fontSize: '10px', color: GRIS }}>se gasta primero</div>}
                                {esJefe && (
                                  <button onClick={() => iniciarCorreccion(m.insumo_id, r)}
                                    style={{ marginTop: '3px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', color: AZUL }}>
                                    Corregir precio
                                  </button>
                                )}
                              </div>
                              <div style={cel}>{val(r.entro)}</div>
                              <div style={{ ...cel, color: Number(r.consumio) ? ROJO : '#c3d0db' }}>{Number(r.consumio) ? val(r.consumio) : '—'}</div>
                              <div style={{ ...cel, fontWeight: 600 }}>{val(r.queda)}</div>
                              {esJefe && <div style={cel}>{dinero(Number(r.consumio) * Number(r.costo_unitario || 0))}</div>}
                            </Fragment>
                          ))}
                          <div style={{ ...tot, textAlign: 'left' }}>Total</div>
                          <div style={tot}>{val(tEntro)}</div>
                          <div style={tot}>{val(tCons)}</div>
                          <div style={tot}>{val(tQueda)}</div>
                          {esJefe && <div style={tot}>{dinero(tCosto)}</div>}
                        </div>
                        {esJefe && corrige && corrige.insumoId === m.insumo_id && (
                          <div style={{ marginTop: '14px', maxWidth: '720px', background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px' }}>
                            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '2px' }}>
                              Corregir precio · {corrige.esConteo ? 'Conteo' : 'Compra'} {corta(corrige.fecha)}
                            </div>
                            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '11px' }}>
                              Actual {corrige.actual != null ? dineroExacto(corrige.actual) : 's/p'} /{(UNIDAD[m.unidad] || m.unidad || '').toLowerCase()} · {PLAZO_LBL[corrige.plazo] || 'contado'}. Se recalculan solo los consumos de este insumo.
                            </div>
                            <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                              <div>
                                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Nuevo precio /{(UNIDAD[m.unidad] || m.unidad || '').toLowerCase()}</div>
                                <CampoNumero maxDec={6} autoFocus value={corrPrecio} onChange={v => setCorrPrecio(v)}
                                  style={{ ...entrada, width: '130px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderColor: '#9cc4e8' }} />
                              </div>
                              <div>
                                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Plazo</div>
                                <Seg valor={corrige.plazo}
                                     onCambio={pz => setCorrige(c => ({ ...c, plazo: pz }))}
                                     opciones={[0, 30, 60, 90, 120].map(p => [p, PLAZO_LBL[p]])} />
                              </div>
                              <div>
                                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Aplicar</div>
                                <Seg valor={corrAdelante ? 'adelante' : 'solo'}
                                     onCambio={v => setCorrAdelante(v === 'adelante')}
                                     opciones={[['solo', 'Solo este período'], ['adelante', 'De ahí en adelante']]} />
                              </div>
                            </div>
                            <div style={{ fontSize: '11.5px', color: GRIS, margin: '10px 0 12px', lineHeight: 1.5 }}>
                              {corrAdelante
                                ? 'Cambia el precio del catálogo desde esta fecha en adelante (este plazo). Afecta las compras desde aquí.'
                                : 'Corrige el precio del catálogo del período de esta compra, sin mover fechas. Solo afecta las compras de ese período.'}
                            </div>
                            <div style={{ display: 'flex', gap: '9px' }}>
                              <Btn primario onClick={guardarCorreccionPrecio} disabled={guardandoCorr}>
                                {guardandoCorr ? 'Guardando...' : 'Guardar corrección'}
                              </Btn>
                              <Btn onClick={() => setCorrige(null)}>Cancelar</Btn>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  </div>
                  {modoMov === 'fechas' && conteosRango[m.insumo_id] && conteosRango[m.insumo_id].length > 0 && (() => {
                    const cs = conteosRango[m.insumo_id]
                    return (
                      <div style={{ background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px', minWidth: '300px', maxWidth: '400px' }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 600, color: NAVY }}>Conteos en el rango</div>
                        <div style={{ fontSize: '10.5px', color: GRIS, marginBottom: '10px' }}>Qué pasó en cada conteo{uLabel ? ` · en ${uLabel}` : ''}</div>
                        {cs.map((c, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'baseline', padding: '8px 0', borderTop: i ? '0.5px solid #f1f6f9' : 'none', fontSize: '12.5px' }}>
                            <span>{corta(c.fecha)} <span style={{ color: GRIS, fontSize: '11.5px' }}>· {c.antes == null ? '' : `sistema ${val(c.antes)} → `}contó <b style={{ color: NAVY, fontWeight: 700 }}>{val(c.conto)}</b></span></span>
                            {c.dif == null ? <span /> : (
                              <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: Math.abs(c.dif) < 0.001 ? VERDE : (c.dif < 0 ? ROJO : AMBAR) }}>
                                {Math.abs(c.dif) < 0.001 ? 'Cuadró' : (c.dif < 0 ? 'Faltó ' : 'Sobró ') + val(Math.abs(c.dif))}
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
            )})}
          </Tabla>

          {renderConteosAnteriores()}
        </>

      ) : (
        <>
          {porReponer.length > 0 && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: '#FDF3F3',
                          border: '0.5px solid #f0d4d3', borderRadius: '12px', padding: '12px 15px', marginBottom: '14px' }}>
              <span style={{ color: ROJO, fontSize: '15px', lineHeight: 1.2 }}>⚠</span>
              <div style={{ fontSize: '13px', color: '#6d2b29' }}>
                <b style={{ fontWeight: 600 }}>Por reponer ({porReponer.length})</b>
                <div style={{ marginTop: '3px' }}>
                  {porReponer.map(({ f, a }) => (
                    <span key={f.insumo_id} style={{ display: 'inline-block', marginRight: '14px' }}>
                      {f.insumo}: {limpio(Math.round(a.saldoApp * 100) / 100)} / mín {limpio(a.min)} {UNIDAD[a.unidad] || a.unidad}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
          <Tabla
            caja min={esJefe ? '760px' : '620px'}
            columnas={esJefe
              ? ['Insumo', 'Llega / se aplica', 'Saldo', 'Precio', 'Valor', '']
              : ['Insumo', 'Llega / se aplica', 'Saldo', 'Equivalente']}
            anchos={esJefe ? ANCHOS_SALDO_JEFE : ANCHOS_SALDO_BOD}
            alinear={esJefe ? undefined : ['left', 'left', 'center', 'center']}
          >
            {filas.filter(f => coincide(f.insumo) && (verSinInv || !esSinInvFila(f)))
                  .sort((a, b) => (esSinInvFila(a) ? 1 : 0) - (esSinInvFila(b) ? 1 : 0))
                  .map(f => {
              const edit = editando === f.insumo_id
              const dg = desglose[f.insumo_id] || []
              const ab = abierto === f.insumo_id
              const sinInv = Math.abs(Number(f.saldo)) < 0.001 && !((lotes[f.insumo_id] || []).length)
              // Recosteable: hay algún lote SIN precio, o a un precio distinto al que rige.
              const ruling = Number(f.precio) || 0
              const recostable = esJefeGlobal && ruling > 0 &&
                (lotes[f.insumo_id] || []).some(L => L.costo == null || Math.abs(Number(L.costo) - ruling) > 0.005)
              const varios = dg.length > 1 || (dg.length === 1 && dg[0].plazo !== 0) || recostable
              return (
              <div key={f.insumo_id}>
                <Fila anchos={esJefe ? ANCHOS_SALDO_JEFE : ANCHOS_SALDO_BOD}>
                  <Celda>
                    <button onClick={() => setAbierto(ab ? null : f.insumo_id)} style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: '13px', color: NAVY, textAlign: 'left' }}>
                      <span style={{ color: GRIS, marginRight: '7px', fontSize: '11px' }}>{ab ? '▾' : '▸'}</span>{f.insumo}
                    </button>
                    {sinInv && <span style={{ fontSize: '12px', color: '#BA7517' }}> · Sin inventario</span>}
                  </Celda>
                  <Celda gris>
                    {(() => {
                      const fac = factores[f.insumo_id]
                      const pres = cap1(UNIDAD[f.unidad] || f.unidad)
                      const app = cap1(UNIDAD[fac?.uApp] || fac?.uApp)
                      const conv = fac && fac.uApp && !esUnidadGenerica(fac.uApp) && cap1(UNIDAD[fac.uApp] || fac.uApp) !== cap1(UNIDAD[f.unidad] || f.unidad)
                      return (
                        <span>
                          <span style={{ color: NAVY, fontWeight: 500 }}>{pres}</span>
                          {conv && <> <span style={{ color: '#c3d0db' }}>→</span> {app}
                            <span style={{ display: 'block', fontSize: '10px', color: GRIS }}>{fac.factor} {abrevU(fac.uApp)}</span></>}
                        </span>
                      )
                    })()}
                  </Celda>
                  {edit ? (
                    <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f6f9fb' }}>
                      <CampoNumero autoFocus maxDec={2} value={nuevoSaldo}
                        onChange={v => setNuevoSaldo(v)}
                        style={{ ...entrada, width: '100%', textAlign: 'right',
                                 fontVariantNumeric: 'tabular-nums',
                                 borderColor: '#9cc4e8' }} />
                    </div>
                  ) : (() => {
                    const fac = factores[f.insumo_id]
                    const conv = fac && fac.uApp && !esUnidadGenerica(fac.uApp) && cap1(UNIDAD[fac.uApp] || fac.uApp) !== cap1(UNIDAD[f.unidad] || f.unidad)
                    const enUso = unidadSaldo === 'aplica' && conv
                    const factor = enUso ? (fac.factor || 1) : 1
                    const uLabel = ((enUso ? (UNIDAD[fac.uApp] || fac.uApp) : (UNIDAD[f.unidad] || f.unidad)) || '').toLowerCase()
                    return (
                    <Celda derecha={esJefe} centro={!esJefe} fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{limpio(Number(f.saldo) * factor)} <span style={{ fontSize: '12px', fontWeight: 400, color: GRIS }}>{uLabel}</span></span>
                      {bajoMin(f) && <span style={{ display: 'block', fontSize: '10px', fontWeight: 500, color: ROJO }}>Bajo mínimo</span>}
                    </Celda>
                    )
                  })()}
                  {/* Bodeguero: columna Equivalente (como se aplica) en vez del toggle */}
                  {!esJefe && (() => {
                    const fac = factores[f.insumo_id]
                    const conv = fac && fac.uApp && !esUnidadGenerica(fac.uApp) && cap1(UNIDAD[fac.uApp] || fac.uApp) !== cap1(UNIDAD[f.unidad] || f.unidad)
                    if (!conv) return <Celda centro gris>—</Celda>
                    const uApp = ((UNIDAD[fac.uApp] || fac.uApp) || '').toLowerCase()
                    return (
                      <Celda centro color={AZUL}>
                        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{limpio(Number(f.saldo) * (fac.factor || 1))} <span style={{ fontSize: '12px', fontWeight: 400, color: '#a7b4c1' }}>{uApp}</span></span>
                      </Celda>
                    )
                  })()}
                  {/* Precio (una línea, con plazo corto). Detalle completo al desplegar. */}
                  {esJefe && <Celda derecha gris>{f.precio ? <span style={{ fontSize: '15px', fontWeight: 500, color: NAVY, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{dineroExacto(f.precio)}{precioInfo[f.insumo_id] ? <span style={{ color: '#a7b4c1', fontWeight: 400, fontSize: '11px' }}> · {PLAZO_LBL[precioInfo[f.insumo_id].plazo]}</span> : ''}</span> : <span style={{ color: GRIS }}>Sin precio</span>}</Celda>}
                  {esJefe && <Celda derecha><span style={{ fontSize: '15px', fontWeight: 500, color: NAVY }}>{dinero(Number(valorFifo[f.insumo_id] || 0))}</span></Celda>}
                  {esJefe && (
                    <div style={{ padding: '6px 10px', borderLeft: '0.5px solid #f6f9fb',
                                  textAlign: 'right' }}>
                      {esJefeGlobal && !edit && (sinInv
                        ? <button onClick={() => setIniForm({ insumoId: f.insumo_id, cantidad: '', fecha: hoyISO() })} style={{
                            background: '#fff', border: '0.5px solid #9cc4e8', color: AZUL, borderRadius: '8px',
                            padding: '5px 11px', fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, cursor: 'pointer' }}>Cargar inicial</button>
                        : <button onClick={() => abrirCorregir(f)} style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                            fontSize: '11px', color: GRIS, textDecoration: 'underline' }}>Corregir</button>)}
                    </div>
                  )}
                </Fila>

                {esJefeGlobal && edit && (() => {
                  const fc = factores[f.insumo_id]
                  const conv = fc && fc.uApp && !esUnidadGenerica(fc.uApp) && cap1(UNIDAD[fc.uApp] || fc.uApp) !== cap1(UNIDAD[f.unidad] || f.unidad)
                  const uC = cap1(UNIDAD[f.unidad] || f.unidad)
                  const uA = cap1(UNIDAD[fc?.uApp] || fc?.uApp)
                  return (
                  <div style={{ padding: '10px 14px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {conv && (
                        <label style={{ fontSize: '12px', color: GRIS, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          Ingresar en
                          <Seg valor={corrUnidad} onCambio={u => {
                            const v = Number(String(nuevoSaldo).replace(',', '.')) || 0
                            const enCompra = corrUnidad === 'aplica' ? v / (fc.factor || 1) : v
                            setNuevoSaldo(limpio(u === 'aplica' ? enCompra * (fc.factor || 1) : enCompra))
                            setCorrUnidad(u)
                          }} opciones={[['compra', uC], ['aplica', uA]]} />
                        </label>
                      )}
                      <span style={{ fontSize: '12px', color: GRIS }}>Motivo:</span>
                      <input value={motivo}
                        placeholder="Por qué se corrige — queda en la bitácora"
                        onChange={e => setMotivo(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && guardarCorreccion(f)}
                        style={{ ...entrada, flex: 1, minWidth: '220px' }} />
                      <label style={{ fontSize: '12px', color: GRIS, display: 'flex', alignItems: 'center', gap: '6px' }}>
                        Fecha
                        <input type="date" value={fechaAj} max={hoyISO()}
                          onChange={e => setFechaAj(e.target.value)}
                          title="Día en que ocurrió el descuadre, no siempre hoy"
                          style={{ ...entrada, width: '150px' }} />
                      </label>
                      <Btn onClick={() => setEditando(null)}>Cancelar</Btn>
                      <Btn primario onClick={() => guardarCorreccion(f)} disabled={guardandoAj}>
                        {guardandoAj ? 'Guardando...' : 'Guardar corrección'}
                      </Btn>
                    </div>
                    {corrAjustes.length > 0 && (
                      <div style={{ marginTop: '11px', fontSize: '12px', color: GRIS }}>
                        <div style={{ marginBottom: '4px' }}>Correcciones de este insumo (bórralas si fueron un error):</div>
                        {corrAjustes.map(a => (
                          <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0' }}>
                            <span>{corta(a.fecha)} · {Number(a.cantidad) > 0 ? '+' : ''}{limpio(a.cantidad)} {(UNIDAD[f.unidad] || f.unidad || '').toLowerCase()}{a.motivo ? ` · ${a.motivo}` : ''}</span>
                            <button onClick={() => borrarCorreccion(a.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '11.5px', color: ROJO }}>borrar</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )
                })()}

                {recosForm === f.insumo_id && (
                  <div style={{ background: '#f6f9fb', padding: '13px 16px', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ fontSize: '13px', color: NAVY, marginBottom: '6px' }}>
                      Recostear <b>{f.insumo}</b> al precio que rige: <b>{dineroExacto(ruling)}</b> /{cap1(UNIDAD[f.unidad] || f.unidad)}.
                    </div>
                    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '11px', lineHeight: 1.5 }}>
                      Los lotes a otro precio (o sin precio) pasan a {dineroExacto(ruling)} (mantienen su fecha de compra; cambia precio y plazo) y se recostea el consumo de este insumo. Es re-ejecutable, pero no se deshace solo.
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Btn primario onClick={() => recostear(f)} disabled={recosteando}>
                        {recosteando ? 'Recosteando...' : `Recostear a ${dineroExacto(ruling)}`}
                      </Btn>
                      <Btn onClick={() => setRecosForm(null)}>Mantener</Btn>
                    </div>
                  </div>
                )}

                {iniForm?.insumoId === f.insumo_id && (
                  <div style={{ background: '#f6f9fb', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div><div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Cantidad ({cap1(UNIDAD[f.unidad] || f.unidad)})</div><CampoNumero maxDec={2} autoFocus value={iniForm.cantidad} onChange={v => setIniForm(x => ({ ...x, cantidad: v }))} style={{ ...entrada, width: '110px', textAlign: 'right' }} /></div>
                    <div><div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Fecha</div><input type="date" value={iniForm.fecha} max={hoyISO()} onChange={e => setIniForm(x => ({ ...x, fecha: e.target.value }))} style={{ ...entrada, width: '150px' }} /></div>
                    <Btn primario onClick={guardarInicial}>Guardar inicial</Btn>
                    <Btn onClick={() => setIniForm(null)}>Cancelar</Btn>
                  </div>
                )}

                {ab && !edit && (
                  <div style={{ padding: '16px 20px 18px 42px', background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9' }}>
                    {esJefe && (lotes[f.insumo_id] || []).length > 0 && (
                      <div style={{ marginBottom: dg.length ? '12px' : 0 }}>
                        <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', marginBottom: '10px' }}>Cuánto queda a cada precio</div>
                        <div style={{ position: 'relative', paddingLeft: '20px' }}>
                          <div style={{ position: 'absolute', left: '4px', top: '8px', bottom: '8px', width: '1.5px', background: BORDE }} />
                          {[...(lotes[f.insumo_id] || [])].sort((a, b) => ((a.fecha || '0') !== (b.fecha || '0') ? ((a.fecha || '0') < (b.fecha || '0') ? -1 : 1) : (a.es_conteo === b.es_conteo ? 0 : a.es_conteo ? -1 : 1))).map((L, i) => {
                            const distinto = ruling > 0 && (L.costo == null || Math.abs(Number(L.costo) - ruling) > 0.005)
                            return (
                            <div key={i} style={{ position: 'relative', padding: '7px 0' }}>
                              <div style={{ position: 'absolute', left: '-20px', top: '12px', width: '9px', height: '9px', borderRadius: '50%', background: distinto ? '#FAEEDA' : '#fff', border: '1.5px solid ' + (distinto ? '#d9a441' : AZUL) }} />
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 600, fontSize: '13.5px', fontVariantNumeric: 'tabular-nums' }}>{limpio(L.cantidad)} {cap1(UNIDAD[f.unidad] || f.unidad)}</span>
                                <span style={{ fontSize: '11.5px', color: distinto ? '#9a6a12' : GRIS }}>{L.costo == null ? 'sin precio' : dineroExacto(L.costo)}{L.fecha && L.plazo != null ? ' · ' + (PLAZO_LBL[L.plazo] || 'contado') : ''} · {L.fecha ? 'compra ' + corta(L.fecha) : 'del conteo físico'}{distinto && L.costo != null ? ' · no es el que rige' : ''}</span>
                                {i === 0 && <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 8px', borderRadius: '20px', background: '#eaf6f0', color: '#0f6e56' }}>se gasta primero</span>}
                              </div>
                              {distinto && esJefeGlobal && (
                                <button onClick={() => setRecosForm(recosForm === f.insumo_id ? null : f.insumo_id)}
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
                        <span> {cap1(UNIDAD[f.unidad] || f.unidad)}</span>
                      </div>
                    )}
                    {esJefe && f.precio && precioInfo[f.insumo_id]?.desde && (
                      <div style={{ fontSize: '11px', color: '#a7b4c1', marginTop: dg.length ? '6px' : 0 }}>Precio que rige desde {corta(precioInfo[f.insumo_id].desde)}</div>
                    )}
                  </div>
                )}
              </div>
            )})}
            {esJefe && (
              <Fila anchos={ANCHOS_SALDO_JEFE} total>
                <Celda fuerte>Total</Celda>
                <Celda /><Celda /><Celda />
                <Celda derecha fuerte>{dinero(valorBodega)}</Celda>
                <Celda />
              </Fila>
            )}
          </Tabla>

          {renderConteosAnteriores()}
        </>
      )}
      </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Piezas de tabla
// ---------------------------------------------------------------------
function Tabla({ columnas, anchos, children, caja, min, alinear }) {
  const cuerpo = (
    <div style={{ minWidth: min || 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: anchos,
                    background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE,
                    position: 'sticky', top: 0, zIndex: 3 }}>
        {columnas.map((c, i) => (
          <div key={c} style={{ padding: '12px 18px', fontSize: '11px', fontWeight: 500,
                  color: GRIS, letterSpacing: '0.02em', textTransform: 'uppercase',
                  textAlign: alinear ? alinear[i] : (i >= 2 ? 'right' : 'left'),
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
  if (!caja) return cuerpo
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>
      {/* Scroll propio (horizontal y vertical) para que el encabezado
          sticky quede congelado al bajar dentro de la tabla. */}
      <div style={{ overflow: 'auto', maxHeight: '68vh' }}>{cuerpo}</div>
    </div>
  )
}

function Fila({ anchos, children, total }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: anchos, alignItems: 'center',
                  borderBottom: total ? 'none' : '0.5px solid #f1f6f9',
                  borderTop: total ? '0.5px solid ' + BORDE : 'none',
                  background: total ? '#fafcfd' : 'white' }}>
      {children}
    </div>
  )
}

function Celda({ children, derecha, centro, gris, fuerte, color }) {
  return (
    <div style={{ padding: '13px 18px', fontSize: '13px',
                  textAlign: centro ? 'center' : derecha ? 'right' : 'left',
                  color: color || (gris ? GRIS : NAVY),
                  fontWeight: fuerte ? 500 : 400,
                  fontVariantNumeric: (derecha || centro) ? 'tabular-nums' : 'normal' }}>
      {children}
    </div>
  )
}

function Kpi({ titulo, valor, nota, alerta }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + (alerta ? '#e8d5b0' : BORDE),
                  borderRadius: '12px', padding: '13px 15px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px',
                    letterSpacing: '0.03em', textTransform: 'uppercase' }}>{titulo}</div>
      <div style={{ fontSize: '20px', fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                    color: alerta ? AMBAR : NAVY }}>{valor}</div>
      {nota && <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px' }}>{nota}</div>}
    </div>
  )
}

function Chip({ children, on, pequeno, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: pequeno ? '6px 12px' : '8px 15px', borderRadius: '20px',
      fontFamily: 'inherit', fontSize: pequeno ? '12px' : '13px', cursor: 'pointer',
      border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
      background: on ? '#E6F1FB' : 'white',
      color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400,
    }}>{children}</button>
  )
}

function Nota({ children, color, fondo }) {
  return (
    <div style={{ background: fondo, color, borderRadius: '10px', padding: '13px 15px',
                  fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>{children}</div>
  )
}

function Etiqueta({ children }) {
  return <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{children}</div>
}

function Btn({ children, primario, ...props }) {
  return (
    <button {...props} style={{
      padding: '9px 17px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      borderRadius: '9px', cursor: props.disabled ? 'default' : 'pointer',
      border: '0.5px solid ' + (primario ? AZUL : BORDE),
      background: primario ? AZUL : 'white',
      color: primario ? 'white' : NAVY,
      opacity: props.disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}

// Los insumos vienen en unidades muy distintas: 40 sacos y 0,0265
// gramos. Mostrar siempre cuatro decimales llenaria la tabla de ceros.
function limpio(n) {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const s = v.toFixed(2).replace(/\.?0+$/, '')
  return s === '' || s === '-' ? '0' : s
}

const expBtn = { background: 'white', border: '0.5px solid #dce6ef', borderRadius: '9px', padding: '6px 11px', fontSize: '12px', fontFamily: 'inherit', color: '#022847', cursor: 'pointer' }
const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
const btnLink = { background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontFamily: 'inherit', fontSize: '13px', color: AZUL, fontWeight: 500 }

// Modal "Dar de baja" de insumos: pérdida (robo/merma/daño) de uno o varios
// insumos como ajuste NEGATIVO en ajuste_insumo (baja el saldo) + $ FIFO.
function ModalBajaIns({ finca, insumos, precioFifoDe, onCerrar, onHecho }) {
  const [filas, setFilas] = useState([{ item: '', cant: '' }])
  const [motivo, setMotivo] = useState('Robo')
  const [fecha, setFecha] = useState(hoyISO())
  const [guardando, setGuardando] = useState(false)
  const [err, setErr] = useState('')
  const fmt = n => Number(n || 0).toLocaleString('es-EC', { maximumFractionDigits: 2 })
  const itemDe = id => insumos.find(x => x.insumo_id === id)
  const uDe = id => { const p = itemDe(id); return p ? String(UNIDAD[p.unidad] || p.unidad || 'u').toLowerCase() : '' }
  const setFila = (i, patch) => setFilas(fs => fs.map((f, k) => k === i ? { ...f, ...patch } : f))
  const addFila = () => setFilas(fs => [...fs, { item: '', cant: '' }])
  const rmFila = i => setFilas(fs => fs.length > 1 ? fs.filter((_, k) => k !== i) : fs)
  const perdidaDe = f => { const n = numDec(f.cant); return (f.item && n > 0) ? n * precioFifoDe(f.item) : 0 }
  const total = filas.reduce((t, f) => t + perdidaDe(f), 0)
  async function guardar() {
    setErr('')
    const validas = filas.filter(f => f.item && numDec(f.cant) > 0)
    if (!validas.length) { setErr('Agrega al menos un insumo con cantidad.'); return }
    for (const f of validas) { const p = itemDe(f.item), n = numDec(f.cant); if (p && n > Number(p.saldo) + 0.001) { setErr(`${p.insumo}: solo hay ${fmt(p.saldo)} ${uDe(f.item)}.`); return } }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { setErr('Pon la fecha.'); return }
    setGuardando(true)
    const rows = validas.map(f => ({ finca_id: finca.id, fecha, insumo_id: f.item, cantidad: -numDec(f.cant), motivo, precio_unitario: precioFifoDe(f.item) }))
    const { error } = await supabase.schema('produccion').from('ajuste_insumo').insert(rows)
    setGuardando(false)
    if (error) { setErr(error.message); return }
    onHecho(`Baja: ${rows.length} ${rows.length === 1 ? 'insumo' : 'insumos'} · ${motivo} · ${dinero(total)}`)
  }
  const inp = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid #dce6ef', borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
  const btn = { padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid #dce6ef', borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
  const lnk = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: '12.5px', color: AZUL, fontWeight: 500 }
  const lbl = { fontSize: '12px', color: GRIS, marginBottom: '4px', display: 'block' }
  return (
    <div onClick={onCerrar} style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '16px' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: '14px', padding: '20px 22px', width: '580px', maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(2,40,71,.28)' }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: NAVY }}>Dar de baja</div>
        <div style={{ fontSize: '12px', color: GRIS, margin: '3px 0 16px' }}>Registra una pérdida (robo, merma, daño) de uno o varios insumos. Baja el saldo y se costea FIFO.</div>
        <div style={{ display: 'flex', gap: '12px', marginBottom: '14px' }}>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Motivo</label>
            <select value={motivo} onChange={e => setMotivo(e.target.value)} style={{ ...inp, width: '100%' }}>
              {MOTIVOS_DESCUADRE.filter(m => m !== 'Error de registro').map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Fecha</label>
            <input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={{ ...inp, width: '100%' }} />
          </div>
        </div>
        <label style={lbl}>Insumos</label>
        {filas.map((f, i) => {
          const usados = new Set(filas.map((x, k) => k !== i ? x.item : null).filter(Boolean))
          const per = perdidaDe(f)
          return (
            <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
              <select value={f.item} onChange={e => setFila(i, { item: e.target.value })} style={{ ...inp, flex: 2, minWidth: 0 }}>
                <option value="">Elegir insumo…</option>
                {insumos.filter(x => !usados.has(x.insumo_id)).map(x => <option key={x.insumo_id} value={x.insumo_id}>{x.insumo} ({fmt(x.saldo)})</option>)}
              </select>
              <CampoNumero maxDec={2} value={f.cant} onChange={v => setFila(i, { cant: v })} placeholder="cant." style={{ ...inp, width: '80px', textAlign: 'right' }} />
              <span style={{ width: '58px', fontSize: '11.5px', color: GRIS }}>{uDe(f.item)}</span>
              <span style={{ width: '90px', textAlign: 'right', fontSize: '12.5px', color: per > 0 ? ROJO : '#c3d0db', fontVariantNumeric: 'tabular-nums' }}>{per > 0 ? dinero(per) : '—'}</span>
              <button onClick={() => rmFila(i)} disabled={filas.length === 1} style={{ ...lnk, color: filas.length === 1 ? '#c3d0db' : ROJO, fontSize: '16px', width: '20px' }}>✕</button>
            </div>
          )
        })}
        <button onClick={addFila} style={{ ...lnk, marginTop: '2px' }}>+ Agregar otro insumo</button>
        <div style={{ background: '#FBEAEA', border: '1px solid #e7cccb', borderRadius: '10px', padding: '11px 14px', fontSize: '14px', color: ROJO, margin: '16px 0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Total de la pérdida</span><b>{dinero(total)}</b>
        </div>
        {err && <div style={{ color: ROJO, fontSize: '12.5px', marginBottom: '10px' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '9px' }}>
          <button onClick={onCerrar} style={{ ...btn }}>Cancelar</button>
          <button onClick={guardar} disabled={guardando} style={{ ...btn, background: ROJO, color: 'white', borderColor: ROJO, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : 'Dar de baja'}</button>
        </div>
      </div>
    </div>
  )
}
