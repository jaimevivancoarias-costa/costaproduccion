import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import {
  hoyISO, lunesDe, sumarDias, semanaDe, corta, cortita,
  nombreDia, semanaISO, situacionDia, numDec, miles, dinero, diasCultivo,
} from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'

// Registro diario de insumos · modulo Produccion
//
// Se parece al de balanceado, pero con una diferencia que manda en el
// diseno: una piscina puede recibir VARIOS insumos el mismo dia. Por
// eso la celda de un dia no es un dato, es una lista de lineas.
//
// Vacio significa vacio: que una piscina no reciba insumos un dia es
// lo normal, no un olvido. No hay "no aplico" ni bloquea el cierre.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const HOYB = '#F3F8FD'
const VERDE = '#0F6E56'

const UNIDAD = {
  sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'g',
  libras: 'lb', kg: 'kg', unidad: 'u',
}

const ordenar = (a, b) => {
  const na = parseInt(String(a.codigo).replace(/\D/g, '')) || 0
  const nb = parseInt(String(b.codigo).replace(/\D/g, '')) || 0
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return na - nb
}

export default function RegistroInsumos({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const [piscinas, setPiscinas] = useState([])
  const [insumos, setInsumos] = useState([])
  const [lineas, setLineas] = useState({})   // `${piscinaId}|${fecha}` -> [{id, insumoId, cantidad}]
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [abierta, setAbierta] = useState(null)  // celda con el agregador abierto
  const [abiertaP, setAbiertaP] = useState(null)  // piscina con el detalle (Fases) abierto
  const [semanaCerrada, setSemanaCerrada] = useState(false)
  const [validaciones, setValidaciones] = useState(null)
  const [dias, setDias] = useState({})   // fecha -> estado del dia (cerrado/borrador/reabierto)
  const [diasId, setDiasId] = useState({})
  const [solReapertura, setSolReapertura] = useState([])
  const [userId, setUserId] = useState(null)
  const [cerrandoDia, setCerrandoDia] = useState(false)
  const [saldoIns, setSaldoIns] = useState({})    // insumo_id -> saldo (unidad de compra)
  const [filtros, setFiltros] = useState([])  // ids de insumos a filtrar (varios)
  const [factorIns, setFactorIns] = useState({})  // insumo_id -> factor (app por compra)

  // Disponible en unidad de aplicación, y nombre del insumo.
  const dispApp = id => (saldoIns[id] || 0) * (factorIns[id] || 1)
  const nombreIns = id => insumos.find(i => i.id === id)?.nombre || 'insumo'
  const uds = id => UNIDAD[insumos.find(i => i.id === id)?.unidad] || ''

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const semanaDeHoy = lunesDe(hoy) === lunes
  const domingo = fechas[6]
  const corteDias = fechas[6] > hoy ? hoy : fechas[6]   // hasta hoy si la semana no ha terminado

  // El bodeguero edita su semana actual, y también una anterior si el jefe
  // la reabrió (semana no cerrada). Como las viejas están cerradas, no
  // cerrada + no futura + día no cerrado ya significa eso.
  const puedeEditar = f =>
    !soloLectura && !semanaCerrada && situacionDia(f, hoy) !== 'futuro' && dias[f] !== 'cerrado'

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: ps, error: eP }, { data: ins }, { data: cs }, { data: ov }, { data: saldosI }] = await Promise.all([
        supabase.schema('produccion').from('piscina')
          .select('id, codigo, nombre, hectareas, tipo, es_reservorio')
          .eq('finca_id', finca.id).eq('activa', true),
        supabase.schema('produccion').from('insumo')
          .select('id, nombre, unidad, unidad_compra, factor').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('ciclo')
          .select('id, piscina_origen_id, fecha_siembra, fecha_ocupacion, fecha_cierre')
          .eq('finca_id', finca.id),
        supabase.schema('produccion').from('insumo_finca')
          .select('insumo_id, unidad, factor').eq('finca_id', finca.id),
        supabase.schema('produccion').rpc('fn_saldo_insumo', { p_finca: finca.id, p_hasta: domingo }),
      ])
      if (eP) throw eP
      // Unidad por finca: si esta finca tiene override, se usa esa.
      const over = {}; (ov || []).forEach(x => { over[x.insumo_id] = x.unidad })
      const insFinca = (ins || []).map(i => ({ ...i, unidad: over[i.id] || i.unidad }))
      // Factor por insumo (override de finca o base). Convierte saldo (unidad
      // de compra) a unidad de aplicación: disponible_app = saldo × factor.
      const facM = {}; (ins || []).forEach(i => { facM[i.id] = Number(i.factor) || 1 })
      ;(ov || []).forEach(x => { if (x.factor != null) facM[x.insumo_id] = Number(x.factor) || 1 })
      setFactorIns(facM)
      const si = {}; (saldosI || []).forEach(r => { si[r.insumo_id] = Number(r.saldo) })
      setSaldoIns(si)

      const lista = (ps || []).map(p => {
        // El ciclo que cubre la semana, para colgarle el consumo. Si no
        // hay (piscina en preparacion), va null y el trigger lo pega a
        // la siembra siguiente.
        const c = (cs || []).find(x => x.piscina_origen_id === p.id
          && x.fecha_siembra <= domingo
          && (!x.fecha_cierre || x.fecha_cierre >= lunes))
        // "Secado": cosecha del cultivo anterior en esta misma piscina.
        const ocup0 = c?.fecha_ocupacion || c?.fecha_siembra
        const prevCierre = c ? (cs || [])
          .filter(x => x.piscina_origen_id === p.id && x.fecha_cierre && (!ocup0 || x.fecha_cierre < ocup0))
          .reduce((mx, x) => (!mx || x.fecha_cierre > mx ? x.fecha_cierre : mx), null) : null
        return {
          piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
          hectareas: Number(p.hectareas), tipo: p.tipo, esReservorio: p.es_reservorio,
          cicloId: c?.id || null,
          fechaSiembra: c?.fecha_siembra || null,
          fechaOcupacion: c?.fecha_ocupacion || c?.fecha_siembra || null,
          fechaCierre: c?.fecha_cierre || null,
          prevCierre,
        }
      }).sort((a, b) => (a.esReservorio ? 1 : 0) - (b.esReservorio ? 1 : 0) || ordenar(a, b))
      setPiscinas(lista)
      setInsumos(insFinca)

      const ids = lista.map(p => p.piscinaId)
      const mapa = {}
      if (ids.length) {
        const { data: co, error: eC } = await supabase.schema('produccion')
          .from('consumo_insumo')
          .select('id, piscina_id, fecha, insumo_id, cantidad, precio_unitario')
          .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
        if (eC) throw eC
        ;(co || []).forEach(r => {
          const k = `${r.piscina_id}|${r.fecha}`
          ;(mapa[k] = mapa[k] || []).push(
            { id: r.id, insumoId: r.insumo_id, cantidad: r.cantidad, precio: r.precio_unitario })
        })
      }
      setLineas(mapa)

      const { data: dr } = await supabase.schema('produccion').from('dia_registro')
        .select('id, fecha, estado').eq('finca_id', finca.id).eq('ambito', 'insumos')
        .gte('fecha', lunes).lte('fecha', domingo)
      const de = {}, di = {}; (dr || []).forEach(r => { de[r.fecha] = r.estado; di[r.fecha] = r.id })
      setDias(de); setDiasId(di)

      const idsDia = Object.values(di).filter(Boolean)
      if (idsDia.length) {
        const { data: sr } = await supabase.schema('produccion').from('solicitud_correccion')
          .select('id, registro_id, valor_propuesto, motivo, estado')
          .eq('finca_id', finca.id).eq('tabla', 'dia_registro').eq('estado', 'pendiente')
          .in('registro_id', idsDia)
        setSolReapertura(sr || [])
      } else { setSolReapertura([]) }
      const { data: au } = await supabase.auth.getUser()
      setUserId(au?.user?.id || null)

      const { anio, semana } = semanaISO(lunes)
      const { data: sc } = await supabase.schema('produccion').from('semana_cerrada')
        .select('id').eq('finca_id', finca.id).eq('anio', anio).eq('semana', semana)
        .eq('ambito', 'insumos').maybeSingle()
      setSemanaCerrada(!!sc)
      setValidaciones(null)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, domingo])

  async function revisarSemana() {
    setValidaciones('cargando')
    const { data, error } = await supabase.schema('produccion')
      .rpc('fn_validar_semana', { p_finca: finca.id, p_lunes: lunes })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); setValidaciones(null); return }
    // Aqui solo cuentan las validaciones de insumos. Las de balanceado
    // se revisan y se cierran en su propia pestana.
    setValidaciones((data || []).filter(v => v.codigo === 'V7' || v.codigo === 'V8'))
  }

  const [guardandoBorrador, setGuardandoBorrador] = useState(false)
  async function guardarBorrador() {
    // Todo se guarda solo al agregar cada insumo; esto refresca y confirma.
    setGuardandoBorrador(true)
    await cargar()
    setGuardandoBorrador(false)
    setAviso({ tipo: 'ok', texto: 'Borrador guardado.' })
  }

  async function cerrarDiaHoy() {
    setCerrandoDia(true)
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha: hoy, ambito: 'insumos', estado: 'cerrado', cerrado_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    setCerrandoDia(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo cerrar el día. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Día de insumos cerrado.' }); await cargar()
  }

  // Cerrar de una vez los días anteriores de la semana que quedaron
  // abiertos. Lo puede hacer el bodeguero (llena cada dos días). Hoy no
  // se toca aquí: para eso está "Guardar y cerrar día".
  async function cerrarDiasPendientes() {
    const faltan = fechas.filter(f => dias[f] !== 'cerrado' && dias[f] !== 'reabierto'
                                      && f !== hoy && situacionDia(f, hoy) !== 'futuro')
    if (!faltan.length) return
    if (!window.confirm(
      `Vas a cerrar ${faltan.length} días de insumos: ${faltan.map(f => `${nombreDia(f).slice(0, 3)} ${corta(f).slice(0, 5)}`).join(', ')}.`)) return
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert(faltan.map(f => ({ finca_id: finca.id, fecha: f, ambito: 'insumos', estado: 'cerrado',
                                 cerrado_en: new Date().toISOString() })),
              { onConflict: 'finca_id,fecha,ambito' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${faltan.length} días cerrados` }); await cargar()
  }

  // Cerrar un solo día (seleccionable).
  async function cerrarUnDia(fecha) {
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha, ambito: 'insumos', estado: 'cerrado', cerrado_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${nombreDia(fecha)} cerrado` }); await cargar()
  }

  // El jefe reabre directo; el bodeguero pide y el jefe autoriza.
  async function reabrirDiaHoy() {
    setCerrandoDia(true)
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha: hoy, ambito: 'insumos', estado: 'reabierto', reabierto_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    setCerrandoDia(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir el día. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Día reabierto.' }); await cargar()
  }

  // Reabrir un día cerrado cualquiera (no solo hoy). Solo jefe/contadora.
  async function reabrirDia(fecha) {
    if (!window.confirm(`¿Reabrir el ${nombreDia(fecha).toLowerCase()} ${corta(fecha)}? Vuelve a quedar editable.`)) return
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha, ambito: 'insumos', estado: 'reabierto', reabierto_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: `${nombreDia(fecha)} reabierto` }); await cargar()
  }

  async function pedirReabrirHoy() {
    const id = diasId[hoy]
    if (!id) return
    const motivo = window.prompt('¿Por qué necesitas reabrir los insumos de hoy? El jefe lo revisará.')
    if (!motivo || !motivo.trim()) return
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'dia_registro', registro_id: id,
      valor_anterior: { estado: 'cerrado' }, valor_propuesto: { estado: 'reabierto', fecha: hoy, ambito: 'insumos' },
      motivo: motivo.trim(), solicitado_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido enviado. El jefe lo revisará.' }); await cargar()
  }

  async function resolverReapertura(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Día reabierto.' : 'Pedido rechazado.' }); await cargar()
  }

  async function cerrarSemana() {
    const { anio, semana } = semanaISO(lunes)
    const { error } = await supabase.schema('produccion').from('semana_cerrada')
      .insert({ finca_id: finca.id, anio, semana, ambito: 'insumos', validaciones })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Insumos de la semana cerrados' })
    await cargar()
  }

  // Reabrir la semana de insumos. Solo jefe/contadora (esJefe).
  async function reabrirSemana() {
    const { anio, semana } = semanaISO(lunes)
    if (!window.confirm('¿Reabrir los insumos de toda la semana? Vuelve a quedar editable para la finca (todos los días).')) return
    const { error } = await supabase.schema('produccion').from('semana_cerrada')
      .delete().eq('finca_id', finca.id).eq('anio', anio).eq('semana', semana).eq('ambito', 'insumos')
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir. ' + error.message }); return }
    // Reabrir también los DÍAS cerrados de esa semana (si solo se quita el
    // cierre de la semana, los días cerrados siguen bloqueados y no se
    // pueden editar los que sí tuvieron consumo).
    const { error: eDias } = await supabase.schema('produccion').from('dia_registro')
      .update({ estado: 'reabierto' })
      .eq('finca_id', finca.id).eq('ambito', 'insumos').eq('estado', 'cerrado')
      .gte('fecha', lunes).lte('fecha', domingo)
    if (eDias) { setAviso({ tipo: 'error', texto: 'Semana reabierta, pero no los días. ' + eDias.message }); await cargar(); return }
    setAviso({ tipo: 'ok', texto: 'Semana y días reabiertos' })
    await cargar()
  }

  // Consumo de la semana por insumo, para la pregunta directa "cuánto
  // se gastó de cada cosa esta semana".
  const consumoSemana = useMemo(() => {
    const m = {}
    Object.values(lineas).flat().forEach(l => {
      m[l.insumoId] = (m[l.insumoId] || 0) + numDec(l.cantidad)
    })
    return Object.entries(m)
      .map(([id, cant]) => ({ id, cant }))
      .sort((a, b) => b.cant - a.cant)
  }, [lineas])

  // Resumen de la semana para las tarjetas de arriba.
  const resumen = useMemo(() => {
    const insumosUsados = new Set()
    const piscinasConMov = new Set()
    let gasto = 0
    Object.entries(lineas).forEach(([k, arr]) => {
      if (arr.length) piscinasConMov.add(k.split('|')[0])
      arr.forEach(l => {
        insumosUsados.add(l.insumoId)
        gasto += numDec(l.cantidad) * Number(l.precio || 0)
      })
    })
    return { insumos: insumosUsados.size, piscinas: piscinasConMov.size, gasto }
  }, [lineas])

  useEffect(() => { cargar() }, [cargar])

  const nombreInsumo = id => insumos.find(x => x.id === id)?.nombre || ''
  // Unidad para mostrar. Si la de uso es genérica ("unidad"), no se muestra
  // "u": se usa cómo se compra (saco, funda…) o, si no, "unidades".
  const unidadInsumo = id => {
    const ins = insumos.find(x => x.id === id)
    if (!ins) return ''
    if (!ins.unidad || ins.unidad === 'unidad') {
      if (ins.unidad_compra && ins.unidad_compra !== 'unidad') return UNIDAD[ins.unidad_compra] || ins.unidad_compra
      return 'unidades'
    }
    return UNIDAD[ins.unidad] || ins.unidad
  }
  // "Equivale a": la misma cantidad pero como se compra (cant / factor). Solo
  // cuando la unidad de uso es real (no "unidad" genérica) y distinta de la de
  // compra; si no, no hay conversión que mostrar.
  const equivaleCompra = (id, cant) => {
    const ins = insumos.find(x => x.id === id)
    if (!ins || ins.unidad === 'unidad' || !ins.unidad_compra || ins.unidad_compra === ins.unidad) return null
    const fac = factorIns[id] || 1
    return { cant: cant / fac, u: UNIDAD[ins.unidad_compra] || ins.unidad_compra }
  }
  const cel = (p, f) => lineas[`${p.piscinaId}|${f}`] || []
  // Filtro: piscinas que aplicaron alguno de los insumos elegidos en la semana.
  const hayFiltro = filtros.length > 0
  const piscTieneIns = (p) => fechas.some(f => cel(p, f).some(l => filtros.includes(l.insumoId)))
  const visibles = hayFiltro ? piscinas.filter(piscTieneIns) : piscinas

  // Se guarda linea por linea: son pocas por celda y evita el baile de
  // diffing de todo el grid. Optimista: se pinta y si falla se revierte.
  async function agregar(p, f, insumoId, cantidad) {
    const cant = numDec(cantidad)
    if (!insumoId || !cant) return
    const k = `${p.piscinaId}|${f}`
    const yaHay = (lineas[k] || []).find(l => l.insumoId === insumoId)
    if (yaHay) {
      setAviso({ tipo: 'error', texto: 'Ese insumo ya está en ese día. Edita la cantidad.' })
      return
    }
    // Chequeo de STOCK: no se puede consumir más de lo que hay en bodega.
    const disp = dispApp(insumoId)
    if (cant > disp + 0.0001) {
      setAviso({ tipo: 'error', texto: `Sin stock suficiente de ${nombreIns(insumoId)}: hay ${miles(Math.round(disp * 100) / 100)} ${uds(insumoId)}, quieres consumir ${miles(cant)}. Ingresa a bodega primero.` })
      return
    }
    const fila = { piscina_id: p.piscinaId, fecha: f, insumo_id: insumoId,
                   ciclo_id: p.cicloId, cantidad: cant }
    const { data, error } = await supabase.schema('produccion').from('consumo_insumo')
      .insert(fila).select('id').single()
    if (error) {
      // Ya existe un consumo de ese insumo en esa piscina/fecha (guardado antes,
      // no cargado en pantalla): se avisa claro y se recarga para poder editarlo.
      if (/duplicate|unique/i.test(error.message)) {
        setAviso({ tipo: 'error', texto: 'Ya hay un consumo de ese insumo en esa piscina y día (estaba guardado pero no se veía). Recargué la pantalla: edita la cantidad existente en vez de agregarlo de nuevo.' })
        setAbierta(null); await cargar(); return
      }
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return
    }
    setLineas(m => ({ ...m, [k]: [...(m[k] || []), { id: data.id, insumoId, cantidad: cant }] }))
    // Descuenta del saldo en vivo (en unidad de compra), para el próximo chequeo.
    setSaldoIns(s => ({ ...s, [insumoId]: (s[insumoId] || 0) - cant / (factorIns[insumoId] || 1) }))
    setAbierta(null)
  }

  async function cambiarCantidad(k, id, valor) {
    const linea = (lineas[k] || []).find(l => l.id === id)
    const antes = numDec(linea?.cantidad)
    const cant = numDec(valor)
    // Solo se chequea si SUBE. La diferencia extra no puede superar lo disponible.
    if (cant && linea && cant - antes > dispApp(linea.insumoId) + 0.0001) {
      setAviso({ tipo: 'error', texto: `Sin stock suficiente de ${nombreIns(linea.insumoId)}: hay ${miles(Math.round(dispApp(linea.insumoId) * 100) / 100)} ${uds(linea.insumoId)} más disponibles.` })
      return
    }
    setLineas(m => ({ ...m, [k]: m[k].map(l => l.id === id ? { ...l, cantidad: valor } : l) }))
    if (!cant) return
    await supabase.schema('produccion').from('consumo_insumo')
      .update({ cantidad: cant, actualizado_en: new Date().toISOString() }).eq('id', id)
    if (linea) setSaldoIns(s => ({ ...s, [linea.insumoId]: (s[linea.insumoId] || 0) - (cant - antes) / (factorIns[linea.insumoId] || 1) }))
  }

  async function quitar(k, id) {
    const antes = lineas[k]
    const linea = (antes || []).find(l => l.id === id)
    setLineas(m => ({ ...m, [k]: m[k].filter(l => l.id !== id) }))
    const { error } = await supabase.schema('produccion').from('consumo_insumo').delete().eq('id', id)
    if (error) { setLineas(m => ({ ...m, [k]: antes })); setAviso({ tipo: 'error', texto: error.message }); return }
    // Devuelve al saldo lo que se había consumido.
    if (linea) setSaldoIns(s => ({ ...s, [linea.insumoId]: (s[linea.insumoId] || 0) + numDec(linea.cantidad) / (factorIns[linea.insumoId] || 1) }))
  }

  const COLS = `180px repeat(7, minmax(190px, 1fr))`

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem', background: '#eef2f6', minHeight: '100%' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Insumos de la semana</h1>
            {semanaCerrada
              ? <span style={{ background: '#eef2f5', color: GRIS, fontSize: '11px', fontWeight: 500,
                               padding: '3px 10px', borderRadius: '20px' }}>Semana cerrada</span>
              : <span style={{ background: '#E1F5EE', color: '#0F6E56', fontSize: '11px', fontWeight: 500,
                               padding: '3px 10px', borderRadius: '20px' }}>
                  {semanaDeHoy ? 'Semana en curso' : 'Semana anterior'}</span>}
          </div>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana {semanaISO(lunes).semana} · {cortita(lunes)} – {cortita(domingo)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
          <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
          <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
          <input type="date" value={lunes} max={hoy}
                 onChange={e => e.target.value && setLunes(lunesDe(e.target.value))}
                 style={{ padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
                          border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }} />
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      {/* Semana cerrada: aviso claro con Reabrir (jefe/contadora). */}
      {!cargando && semanaCerrada && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
                      padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
                      background: '#FAEEDA', color: '#854F0B' }}>
          <span>Los insumos de esta semana están cerrados.{' '}
            {esJefe ? 'Puedes reabrirla para corregir.' : 'Para corregir, pide a tu jefe que la reabra.'}</span>
          {esJefe && !soloLectura && (
            <button onClick={reabrirSemana}
              style={{ background: 'white', border: '0.5px solid #ecd9b3', borderRadius: '8px',
                       padding: '6px 14px', fontFamily: 'inherit', fontSize: '13px', color: '#854F0B', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Reabrir semana
            </button>
          )}
        </div>
      )}

      {/* Semana anterior abierta: se puede editar y cerrar (el panel de cierre está abajo). */}
      {!cargando && !semanaCerrada && !semanaDeHoy && !soloLectura && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
                      background: '#F4F7FA', color: GRIS }}>
          Estás en una semana anterior. Puedes editar los insumos y cerrarla desde el panel de abajo.
        </div>
      )}


      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '10px' }}>
        Una piscina puede recibir varios insumos el mismo día. Que un día quede vacío es normal.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: GRIS }}>Ver:</span>
        <div style={{ marginLeft: 'auto' }}>
          <FiltroInsumos opciones={insumos} valor={filtros} onCambio={setFiltros} nPisc={visibles.length} />
        </div>
      </div>

      {cargando ? (
        <div style={{ padding: '40px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>
          Cargando la semana...
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', boxShadow: '0 1px 4px rgba(2,40,71,.07)' }}>
          <div style={{ minWidth: '1500px' }}>
            {/* Encabezado */}
            <div style={{ display: 'grid', gridTemplateColumns: COLS, borderBottom: '0.5px solid ' + BORDE,
                          background: '#f6f9fb', position: 'sticky', top: 0 }}>
              <Th pegado>Piscina</Th>
              {fechas.map(f => (
                <Th key={f} hoy={situacionDia(f, hoy) === 'hoy'}>
                  <div style={{ textTransform: 'capitalize' }}>{nombreDia(f)}</div>
                  <div style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}>{cortita(f)}</div>
                </Th>
              ))}
            </div>

            {visibles.map(p => {
              const hayFases = !!(p.cicloId && p.fechaSiembra)
              const abiertoP = abiertaP === p.piscinaId
              return (
              <Fragment key={p.piscinaId}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS,
                    borderBottom: '0.5px solid #f1f6f9', alignItems: 'stretch' }}>
                <div style={{ padding: '10px 12px', position: 'sticky', left: 0, background: 'white',
                              borderRight: '0.5px solid #f1f6f9' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {hayFases && (
                      <button onClick={() => setAbiertaP(abiertoP ? null : p.piscinaId)}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9fb0bf', fontSize: '11px', padding: 0, lineHeight: 1 }}>
                        {abiertoP ? '▾' : '▸'}</button>
                    )}
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>{p.nombre}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: GRIS, marginLeft: hayFases ? '17px' : 0 }}>
                    {p.esReservorio ? 'Reservorio · solo insumos' : `${p.hectareas.toFixed(2)} ha · ${p.tipo === 'precria' ? 'precría' : (p.cicloId ? 'con ciclo' : 'preparación')}`}
                  </div>
                </div>
                {fechas.map(f => {
                  const k = `${p.piscinaId}|${f}`
                  const ls = cel(p, f)
                  const edit = puedeEditar(f)
                  const abriendo = abierta === k
                  // Con filtro activo, en lectura solo se ven los insumos filtrados.
                  const lsLect = hayFiltro ? ls.filter(l => filtros.includes(l.insumoId)) : ls
                  return (
                    <div key={f} style={{ padding: '7px 8px',
                          background: situacionDia(f, hoy) === 'hoy' ? HOYB
                                    : situacionDia(f, hoy) === 'futuro' ? '#fbfcfd' : 'white',
                          borderLeft: '0.5px solid #f6f9fb' }}>
                      {edit && ls.map(l => (
                        <div key={l.id} style={{ background: 'white', border: '1px solid ' + BORDE,
                              borderRadius: '9px', padding: '7px 9px', marginBottom: '6px' }}>
                          <div style={{ fontSize: '11px', color: NAVY, fontWeight: 600,
                                        marginBottom: '4px', lineHeight: 1.2 }}>
                            {nombreInsumo(l.insumoId)}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <CampoNumero value={l.cantidad}
                              onChange={v => cambiarCantidad(k, l.id, v)}
                              style={{ width: '56px', fontFamily: 'inherit', fontSize: '12px',
                                       padding: '4px 6px', textAlign: 'right', border: '0.5px solid ' + BORDE,
                                       borderRadius: '6px', fontVariantNumeric: 'tabular-nums' }} />
                            <span style={{ fontSize: '11px', color: GRIS, flex: 1 }}>
                              {unidadInsumo(l.insumoId)}
                            </span>
                            <button onClick={() => quitar(k, l.id)} title="Quitar"
                              style={{ border: 'none', background: 'none', cursor: 'pointer',
                                       color: '#c3d0db', fontSize: '15px', lineHeight: 1, padding: 0 }}>×</button>
                          </div>
                        </div>
                      ))}
                      {!edit && lsLect.map((l, li) => (
                        <div key={l.id} style={{ textAlign: 'center', lineHeight: 1.3,
                              ...(li > 0 ? { borderTop: '1px dashed ' + BORDE, paddingTop: '6px', marginTop: '6px' } : {}) }}>
                          <div style={{ fontSize: '11px', color: GRIS }}>{nombreInsumo(l.insumoId)}</div>
                          <div style={{ fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
                            <b style={{ fontWeight: 600 }}>{miles(numDec(l.cantidad))}</b>{' '}
                            <span style={{ fontSize: '10px', color: '#9fb0bf' }}>{unidadInsumo(l.insumoId)}</span>
                          </div>
                        </div>
                      ))}

                      {edit && (abriendo ? (
                        <Agregar
                          insumos={insumos}
                          usados={ls.map(l => l.insumoId)}
                          onGuardar={(insumoId, cant) => agregar(p, f, insumoId, cant)}
                          onCerrar={() => setAbierta(null)}
                        />
                      ) : (
                        <button onClick={() => setAbierta(k)} style={{
                          border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          fontSize: '11px', color: AZUL, padding: '2px 0' }}>
                          + Agregar
                        </button>
                      ))}

                      {!lsLect.length && !edit && (
                        <div style={{ fontSize: '11px', color: '#c3d0db', textAlign: 'center' }}>—</div>
                      )}
                    </div>
                  )
                })}
              </div>
              {abiertoP && hayFases && (
                <div style={{ borderBottom: '0.5px solid #f1f6f9', background: '#f7fafc' }}>
                  <div style={{ position: 'sticky', left: 0, width: 'fit-content', padding: '12px 16px' }}>
                    <div style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '.03em', color: '#9fb0bf', fontWeight: 600, marginBottom: '3px' }}>Fases</div>
                    <div style={{ fontSize: '14px' }}>{(() => {
                      if (p.tipo === 'precria') return `${diasCultivo(p.fechaSiembra, corteDias)} días en precría`
                      const ocup = p.fechaOcupacion || p.fechaSiembra
                      const precria = ocup !== p.fechaSiembra ? diasCultivo(p.fechaSiembra, ocup) : 0
                      const engorde = diasCultivo(ocup, corteDias)
                      const secado = p.prevCierre ? diasCultivo(p.prevCierre, ocup) : 0
                      const partes = []
                      if (precria > 0) partes.push(`${precria} en precría`)
                      partes.push(`${engorde} de engorde`)
                      if (secado > 0) partes.push(`${secado} de secado`)
                      return partes.join(' · ')
                    })()}</div>
                  </div>
                </div>
              )}
              </Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* Barra de guardar / cerrar día (arriba del desglose). */}
      {!cargando && semanaDeHoy && !soloLectura && !semanaCerrada && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Los insumos se guardan solos al agregarlos.{' '}
            {dias[hoy] === 'cerrado'
              ? 'El día de hoy está cerrado.'
              : 'Cuando termines de cargar el día, ciérralo.'}
          </div>
          {dias[hoy] === 'cerrado' ? (
            esJefe
              ? <Btn disabled={cerrandoDia} onClick={reabrirDiaHoy}>{cerrandoDia ? 'Un momento...' : 'Reabrir día de hoy'}</Btn>
              : solReapertura.some(x => x.registro_id === diasId[hoy])
                ? <span style={{ fontSize: '13px', color: '#BA7517' }}>Pedido de reapertura enviado</span>
                : <Btn onClick={pedirReabrirHoy}>Pedir reabrir</Btn>
          ) : (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Btn onClick={guardarBorrador} disabled={guardandoBorrador}>{guardandoBorrador ? 'Guardando...' : 'Guardar borrador'}</Btn>
              <button onClick={cerrarDiaHoy} disabled={cerrandoDia} style={{
                padding: '9px 18px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + AZUL, borderRadius: '9px', background: AZUL, color: 'white',
                cursor: cerrandoDia ? 'default' : 'pointer', opacity: cerrandoDia ? 0.6 : 1 }}>
                {cerrandoDia ? 'Cerrando...' : 'Guardar y cerrar día'}
              </button>
            </div>
          )}
        </div>
      )}

      {!cargando && consumoSemana.length > 0 && (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '16px 18px', marginTop: '34px', boxShadow: '0 1px 4px rgba(2,40,71,.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>Consumo de insumos de la semana</h3>
            <span style={{ fontSize: '12px', color: GRIS }}>{cortita(lunes)} – {cortita(domingo)}</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead><tr>
              {['Insumo', 'Cantidad', 'Equivale a'].map((t, i) => (
                <th key={t} style={{ width: i === 0 ? '46%' : '27%', textAlign: i === 0 ? 'left' : 'right',
                      fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.03em', color: '#9fb0bf',
                      fontWeight: 600, padding: '0 12px 9px', borderBottom: '1px solid ' + BORDE }}>{t}</th>
              ))}
            </tr></thead>
            <tbody>
              {consumoSemana.map(c => {
                const eq = equivaleCompra(c.id, c.cant)
                return (
                  <tr key={c.id}>
                    <td style={{ padding: '11px 12px', borderBottom: '1px solid #eef3f8', fontSize: '13px', fontWeight: 600 }}>{nombreInsumo(c.id)}</td>
                    <td style={{ padding: '11px 12px', borderBottom: '1px solid #eef3f8', fontSize: '13px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      <b style={{ fontWeight: 600 }}>{miles(c.cant)}</b> <span style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}>{unidadInsumo(c.id)}</span>
                    </td>
                    <td style={{ padding: '11px 12px', borderBottom: '1px solid #eef3f8', fontSize: '13px', textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                      {eq ? <>{miles(eq.cant)} {eq.u}</> : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!cargando && esJefe && solReapertura.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px',
                      padding: '13px 16px', marginTop: '14px' }}>
          <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>
            Reaperturas de insumos por autorizar ({solReapertura.length})
          </div>
          {solReapertura.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: '10px', flexWrap: 'wrap', borderTop: '0.5px solid #ecd9b3', paddingTop: '9px', marginTop: '9px' }}>
              <div style={{ fontSize: '13px' }}>
                Reabrir el día {corta(s.valor_propuesto?.fecha)}
                <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic' }}>Motivo: {s.motivo || '—'}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Btn onClick={() => resolverReapertura(s, true)}>Aprobar</Btn>
                <Btn onClick={() => resolverReapertura(s, false)}>Rechazar</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {!cargando && (
        <Cierre
          validaciones={validaciones}
          cerrada={semanaCerrada}
          puedeCerrar={!semanaCerrada && !soloLectura}
          fechas={fechas} dias={dias} hoy={hoy}
          situacion={f => situacionDia(f, hoy)}
          puedeCerrarDias={!soloLectura && !semanaCerrada}
          puedeReabrirDias={esJefe && !soloLectura && !semanaCerrada}
          onCerrarDia={cerrarUnDia}
          onCerrarTodos={cerrarDiasPendientes}
          onReabrirDia={reabrirDia}
          onRevisar={revisarSemana}
          onCerrar={cerrarSemana}
          onReabrirSemana={esJefe && !soloLectura ? reabrirSemana : null}
        />
      )}
    </div>
  )
}

// Mismo panel que en balanceado: cerrar la semana corre las OCHO
// validaciones, insumos incluidos. Se puede hacer desde cualquiera de
// las dos pestanas porque es una sola accion para la finca-semana.
function Cierre({ validaciones, cerrada, puedeCerrar, fechas = [], dias = {}, hoy, situacion = () => '',
                 puedeCerrarDias, puedeReabrirDias, onCerrarDia, onCerrarTodos, onReabrirDia,
                 onRevisar, onCerrar, onReabrirSemana }) {
  const todas = Array.isArray(validaciones) && validaciones.length > 0 && validaciones.every(v => v.pasa)
  // Con la semana cerrada, todos cuentan como cerrados. Si no, solo "cerrado"
  // ("reabierto" volvió a quedar abierto y hay que cerrarlo de nuevo).
  const esCerrado = f => cerrada || dias[f] === 'cerrado'
  const nCerrados = fechas.filter(esCerrado).length
  const faltan = fechas.filter(f => !esCerrado(f) && f !== hoy && situacion(f) !== 'futuro')
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '16px 18px', marginTop: '12px', boxShadow: '0 1px 4px rgba(2,40,71,.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>Cierre de la semana</h3>
        <span style={{ fontSize: '12.5px', color: GRIS }}>{nCerrados} de 7 días cerrados</span>
      </div>

      {/* Los 7 días: cerrar el que falta, reabrir el que está cerrado. */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {fechas.map(f => {
          const cer = esCerrado(f)
          const reab = dias[f] === 'reabierto'
          const fut = situacion(f) === 'futuro'
          const esHoy = f === hoy
          const bordeCol = cer ? '#bfe6d6' : reab ? '#ecd9b3' : BORDE
          const fondoCol = cer ? '#eefaf4' : reab ? '#fdf6ea' : 'white'
          return (
            <div key={f} style={{ flex: '1 1 100px', minWidth: '100px', border: '0.5px solid ' + bordeCol,
                                  background: fondoCol, borderRadius: '10px', padding: '9px 11px', textAlign: 'center' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: cer ? VERDE : NAVY }}>
                {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}
              </div>
              <div style={{ fontSize: '11px', marginTop: '4px' }}>
                {cer ? (
                  <>
                    <span style={{ color: VERDE }}>✓ Cerrado</span>
                    {!cerrada && puedeReabrirDias && (
                      <button onClick={() => onReabrirDia(f)} style={{ display: 'block', margin: '5px auto 0', background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '11px', cursor: 'pointer', padding: 0 }}>Reabrir</button>
                    )}
                  </>
                ) : esHoy ? <span style={{ color: AZUL }}>Hoy</span>
                  : fut ? <span style={{ color: '#c3d0db' }}>Próximo</span>
                  : puedeCerrarDias ? (
                    <>
                      {reab && <span style={{ display: 'block', color: '#BA7517', fontSize: '10px', marginBottom: '2px' }}>Reabierto</span>}
                      <button onClick={() => onCerrarDia(f)} style={{ background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '11px', cursor: 'pointer', padding: 0 }}>Cerrar día</button>
                    </>
                  ) : <span style={{ color: GRIS }}>{reab ? 'Reabierto' : 'Pendiente'}</span>}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', paddingTop: '14px', borderTop: '1px solid #eef3f8' }}>
        <p style={{ fontSize: '12.5px', color: GRIS, margin: 0, maxWidth: '540px' }}>
          {cerrada ? 'Esta semana ya está cerrada. Para corregir algo, reábrela y vuelve a cerrarla al terminar.'
            : 'Cierra cada día cuando termines, o todos a la vez. Un día cerrado se puede reabrir para corregir. Los insumos se cierran aparte del balanceado.'}
        </p>
        <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap' }}>
          {cerrada && onReabrirSemana && <Btn onClick={onReabrirSemana}>Reabrir semana</Btn>}
          {!cerrada && faltan.length > 0 && <Btn onClick={onCerrarTodos}>Cerrar días pendientes ({faltan.length})</Btn>}
          {!cerrada && <Btn onClick={onRevisar}>Revisar cuadres</Btn>}
        </div>
      </div>

      {validaciones === 'cargando' && (
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '14px' }}>Revisando...</div>
      )}

      {Array.isArray(validaciones) && (
        <div style={{ marginTop: '14px' }}>
          {validaciones.map(v => (
            <div key={v.codigo} style={{ display: 'flex', alignItems: 'center', gap: '11px',
                    padding: '9px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
              <span style={{ width: '19px', height: '19px', borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', color: 'white', background: v.pasa ? '#1D9E75' : '#E24B4A' }}>
                {v.pasa ? '✓' : '!'}
              </span>
              <span style={{ fontWeight: 500, minWidth: '210px' }}>{v.nombre}</span>
              <span style={{ color: GRIS }}>{v.detalle}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button onClick={onCerrar} disabled={!todas || !puedeCerrar} style={{
              padding: '9px 18px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
              border: '0.5px solid ' + AZUL, borderRadius: '9px',
              background: (todas && puedeCerrar) ? AZUL : 'white',
              color: (todas && puedeCerrar) ? 'white' : GRIS,
              cursor: (todas && puedeCerrar) ? 'pointer' : 'default',
              opacity: (todas && puedeCerrar) ? 1 : 0.5 }}>
              {puedeCerrar ? 'Cerrar la semana' : 'No se puede cerrar'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// El agregador de una celda: elegir insumo y poner cantidad.
// Filtro multi-select de insumos (varios a la vez, con chips). Sin color en
// la cuadrícula: al filtrar solo se ven esos insumos, los demás quedan en "—".
function FiltroInsumos({ opciones, valor, onCambio, nPisc }) {
  const [abierto, setAbierto] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!abierto) return
    const fuera = e => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false) }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierto])
  const activo = valor.length > 0
  const toggle = id => onCambio(valor.includes(id) ? valor.filter(x => x !== id) : [...valor, id])
  const nombre = id => opciones.find(o => o.id === id)?.nombre || ''
  const sel = { border: '1px solid ' + (activo ? '#9cc4e8' : BORDE), background: activo ? '#f4f9ff' : 'white',
                borderRadius: '10px', padding: '9px 13px', fontSize: '13px', color: activo ? NAVY : GRIS,
                fontFamily: 'inherit', cursor: 'pointer', fontWeight: activo ? 500 : 400 }
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {valor.map(id => (
        <span key={id} style={{ background: '#e8f1fb', color: AZUL, borderRadius: '20px', padding: '4px 6px 4px 11px',
                                fontSize: '12px', fontWeight: 500, display: 'inline-flex', gap: '5px', alignItems: 'center' }}>
          {nombre(id)}
          <button onClick={() => toggle(id)} style={{ background: 'none', border: 'none', color: '#89b4dd', cursor: 'pointer', fontFamily: 'inherit', padding: 0, fontSize: '12px' }}>✕</button>
        </span>
      ))}
      {activo && <span style={{ fontSize: '12px', color: GRIS }}>{nPisc} piscinas</span>}
      <div style={{ position: 'relative' }}>
        <button onClick={() => setAbierto(a => !a)} style={sel}>
          {activo ? '+ insumo' : 'Filtrar por insumo…'} <span style={{ color: '#9fb0bf' }}>▾</span>
        </button>
        {abierto && (
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: '290px', background: '#fff',
                        border: '1px solid ' + BORDE, borderRadius: '12px', boxShadow: '0 12px 30px rgba(12,39,66,.15)', padding: '6px', zIndex: 20, maxHeight: '320px', overflow: 'auto' }}>
            {opciones.map(o => {
              const on = valor.includes(o.id)
              return (
                <button key={o.id} onClick={() => toggle(o.id)} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                        border: 'none', background: 'none', padding: '9px 10px', borderRadius: '8px', fontSize: '13.5px', color: NAVY, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f6f9fb'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <span style={{ width: '17px', height: '17px', borderRadius: '5px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                 fontSize: '11px', color: '#fff', border: '1.5px solid ' + (on ? AZUL : '#c3d0db'), background: on ? AZUL : '#fff' }}>{on ? '✓' : ''}</span>
                  {o.nombre}
                </button>
              )
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px 4px', borderTop: '1px solid #eef3f8', marginTop: '4px' }}>
              <button onClick={() => onCambio([])} style={{ background: 'none', border: 'none', color: activo ? AZUL : '#c3d0db', cursor: activo ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: '12.5px', padding: 0 }}>Limpiar</button>
              <button onClick={() => setAbierto(false)} style={{ background: 'none', border: 'none', color: AZUL, cursor: 'pointer', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, padding: 0 }}>Listo</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Agregar({ insumos, usados, onGuardar, onCerrar }) {
  const [insumoId, setInsumoId] = useState('')
  const [cant, setCant] = useState('')
  const libres = insumos.filter(i => !usados.includes(i.id))
  const elegido = insumos.find(i => i.id === insumoId)
  // Misma regla que en la cuadrícula: nada de "u" genérica.
  const uLbl = i => {
    if (!i) return ''
    if (!i.unidad || i.unidad === 'unidad') {
      if (i.unidad_compra && i.unidad_compra !== 'unidad') return UNIDAD[i.unidad_compra] || i.unidad_compra
      return 'unidades'
    }
    return UNIDAD[i.unidad] || i.unidad
  }
  return (
    <div style={{ marginTop: '4px', padding: '6px', background: '#f6f9fb', borderRadius: '7px' }}>
      <select value={insumoId} onChange={e => setInsumoId(e.target.value)}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '11px', padding: '4px',
                 border: '0.5px solid ' + BORDE, borderRadius: '6px', marginBottom: '4px' }}>
        <option value="">Elegir insumo</option>
        {libres.map(i => (
          <option key={i.id} value={i.id}>{i.nombre} — {UNIDAD[i.unidad] || i.unidad}</option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <CampoNumero value={cant} pista
          placeholder={elegido ? `Cantidad en ${UNIDAD[elegido.unidad] || elegido.unidad}` : 'Cantidad'}
          autoFocus
          onChange={v => setCant(v)}
          onKeyDown={e => e.key === 'Enter' && (onGuardar(insumoId, cant))}
          style={{ flex: 1, fontFamily: 'inherit', fontSize: '11px', padding: '4px',
                   border: '0.5px solid ' + BORDE, borderRadius: '6px', minWidth: 0 }} />
        <button onClick={() => onGuardar(insumoId, cant)} disabled={!insumoId || !numDec(cant)}
          style={{ border: 'none', background: AZUL, color: 'white', borderRadius: '6px',
                   fontFamily: 'inherit', fontSize: '11px', padding: '4px 8px',
                   cursor: 'pointer', opacity: (!insumoId || !numDec(cant)) ? 0.4 : 1 }}>ok</button>
        <button onClick={onCerrar}
          style={{ border: '0.5px solid ' + BORDE, background: 'white', borderRadius: '6px',
                   fontFamily: 'inherit', fontSize: '11px', padding: '4px 7px', cursor: 'pointer',
                   color: GRIS }}>×</button>
      </div>
    </div>
  )
}

function DatoIns({ k, v }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '18px', fontWeight: 500 }}>{v}</div>
    </div>
  )
}
// Tarjeta clara, mismo diseño que el registro de balanceado.
function TarjetaIns({ k, v }) {
  return (
    <div style={{ background: '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '12px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 500 }}>{v}</div>
    </div>
  )
}
function Th({ children, pegado, hoy }) {
  return (
    <div style={{ padding: '9px 12px', fontSize: '11px', fontWeight: 500, color: GRIS,
                  textTransform: 'uppercase', letterSpacing: '0.03em',
                  textAlign: pegado ? 'left' : 'center',
                  position: pegado ? 'sticky' : 'static', left: pegado ? 0 : undefined,
                  background: hoy ? '#E6F1FB' : '#f6f9fb',
                  borderRight: pegado ? '0.5px solid ' + BORDE : 'none' }}>
      {children}
    </div>
  )
}

function Btn({ children, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '8px 13px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
    }}>{children}</button>
  )
}
