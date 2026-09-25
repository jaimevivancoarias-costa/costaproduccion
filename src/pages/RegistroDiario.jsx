import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import DialogoEvento, { TIPOS, guardarEvento, eliminarEvento, mensajeError } from './DialogoEvento'
import CampoNumero from '../components/CampoNumero'
import BuscadorAplicacion from './BuscadorAplicacion'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, corta, cortita,
  nombreDia, esDiaDeMuestreo, diasCultivo, semanaISO, situacionDia, num, numDec, miles,
} from '../lib/fechas'

// Registro diario · modulo Produccion
//
// Aplica PRODUCCION_Reglas_v2.md:
//   2.1  estados de dia: borrador, cerrado, reabierto
//   2.3  vacio, sin alimentacion y registrado son tres cosas distintas
//   2.4  un dia futuro no se evalua nunca
//   3.1  Registrar escribe, Revisar es solo lectura
//   4    ningun total se guarda, todos se calculan aqui
//   5.1  la semana no cierra si fn_validar_semana falla

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#A32D2D'
const HOYB = '#E6F1FB'
const miniLink = { display: 'block', margin: '3px auto 0', background: 'none', border: 'none',
                   padding: 0, cursor: 'pointer', color: '#0D6CB0', fontFamily: 'inherit', fontSize: '9px' }
const HOYL = '#85B7EB'

export default function RegistroDiario({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const [piscinas, setPiscinas] = useState([])
  const [productos, setProductos] = useState([])
  const [celdas, setCeldas] = useState({})       // clave `${piscinaId}|${fecha}`
  const [dias, setDias] = useState({})           // estado por fecha
  const [diasId, setDiasId] = useState({})       // id de la fila dia_registro por fecha
  const [solReapertura, setSolReapertura] = useState([])  // solicitudes de reabrir día
  const [semanaCerrada, setSemanaCerrada] = useState(false)
  const [modo, setModo] = useState('registrar')
  const [soloPendientes, setSoloPendientes] = useState(false)
  const [sucio, setSucio] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [refrescando, setRefrescando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [validaciones, setValidaciones] = useState(null)
  const [eventos, setEventos] = useState({})     // clave piscinaId -> evento de la semana
  const [laboratorios, setLaboratorios] = useState([])
  const [dialogo, setDialogo] = useState(null)   // { tipo, fila }
  const [verIndicadores, setVerIndicadores] = useState(false)
  const [acumulado, setAcumulado] = useState({})   // cicloId -> libras desde la siembra
  const [raleado, setRaleado] = useState({})       // cicloId -> libras raleadas
  const [pesos, setPesos] = useState({})           // piscinaId -> { mie, dom }
  const [editSiembra, setEditSiembra] = useState(null)  // piscinaId en edicion de larva/gramaje
  const [abierta, setAbierta] = useState(null)          // piscinaId con detalle del ciclo abierto
  const refs = useRef({})
  // Celdas que el usuario tocó (para guardar solo esas, no toda la semana).
  const tocadas = useRef(new Set())
  // Ids que tenía cada celda al cargar, para borrarlos aunque la celda se vacíe.
  const idsOriginales = useRef({})
  // Celdas tal como se cargaron, para saber cuánto consumo se AGREGA al guardar.
  const celdasOriginales = useRef({})
  // Saldo disponible por producto (en sacos), para no dejar consumir sin stock.
  const [saldoBal, setSaldoBal] = useState({})
  // Filtro: ver solo piscinas/días donde se aplicó este producto.
  const [filtroProd, setFiltroProd] = useState('')

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const semanaDeHoy = lunesDe(hoy) === lunes
  // Los dias de cultivo se cuentan hasta el final de la semana que se
  // esta mirando, pero nunca mas alla de hoy: una piscina sembrada
  // ayer no lleva seis dias porque el domingo quede lejos.
  const corteDias = fechas[6] > hoy ? hoy : fechas[6]

  const cargar = useCallback(async (silencioso) => {
    // Al recargar despues de guardar no se vacia la pantalla: la
    // cuadricula se queda donde esta y solo aparece un indicador. Ver
    // todo desaparecer y volver da la sensacion de que algo se perdio.
    if (!silencioso) setCargando(true)
    setRefrescando(true); setAviso(null)
    try {
      const domingo = fechas[6]

      // Las consultas que no dependen unas de otras van juntas. Antes
      // iban en fila y cada una esperaba a la anterior.
      const [
        { data: todas, error },
        { data: ciclos, error: eCiclos },
        { data: labs },
        { data: prods },
        { data: dr },
        { data: sc },
      ] = await Promise.all([
        supabase.schema('produccion').from('piscina')
          .select('id, codigo, nombre, hectareas, tipo')
          .eq('finca_id', finca.id).eq('activa', true).eq('es_reservorio', false),
        supabase.schema('produccion').from('ciclo')
          .select('id, fecha_siembra, fecha_ocupacion, fecha_cierre, estado, cantidad_larva, gramaje_precria, piscina_origen_id, ciclo_padre_id, laboratorio_id, laboratorio:laboratorio_id (nombre)')
          .eq('finca_id', finca.id),
        supabase.schema('produccion').from('laboratorio')
          .select('id, nombre').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('producto')
          .select('id, nombre, nombre_corto').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('dia_registro')
          .select('id, fecha, estado').eq('finca_id', finca.id).eq('ambito', 'balanceado')
          .gte('fecha', lunes).lte('fecha', domingo),
        supabase.schema('produccion').from('semana_cerrada')
          .select('id').eq('finca_id', finca.id)
          .eq('anio', semanaISO(lunes).anio).eq('semana', semanaISO(lunes).semana)
          .eq('ambito', 'balanceado').maybeSingle(),
      ])
      if (error) throw error
      if (eCiclos) throw new Error('No se pudieron leer los ciclos. ' + eCiclos.message)

      // Los ciclos vienen sin filtrar por fecha porque hacen falta dos
      // cosas distintas: el ciclo que cubria esta semana, y si la
      // piscina fue sembrada DESPUES de esta semana. Sin lo segundo, al
      // mirar junio una piscina sembrada en julio se veia vacia y
      // ofrecia Sembrar.
      //
      // El ciclo que cubria ESA semana, no el que esta abierto hoy. Si
      // hubo dos en la misma semana se queda el que empezo despues: es
      // el que sigue vivo al final de la semana.
      const porPiscina = {}
      // La ocupacion mas cercana posterior a esta semana, si existe.
      const posterior = {}
      ;(ciclos || []).forEach(c => {
        const pid = c.piscina_origen_id
        // Desde cuando este ciclo ocupa la piscina: la siembra, o —si vino
        // por transferencia— el dia que llego. Un ciclo transferido NO
        // existe en esta piscina hasta ese dia, aunque su fecha de siembra
        // (la del padre) sea anterior. Por eso el corte de "futuro" y el
        // desempate entre dos ciclos se hacen con la OCUPACION, no con la
        // siembra: si no, al mirar agosto una piscina que recien recibe una
        // transferencia en septiembre se veia con el ciclo nuevo y escondia
        // el consumo del ciclo viejo.
        const ocupa = c.fecha_ocupacion || c.fecha_siembra
        if (ocupa > domingo) {
          if (!posterior[pid] || ocupa < posterior[pid]) posterior[pid] = ocupa
          return
        }
        if (c.fecha_cierre && c.fecha_cierre < lunes) return
        const previo = porPiscina[pid]
        // Si hay dos ocupando en la misma semana se queda el que ocupo
        // despues: es el que sigue vivo al final de la semana.
        const ocupaPrevio = previo && (previo.fecha_ocupacion || previo.fecha_siembra)
        if (!previo || ocupa > ocupaPrevio) porPiscina[pid] = c
      })

      const lista = (todas || []).map(p => {
        const c = porPiscina[p.id]
        // "Secado": días que la piscina estuvo vacía antes de este cultivo
        // (desde la cosecha del cultivo anterior en esta misma piscina).
        const ocup0 = c?.fecha_ocupacion || c?.fecha_siembra
        const prevCierre = c ? (ciclos || [])
          .filter(x => x.piscina_origen_id === p.id && x.fecha_cierre && (!ocup0 || x.fecha_cierre < ocup0))
          .reduce((mx, x) => (!mx || x.fecha_cierre > mx ? x.fecha_cierre : mx), null) : null
        return {
          prevCierre,
          cicloId: c?.id || null, piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
          hectareas: Number(p.hectareas), tipo: p.tipo,
          fechaSiembra: c?.fecha_siembra || null, larva: c?.cantidad_larva || null,
          // Desde cuando come en ESTA piscina. Para un ciclo normal es la
          // siembra; para uno transferido, el dia que llego aqui.
          fechaOcupacion: c?.fecha_ocupacion || c?.fecha_siembra || null,
          fechaCierre: c?.fecha_cierre || null,
          laboratorioId: c?.laboratorio_id || '',
          // Un ciclo esta cerrado PARA ESTA SEMANA solo si termino antes
          // del lunes. Mirar estado seria mirar la foto de hoy: la P2
          // cosecho el 18 de junio, y en la semana del 15 al 21 todavia
          // estaba viva y hay que poder registrarle esa cosecha.
          cicloCerrado: !!(c?.fecha_cierre && c.fecha_cierre < lunes),
          // Cosechada DENTRO de esta semana: el ciclo cerro entre lunes y
          // domingo. La piscina quedo vacia y debe poder sembrarse de
          // nuevo la misma semana.
          cosechadaEstaSemana: !!(c?.fecha_cierre && c.fecha_cierre >= lunes && c.fecha_cierre <= domingo),
          // Vacia esta semana, pero ya sembrada mas adelante. No se puede
          // volver a sembrar: la base solo admite un ciclo abierto por
          // piscina, y con razon.
          siembraPosterior: posterior[p.id] || null,
          laboratorio: c?.laboratorio?.nombre || null,
          gramajePrecria: c?.gramaje_precria ?? null,
          // Directa (sin padre) vs venida por transferencia. Se usa para
          // mostrar "eliminar siembra" solo en siembras directas.
          cicloPadreId: c?.ciclo_padre_id || null,
        }
      }).sort(ordenar)

      // "eliminar siembra" solo aplica a siembras DIRECTAS (sin padre) y
      // LIMPIAS (sin alimentación ni insumos). Se revisa solo para esas
      // pocas, no para todas las piscinas.
      const idsDir = lista.filter(x => x.cicloId && !x.cicloPadreId).map(x => x.cicloId)
      const conReg = new Set()
      if (idsDir.length) {
        const [{ data: al2 }, { data: co2 }] = await Promise.all([
          supabase.schema('produccion').from('alimentacion').select('ciclo_id').in('ciclo_id', idsDir),
          supabase.schema('produccion').from('consumo_insumo').select('ciclo_id').in('ciclo_id', idsDir),
        ])
        ;(al2 || []).forEach(r => r.ciclo_id && conReg.add(r.ciclo_id))
        ;(co2 || []).forEach(r => r.ciclo_id && conReg.add(r.ciclo_id))
      }
      lista.forEach(p => { p.siembraLimpia = !!p.cicloId && !p.cicloPadreId && !conReg.has(p.cicloId) })
      setPiscinas(lista)

      setLaboratorios(labs || [])
      setProductos(prods || [])

      const md = {}, mid = {}
      ;(dr || []).forEach(d => { md[d.fecha] = d.estado; mid[d.fecha] = d.id })
      setDias(md); setDiasId(mid)
      setSemanaCerrada(!!sc)

      // Solicitudes de reapertura de día pendientes (para el panel del jefe).
      const idsDia = Object.values(mid).filter(Boolean)
      if (idsDia.length) {
        const { data: sr } = await supabase.schema('produccion').from('solicitud_correccion')
          .select('id, registro_id, valor_propuesto, motivo, estado, solicitado_en')
          .eq('finca_id', finca.id).eq('tabla', 'dia_registro').eq('estado', 'pendiente')
          .in('registro_id', idsDia)
        setSolReapertura(sr || [])
      } else { setSolReapertura([]) }

      const ids = lista.map(p => p.piscinaId)
      const ciclosIds = lista.filter(x => x.cicloId).map(x => x.cicloId)

      // Segunda tanda: todo lo que necesitaba saber las piscinas. El
      // acumulado del ciclo se pide sumado por la base. Antes se traian
      // todas las filas de alimentacion desde la siembra y se sumaban
      // aqui: en un ciclo de tres meses son cientos de filas por
      // piscina, en cada carga, solo para mostrar un total.
      const [
        { data: evs1 },
        { data: acums },
        { data: rals },
        { data: ms },
        { data: alim, error: eAlim },
        { data: saldosB },
      ] = await Promise.all([
        ids.length ? supabase.schema('produccion').from('evento')
          .select('id, tipo, fecha, libras, piscina_origen_id, ciclo_id')
          .in('piscina_origen_id', ids).gte('fecha', lunes).lte('fecha', domingo)
          .order('fecha')
          : Promise.resolve({ data: [] }),
        ciclosIds.length ? supabase.schema('produccion')
          .rpc('fn_acumulado_ciclos', { p_ciclos: ciclosIds, p_hasta: domingo })
          : Promise.resolve({ data: [] }),
        ciclosIds.length ? supabase.schema('produccion').from('evento')
          .select('ciclo_id, libras').in('ciclo_id', ciclosIds).eq('tipo', 'raleo')
          : Promise.resolve({ data: [] }),
        ids.length ? supabase.schema('produccion').from('muestreo')
          .select('piscina_id, fecha, peso_gramos').in('piscina_id', ids)
          .gte('fecha', lunes).lte('fecha', domingo)
          : Promise.resolve({ data: [] }),
        ids.length ? supabase.schema('produccion').from('alimentacion')
          .select('id, piscina_id, fecha, producto_id, libras, sin_alimentacion')
          .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
          : Promise.resolve({ data: [] }),
        supabase.schema('produccion').rpc('fn_saldo_balanceado', { p_finca: finca.id, p_hasta: domingo }),
      ])

      // Saldo disponible por producto (en sacos), para el chequeo de stock.
      const sb = {}
      ;(saldosB || []).forEach(r => { sb[r.producto_id] = Number(r.saldo) })
      setSaldoBal(sb)

      // Si esta consulta falla y nadie mira el error, la semana se
      // dibuja vacia y parece que se borraron los datos. Nunca mas.
      if (eAlim) throw new Error('No se pudo leer la alimentación de la semana. ' + eAlim.message)

      // Varios eventos por piscina en la semana: puede haber una cosecha
      // y despues una siembra nueva. Se guardan todos, en orden.
      const evs = {}
      ;(evs1 || []).forEach(x => { (evs[x.piscina_origen_id] = evs[x.piscina_origen_id] || []).push(x) })
      setEventos(evs)

      const acum = {}, ral = {}, pes = {}
      ;(acums || []).forEach(r => { acum[r.ciclo_id] = Number(r.libras) })
      ;(rals || []).forEach(r => { ral[r.ciclo_id] = (ral[r.ciclo_id] || 0) + Number(r.libras || 0) })
      ;(ms || []).forEach(m => {
        const d = new Date(m.fecha + 'T12:00:00').getDay()
        pes[m.piscina_id] = { ...(pes[m.piscina_id] || {}),
                              [d === 3 ? 'mie' : 'dom']: Number(m.peso_gramos) }
      })
      setAcumulado(acum); setRaleado(ral); setPesos(pes)

      // Se agrupan TODAS las filas por piscina|fecha primero, y _ids junta
      // cada id de la base para esa celda. Así, si por una inconsistencia
      // vieja coexisten una fila "sin alimentación" y una de producto, no se
      // pierde ningún id: al guardar se borran todos y se reinserta limpio.
      const byKey = {}
      ;(alim || []).forEach(a => { (byKey[`${a.piscina_id}|${a.fecha}`] ||= []).push(a) })
      const mapa = {}
      Object.entries(byKey).forEach(([key, rows]) => {
        const ids = rows.map(r => r.id)
        const prods = rows.filter(r => !r.sin_alimentacion && r.producto_id)
        if (prods.length === 0) {
          const sinRow = rows.find(r => r.sin_alimentacion)
          mapa[key] = { sinAlimentacion: !!sinRow, id: ids[0], productoId: '', libras: '', extras: [], _ids: ids }
        } else {
          const [first, ...rest] = prods
          mapa[key] = {
            sinAlimentacion: false, id: first.id, productoId: first.producto_id, libras: String(first.libras),
            extras: rest.map(r => ({ id: r.id, productoId: r.producto_id, libras: String(r.libras) })),
            _ids: ids,
          }
        }
      })
      setCeldas(mapa)
      // Línea base: qué ids tenía cada celda y ninguna tocada todavía.
      idsOriginales.current = Object.fromEntries(Object.entries(mapa).map(([k, v]) => [k, v._ids || []]))
      celdasOriginales.current = mapa
      tocadas.current = new Set()

      setSucio(false)
      setValidaciones(null)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false); setRefrescando(false)
    }
  }, [finca.id, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  // Regla 3.2: solo el dia de hoy es editable en modo Registrar, y solo
  // si la semana no esta cerrada. El jefe puede tocar cualquier dia.
  function editable(fecha) {
    if (soloLectura || modo !== 'registrar') return false
    if (semanaCerrada) return false
    if (situacionDia(fecha, hoy) === 'futuro') return false
    // Un día cerrado queda bloqueado hasta que se reabra. Reabierto vuelve a editarse.
    if (dias[fecha] === 'cerrado') return false
    if (esJefe) return true
    // El bodeguero edita su semana actual, y también una semana anterior
    // SI el jefe la reabrió. Como las semanas viejas están cerradas, llegar
    // aquí (no cerrada, no futura, día no cerrado) ya significa que es la
    // semana en curso o una que el jefe reabrió a propósito.
    return true
  }

  // Registrar un evento recarga la pantalla desde la base, y eso se
  // llevaba por delante las libras que estuvieran escritas sin guardar.
  // Ahora se guardan primero. Si el guardado falla, el dialogo no se
  // abre: mejor no avanzar que perder lo escrito.
  async function abrirEvento(tipo, fila) {
    if (sucio) {
      const ok = await guardar(false)
      if (!ok) return
    }
    setDialogo({ tipo, fila })
  }

  // Deshacer un evento ya registrado, para corregir una equivocacion.
  async function borrarEvento(fila, evento) {
    const nombre = TIPOS[evento.tipo]?.nombre || 'evento'
    if (!window.confirm(`¿Deshacer ${nombre.toLowerCase()} de ${fila.nombre}? Se puede volver a registrar.`)) return
    try {
      if (sucio) { const ok = await guardar(false); if (!ok) return }
      // El evento puede ser de un ciclo distinto al que la fila muestra
      // ahora (la cosecha vieja tras resembrar), por eso su propio ciclo.
      await eliminarEvento({ evento, cicloId: evento.ciclo_id || fila.cicloId })
      setAviso({ tipo: 'ok', texto: `${nombre} deshecha` })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo deshacer. ' + (err.message || '') })
    }
  }

  async function registrarEvento(datos) {
    try {
      await guardarEvento({
        tipo: dialogo.tipo, fincaId: finca.id,
        ciclo: dialogo.fila, piscina: dialogo.fila, datos,
      })
      setDialogo(null)
      setAviso({ tipo: 'ok', texto: TIPOS[dialogo.tipo].nombre + ' registrada' })
      await cargar(true)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + mensajeError(err) })
    }
  }

  const clave = (p, f) => `${p.piscinaId}|${f}`
  const cel = (p, f) => celdas[clave(p, f)]

  function set(p, f, campo, valor) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}), [campo]: valor, sinAlimentacion: false } }))
    setSucio(true)
  }

  function marcarSin(p, f) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}), sinAlimentacion: true, libras: '', productoId: '' } }))
    setSucio(true)
  }

  function limpiar(p, f) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => { const n = { ...c }; delete n[k]; return n })
    setSucio(true)
  }

  // --- Balanceados extra (además del principal) en la misma piscina/día ---
  function addExtra(p, f) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}), sinAlimentacion: false,
      extras: [...((c[k] || {}).extras || []), { productoId: '', libras: '' }] } }))
    setSucio(true)
  }
  function setExtra(p, f, i, campo, valor) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}),
      extras: ((c[k] || {}).extras || []).map((e, j) => j === i ? { ...e, [campo]: valor } : e) } }))
    setSucio(true)
  }
  function removeExtra(p, f, i) {
    const k = clave(p, f)
    tocadas.current.add(k)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}),
      extras: ((c[k] || {}).extras || []).filter((_, j) => j !== i) } }))
    setSucio(true)
  }
  // Libras totales de una celda (principal + extras).
  const librasCelda = c => c && !c.sinAlimentacion
    ? (numDec(c.libras) || 0) + (c.extras || []).reduce((s, e) => s + (numDec(e.libras) || 0), 0)
    : 0

  function copiarDiaAnterior(f) {
    const previo = sumarDias(f, -1)
    const nuevo = { ...celdas }
    piscinas.forEach(p => {
      const src = celdas[clave(p, previo)]
      if (src && !src.sinAlimentacion && src.libras) {
        tocadas.current.add(clave(p, f))
        nuevo[clave(p, f)] = { ...nuevo[clave(p, f)], productoId: src.productoId, libras: src.libras, sinAlimentacion: false }
      }
    })
    setCeldas(nuevo); setSucio(true)
    setAviso({ tipo: 'ok', texto: `Se copió el ${nombreDia(previo).toLowerCase()}. Revisa antes de guardar.` })
  }

  // ---- totales, todos calculados (regla P1) ----
  const totalPiscina = p =>
    fechas.reduce((s, f) => s + librasCelda(cel(p, f)), 0)
  const totalDia = f =>
    piscinas.reduce((s, p) => s + librasCelda(cel(p, f)), 0)
  async function reabrirDia(fecha) {
    const id = diasId[fecha]
    if (!id) return
    if (!window.confirm(`¿Reabrir el ${nombreDia(fecha).toLowerCase()} ${corta(fecha)}? Vuelve a quedar editable.`)) return
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .update({ estado: 'reabierto', reabierto_en: new Date().toISOString() }).eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Día reabierto.' }); await cargar(true)
  }

  async function pedirReabrir(fecha) {
    const id = diasId[fecha]
    if (!id) return
    const motivo = window.prompt('¿Por qué necesitas reabrir este día? El jefe lo revisará.')
    if (!motivo || !motivo.trim()) return
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'dia_registro', registro_id: id,
      valor_anterior: { estado: 'cerrado' }, valor_propuesto: { estado: 'reabierto', fecha, ambito: 'balanceado' },
      motivo: motivo.trim(), solicitado_por: user?.id })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido enviado. El jefe lo revisará.' }); await cargar(true)
  }

  async function resolverReapertura(sol, aprobar) {
    const { error } = await supabase.schema('produccion')
      .rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Día reabierto.' : 'Pedido rechazado.' }); await cargar(true)
  }

  async function guardarSiembra(p, larva, gramaje, fecha) {
    const lv = larva === '' || larva == null ? null : Math.round(Number(String(larva).replace(/[.,]/g, '')))
    const gr = gramaje === '' || gramaje == null ? null : Number(String(gramaje).replace(',', '.'))
    if (lv !== null && !(lv > 0)) { setAviso({ tipo: 'error', texto: 'La larva debe ser un número mayor que cero.' }); return }
    if (gr !== null && !(gr >= 0)) { setAviso({ tipo: 'error', texto: 'El gramaje no es válido.' }); return }
    if (!fecha) { setAviso({ tipo: 'error', texto: 'Falta la fecha de siembra.' }); return }
    if (fecha > hoyISO()) { setAviso({ tipo: 'error', texto: 'La siembra no puede ser una fecha futura.' }); return }
    // La siembra no puede quedar después de otro evento del ciclo (transferencia,
    // cosecha…), para que las fechas queden en orden.
    const { data: evs } = await supabase.schema('produccion').from('evento')
      .select('fecha, tipo').eq('ciclo_id', p.cicloId).neq('tipo', 'siembra')
      .order('fecha', { ascending: true }).limit(1)
    if (evs && evs.length && evs[0].fecha < fecha) {
      setAviso({ tipo: 'error', texto: `La siembra no puede ser después del ${corta(evs[0].fecha)} (ya hay un evento de ${evs[0].tipo}).` }); return
    }
    const campos = { cantidad_larva: lv, gramaje_precria: gr }
    if (fecha !== p.fechaSiembra) campos.fecha_siembra = fecha
    const { error } = await supabase.schema('produccion').from('ciclo')
      .update(campos).eq('id', p.cicloId)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    if (fecha !== p.fechaSiembra) {
      await supabase.schema('produccion').from('evento')
        .update({ fecha }).eq('ciclo_id', p.cicloId).eq('tipo', 'siembra')
    }
    setEditSiembra(null)
    setAviso({ tipo: 'ok', texto: `Siembra de ${p.nombre} actualizada.` })
    await cargar(true)
  }

  // Eliminar una siembra directa equivocada (borra el ciclo entero) para
  // dejar la piscina libre — p. ej. cuando en realidad va una transferencia
  // desde precría. Reusa la lógica de "Deshacer", que bloquea si ya hay
  // consumo u otra novedad.
  async function eliminarSiembra(p) {
    if (!window.confirm(`¿Eliminar la siembra de ${p.nombre}?\n\nLa piscina quedará vacía. Solo se puede si no tiene consumo ni otras novedades (cosecha, raleo, transferencia).`)) return
    const { data: ev } = await supabase.schema('produccion').from('evento')
      .select('id, fecha, tipo').eq('ciclo_id', p.cicloId).eq('tipo', 'siembra').maybeSingle()
    if (!ev) {
      setAviso({ tipo: 'error', texto: 'Esta piscina no tiene una siembra directa (quizá llegó por transferencia). Para vaciarla, deshaz la transferencia que la llenó.' })
      return
    }
    try {
      await eliminarEvento({ evento: ev, cicloId: p.cicloId })
      setEditSiembra(null); setAbierta(null)
      setAviso({ tipo: 'ok', texto: `Siembra de ${p.nombre} eliminada. La piscina quedó libre para la transferencia.` })
      await cargar(true)
    } catch (err) {
      setAviso({ tipo: 'error', texto: err.message || 'No se pudo eliminar la siembra.' })
    }
  }

  const totalSemana = useMemo(
    () => piscinas.reduce((s, p) => s + totalPiscina(p), 0), [piscinas, celdas, fechas])
  const hectareas = useMemo(
    () => piscinas.reduce((s, p) => s + p.hectareas, 0), [piscinas])

  // Regla 2.4: solo cuenta lo pendiente de hoy y lo atrasado de dias pasados.
  const pendientesHoy = piscinas.filter(p => {
    if (!p.cicloId) return false
    if (p.tipo === 'precria') return false
    const c = cel(p, hoy)
    return !c || (!c.sinAlimentacion && !numDec(c.libras))
  })
  const atrasadas = []
  fechas.forEach(f => {
    if (situacionDia(f, hoy) !== 'pasado') return
    piscinas.forEach(p => {
      if (!p.cicloId || p.tipo === 'precria') return
      if (p.fechaOcupacion && f < p.fechaOcupacion) return
      if (p.fechaCierre && f > p.fechaCierre) return
      const c = cel(p, f)
      if (!c || (!c.sinAlimentacion && !numDec(c.libras))) atrasadas.push({ p, f })
    })
  })
  // Celdas por llenar (para resaltarlas en la cuadrícula y poder cerrar).
  const faltantesKeys = new Set([
    ...atrasadas.map(a => `${a.p.piscinaId}|${a.f}`),
    ...pendientesHoy.map(p => `${p.piscinaId}|${hoy}`),
  ])

  // Libras por producto de una celda (principal + extras).
  const librasPorProducto = c => {
    const m = {}
    if (!c || c.sinAlimentacion) return m
    const add = (pid, lb) => { if (pid && num(lb)) m[pid] = (m[pid] || 0) + num(lb) }
    add(c.productoId, c.libras)
    for (const e of (c.extras || [])) add(e.productoId, e.libras)
    return m
  }

  async function guardar(cerrarDia) {
    setGuardando(true); setAviso(null)
    try {
      // Chequeo de STOCK: lo que se agrega no puede superar lo disponible en
      // bodega. Se mira solo el consumo NUEVO (nuevo − lo que ya estaba) de
      // cada producto, contra su saldo. Sin stock => no se guarda.
      const deltaProd = {}
      for (const p of piscinas) {
        if (!p.cicloId) continue
        for (const f of fechas) {
          const k = clave(p, f)
          if (!tocadas.current.has(k)) continue
          const vieja = librasPorProducto(celdasOriginales.current[k])
          const nueva = librasPorProducto(cel(p, f))
          new Set([...Object.keys(vieja), ...Object.keys(nueva)]).forEach(pid => {
            deltaProd[pid] = (deltaProd[pid] || 0) + ((nueva[pid] || 0) - (vieja[pid] || 0))
          })
        }
      }
      const faltan = []
      for (const [pid, delta] of Object.entries(deltaProd)) {
        if (delta <= 0.0001) continue
        const dispLibras = (saldoBal[pid] || 0) * LIBRAS_POR_SACO
        if (delta > dispLibras + 0.001) {
          const nom = productos.find(x => x.id === pid)?.nombre || 'balanceado'
          faltan.push(`${nom}: hay ${(dispLibras / LIBRAS_POR_SACO).toFixed(1)} sacos (${miles(Math.round(dispLibras))} lb), quieres consumir ${miles(Math.round(delta))} lb`)
        }
      }
      if (faltan.length) {
        // Siempre se bloquea si no hay stock: todo debe cuadrar. Primero se
        // ingresa el balanceado que faltó a bodega, luego se registra.
        setAviso({ tipo: 'error', texto: 'Sin stock suficiente, ingresa balanceado a bodega antes de registrar. ' + faltan.join(' · ') })
        setGuardando(false)
        return false
      }

      // Con varios productos por piscina/día no se puede usar upsert por
      // (piscina, fecha). Por cada celda TOCADA: se borran sus filas viejas
      // y se insertan las deseadas. Así nunca choca con el índice único
      // (piscina, fecha, producto) aunque se intercambien o repitan productos.
      const insertar = [], borrar = []
      for (const p of piscinas) {
        if (!p.cicloId) continue
        for (const f of fechas) {
          const k = clave(p, f)
          // Solo se guardan las celdas que el usuario cambió. Así el guardado
          // no reescribe toda la semana (evita el timeout) ni toca lo ajeno.
          if (!tocadas.current.has(k)) continue
          if (!editable(f) && !(esJefe && situacionDia(f, hoy) !== 'futuro')) continue
          const c = cel(p, f)
          // Las filas viejas de esta celda (capturadas al cargar) se borran,
          // aunque la celda se haya vaciado por completo.
          for (const id of (idsOriginales.current[k] || [])) borrar.push(id)
          if (!c) continue

          if (c.sinAlimentacion) {
            insertar.push({ ciclo_id: p.cicloId, piscina_id: p.piscinaId,
                            fecha: f, producto_id: null, libras: 0, sin_alimentacion: true })
          } else {
            // Se juntan main + extras y se suma si un mismo producto aparece
            // dos veces (evita el duplicado en el índice único).
            const porProducto = new Map()
            const acum = (pid, lb) => { if (pid && lb) porProducto.set(pid, (porProducto.get(pid) || 0) + lb) }
            acum(c.productoId, numDec(c.libras))
            for (const e of (c.extras || [])) acum(e.productoId, numDec(e.libras))
            for (const [pid, lb] of porProducto) {
              insertar.push({ ciclo_id: p.cicloId, piscina_id: p.piscinaId,
                              fecha: f, producto_id: pid, libras: lb, sin_alimentacion: false })
            }
          }
        }
      }

      // Primero se borra TODO lo tocado, después se inserta: nunca coexisten
      // la fila vieja y la nueva del mismo producto.
      if (borrar.length) {
        const { error } = await supabase.schema('produccion').from('alimentacion').delete().in('id', borrar)
        if (error) throw error
      }
      if (insertar.length) {
        const { error } = await supabase.schema('produccion').from('alimentacion').insert(insertar)
        if (error) throw error
      }

      // Solo se toca el estado del dia cuando se esta en la semana en curso.
      // Corregir una semana pasada no debe reabrir ni cerrar nada.
      if (semanaDeHoy) {
        const estado = cerrarDia ? 'cerrado' : 'borrador'
        const { error: e2 } = await supabase.schema('produccion').from('dia_registro')
          .upsert({ finca_id: finca.id, fecha: hoy, ambito: 'balanceado', estado,
                    ...(cerrarDia ? { cerrado_en: new Date().toISOString() } : {}) },
                  { onConflict: 'finca_id,fecha,ambito' })
        if (e2) throw e2
      }

      setAviso({ tipo: 'ok',
        texto: !semanaDeHoy ? 'Cambios guardados' : (cerrarDia ? 'Día cerrado' : 'Borrador guardado') })
      await cargar(true)
      return true
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + mensajeError(err) })
      return false
    } finally {
      setGuardando(false)
    }
  }

  async function pedirCerrarDia() {
    if (pendientesHoy.length) {
      const nombres = pendientesHoy.slice(0, 3).map(p => p.nombre).join(', ')
      const resto = pendientesHoy.length > 3 ? ` y ${pendientesHoy.length - 3} más` : ''
      if (!window.confirm(
        `Faltan ${pendientesHoy.length} piscinas por declarar: ${nombres}${resto}.\n\n` +
        `Si no comieron, márcalas sin alimentación. ¿Cerrar el día de todos modos?`)) return
    }
    guardar(true)
  }

  // V5 pide que alguien haya declarado cerrado cada uno de los siete
  // dias. Pero "Cerrar dia" solo existe en la semana en curso, asi que
  // una semana que se carga hacia atras nunca podia cumplirlo.
  //
  // Aqui el jefe cierra de una vez los dias que falten. No es un atajo:
  // es la misma firma, hecha por quien tiene la potestad de hacerla, y
  // queda en la bitacora igual que cualquier otro cierre.
  async function cerrarDiasPendientes() {
    const faltan = fechas.filter(f => dias[f] !== 'cerrado' && dias[f] !== 'reabierto'
                                      && f !== hoy
                                      && situacionDia(f, hoy) !== 'futuro')
    if (!faltan.length) return
    if (!window.confirm(
      `Vas a dar por cerrados ${faltan.length} días: ${faltan.map(cortita).join(', ')}.\n\n` +
      `Es tu firma de que ese día quedó revisado. Queda registrado en la bitácora.`)) return

    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert(faltan.map(f => ({ finca_id: finca.id, fecha: f, ambito: 'balanceado', estado: 'cerrado',
                                 cerrado_en: new Date().toISOString() })),
              { onConflict: 'finca_id,fecha,ambito' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${faltan.length} días cerrados` })
    await cargar(true)
    await revisarSemana()
  }

  // Cerrar un solo día (seleccionable), para no confundir con el "todos".
  async function cerrarUnDia(fecha) {
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha, ambito: 'balanceado', estado: 'cerrado', cerrado_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${nombreDia(fecha)} cerrado` })
    await cargar(true)
    await revisarSemana()
  }

  // El laboratorio se puede poner o corregir despues de la siembra. En
  // la practica el bodeguero no siempre lo sabe el dia que entra la
  // larva, y obligarlo a elegir uno en ese momento solo garantiza que
  // ponga cualquiera.
  async function cambiarLaboratorio(fila, id) {
    if (!fila.cicloId) return
    // Se pinta antes de que responda la base: es un cambio chico y
    // esperar medio segundo por cada uno se siente pesado.
    const antes = piscinas
    setPiscinas(ps => ps.map(p => p.piscinaId === fila.piscinaId
      ? { ...p, laboratorioId: id, laboratorio: laboratorios.find(l => l.id === id)?.nombre || null }
      : p))

    const { error } = await supabase.schema('produccion').from('ciclo')
      .update({ laboratorio_id: id || null }).eq('id', fila.cicloId)
    if (error) {
      setPiscinas(antes)
      setAviso({ tipo: 'error', texto: 'No se pudo cambiar el laboratorio. ' + error.message })
    }
  }

  // Agregar un laboratorio al catalogo. Lo puede hacer tambien el
  // bodeguero: si llega larva de uno que no esta en la lista, no puede
  // quedarse esperando. Renombrar y desactivar siguen siendo del jefe.
  async function nuevoLaboratorio(fila) {
    const escrito = window.prompt('Nombre del laboratorio')
    if (!escrito) return
    const nombre = escrito.trim()
    if (!nombre) return

    // Si ya existe escrito de otra forma, se usa el que ya esta en vez
    // de crear un duplicado. Asi no terminamos con ACUATECSA, Acuatecsa
    // y Acuatecsa S.A. siendo el mismo laboratorio.
    const ya = laboratorios.find(l => l.nombre.toLowerCase() === nombre.toLowerCase())
    if (ya) {
      setAviso({ tipo: 'ok', texto: `Ya existía como "${ya.nombre}". Se usó ese.` })
      return cambiarLaboratorio(fila, ya.id)
    }

    const { data, error } = await supabase.schema('produccion').from('laboratorio')
      .insert({ nombre }).select('id, nombre').single()
    if (error) {
      setAviso({ tipo: 'error', texto: 'No se pudo agregar. ' + error.message })
      return
    }
    setLaboratorios(ls => [...ls, data].sort((a, b) => a.nombre.localeCompare(b.nombre)))
    setAviso({ tipo: 'ok', texto: `${data.nombre} agregado al catálogo` })
    await cambiarLaboratorio(fila, data.id)
  }

  async function revisarSemana() {
    setValidaciones('cargando')
    const { data, error } = await supabase.schema('produccion')
      .rpc('fn_validar_semana', { p_finca: finca.id, p_lunes: lunes })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); setValidaciones(null); return }
    // Aqui solo las de balanceado. V7 y V8 (insumos) se revisan y se
    // cierran en la pestana de Insumos.
    setValidaciones((data || []).filter(v => v.codigo !== 'V7' && v.codigo !== 'V8'))
  }

  async function cerrarSemana() {
    const { anio, semana } = semanaISO(lunes)
    const { error } = await supabase.schema('produccion').from('semana_cerrada')
      .insert({ finca_id: finca.id, anio, semana, ambito: 'balanceado', validaciones })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Balanceado de la semana cerrado' })
    await cargar(true)
  }

  // Reabrir la semana entera. Solo jefe/contadora (esJefe). Quita el cierre
  // y la semana vuelve a quedar editable para todos (bodegueros incluidos).
  async function reabrirSemana() {
    const { anio, semana } = semanaISO(lunes)
    if (!window.confirm('¿Reabrir toda la semana? Vuelve a quedar editable para la finca (también para el bodeguero).')) return
    const { error } = await supabase.schema('produccion').from('semana_cerrada')
      .delete().eq('finca_id', finca.id).eq('anio', anio).eq('semana', semana).eq('ambito', 'balanceado')
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir. ' + error.message }); return }
    // Reabrir también los días cerrados de la semana, para poder editar los
    // que sí tuvieron alimentación (no solo los vacíos).
    const { error: eDias } = await supabase.schema('produccion').from('dia_registro')
      .update({ estado: 'reabierto' })
      .eq('finca_id', finca.id).eq('ambito', 'balanceado').eq('estado', 'cerrado')
      .gte('fecha', lunes).lte('fecha', fechas[6])
    if (eDias) { setAviso({ tipo: 'error', texto: 'Semana reabierta, pero no los días. ' + eDias.message }); await cargar(true); return }
    setAviso({ tipo: 'ok', texto: 'Semana y días reabiertos' })
    await cargar(true)
  }

  function alTeclear(e, iFila, iDia) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    refs.current[`${iFila + 1}|${iDia}`]?.focus()
  }

  // ¿La celda (o sus extras) tiene el producto del filtro?
  const celTieneProd = (c, prod) => !!c && !c.sinAlimentacion &&
    (c.productoId === prod || (c.extras || []).some(e => e.productoId === prod))
  const piscTieneProd = (p) => fechas.some(f => celTieneProd(cel(p, f), filtroProd))

  const visiblesBase = soloPendientes
    ? piscinas.filter(p => pendientesHoy.includes(p) || atrasadas.some(a => a.p === p))
    : piscinas
  const visibles = filtroProd ? visiblesBase.filter(piscTieneProd) : visiblesBase

  const COLS_BASE = '230px 150px'
  const COLS_DIAS = 'repeat(7, minmax(132px, 1fr)) 104px'
  const COLS_IND = verIndicadores ? ' 104px 96px 104px 96px 92px 92px 92px 116px 104px' : ''
  const COLS = `${COLS_BASE} ${COLS_DIAS}${COLS_IND}`
  const ANCHO = verIndicadores ? '1910px' : '1240px'
  // Resumen del estado de la piscina para la etiqueta colapsada.
  const estadoResumen = p => {
    if (!p.cicloId || p.cosechadaEstaSemana) return { txt: 'Vacía', bg: '#e7f4ef', color: '#0F6E56' }
    const evs = eventos[p.piscinaId] || []
    if (evs.length) { const t = TIPOS[evs[0].tipo] || TIPOS.siembra; return { txt: t.nombre, bg: t.fondo, color: t.color } }
    return { txt: 'Sin novedad', bg: '#f1f4f7', color: GRIS }
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Registro diario</h1>
            {semanaCerrada
              ? <span style={{ background: '#eef2f5', color: GRIS, fontSize: '11px', fontWeight: 500,
                               padding: '3px 10px', borderRadius: '20px' }}>Semana cerrada</span>
              : <span style={{ background: '#E1F5EE', color: '#0F6E56', fontSize: '11px', fontWeight: 500,
                               padding: '3px 10px', borderRadius: '20px' }}>
                  {semanaDeHoy ? 'Semana en curso' : 'Semana anterior'}</span>}
          </div>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana {semanaISO(lunes).semana} · del {corta(lunes)} al {corta(fechas[6])}
            {semanaDeHoy && ` · hoy es ${nombreDia(hoy).toLowerCase()}`}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-end' }}>
          <div style={{ display: 'inline-flex', background: '#e7eef5', borderRadius: '10px', padding: '3px', gap: '3px' }}>
            {['registrar', 'revisar'].map(m => (
              <button key={m} onClick={() => setModo(m)} style={{
                border: 0, background: modo === m ? 'white' : 'transparent', borderRadius: '8px',
                padding: '8px 16px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500,
                color: modo === m ? NAVY : GRIS, cursor: 'pointer',
                boxShadow: modo === m ? '0 1px 2px rgba(2,40,71,.08)' : 'none',
              }}>{m === 'registrar' ? 'Registrar' : 'Revisar'}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
            <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
            <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
            <input
              type="date"
              value={lunes}
              max={hoy}
              title="Ir a la semana de esa fecha"
              onChange={e => { if (e.target.value) setLunes(lunesDe(e.target.value)) }}
              style={{ padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
                       border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }}
            />
          </div>
        </div>
      </div>

      {/* Resumen de la semana en tarjetas. */}
      {(() => {
        const nEng = piscinas.filter(p => p.tipo !== 'precria').length
        const hechas = nEng - pendientesHoy.length
        const pctHoy = nEng ? Math.round(hechas / nEng * 100) : 0
        const diasCerrados = fechas.filter(f => dias[f] === 'cerrado' || dias[f] === 'reabierto').length
        return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
                      gap: '11px', marginBottom: '14px' }}>
          <div style={{ background: NAVY, borderRadius: '12px', padding: '14px 16px' }}>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)' }}>Libras de la semana</div>
            <div style={{ fontSize: '22px', fontWeight: 500, color: 'white' }}>{miles(totalSemana)}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>{(totalSemana / LIBRAS_POR_SACO).toFixed(1)} sacos</div>
          </div>
          <TarjetaReg k="Piscinas activas" v={String(piscinas.filter(p => p.cicloId).length)} />
          {semanaDeHoy && (
            <div style={{ background: '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
              <div style={{ fontSize: '12px', color: GRIS }}>Completadas hoy</div>
              <div style={{ fontSize: '22px', fontWeight: 500 }}>{hechas} de {nEng}</div>
              <div style={{ height: '6px', background: '#e7eef5', borderRadius: '20px', overflow: 'hidden', marginTop: '6px' }}>
                <i style={{ display: 'block', height: '100%', width: pctHoy + '%', background: '#1D9E75', borderRadius: '20px' }} />
              </div>
            </div>
          )}
          <TarjetaReg k="Días cerrados" v={`${diasCerrados} de 7`} />
        </div>
        )
      })()}

      {esJefe && solReapertura.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px',
                      padding: '13px 16px', marginBottom: '12px' }}>
          <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>
            Reaperturas por autorizar ({solReapertura.length})
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

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: GRIS }}>Ver:</span>
        <span style={{ ...chip, background: '#E6F1FB', borderColor: '#9cc4e8', color: AZUL, fontWeight: 500 }}>
          Alimentación
        </span>
        <button onClick={() => setVerIndicadores(v => !v)} style={{
          ...chip, cursor: 'pointer', fontFamily: 'inherit',
          background: verIndicadores ? '#E6F1FB' : 'white',
          borderColor: verIndicadores ? '#9cc4e8' : BORDE,
          color: verIndicadores ? AZUL : GRIS,
          fontWeight: verIndicadores ? 500 : 400,
        }}>Indicadores</button>
        <div style={{ marginLeft: 'auto' }}>
          <BuscadorAplicacion ambito="balanceado" opciones={productos}
            valor={filtroProd} onCambio={setFiltroProd} nPisc={visibles.length} />
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      {semanaCerrada && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap',
                      padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
                      background: '#FAEEDA', color: '#854F0B' }}>
          <span>
            Esta semana ya está cerrada.{' '}
            {esJefe ? 'Puedes reabrirla para corregir.' : 'Para corregir algo, pide a tu jefe que la reabra.'}
          </span>
          {esJefe && !soloLectura && (
            <button onClick={reabrirSemana}
              style={{ background: 'white', border: '0.5px solid #ecd9b3', borderRadius: '8px',
                       padding: '6px 14px', fontFamily: 'inherit', fontSize: '13px', color: '#854F0B', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Reabrir semana
            </button>
          )}
        </div>
      )}

      {modo === 'registrar' && !soloLectura && !semanaCerrada && !semanaDeHoy && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                      background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '11px 14px', marginBottom: '10px' }}>
          <span style={{ fontSize: '13px', color: '#854F0B' }}>
            Estás editando una semana anterior. Los cambios quedan en la bitácora.
          </span>
        </div>
      )}

      {cargando ? (
        <Vacio>Cargando la semana...</Vacio>
      ) : !piscinas.length ? (
        <Vacio>No hay piscinas sembradas en esta semana.</Vacio>
      ) : (
        <>
          <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ overflow: 'auto', maxHeight: '72vh' }}>
              <div style={{ minWidth: ANCHO }}>

                <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                              borderBottom: '0.5px solid ' + BORDE,
                              position: 'sticky', top: 0, zIndex: 4 }}>
                  <Th pegado>Piscina</Th>
                  <Th>Estado</Th>
                  {fechas.map(f => {
                    const s = situacionDia(f, hoy)
                    const est = dias[f]
                    return (
                      <Th key={f} fondo={s === 'hoy' ? HOYB : (s === 'futuro' ? '#fbfcfd' : undefined)}
                          borde={s === 'hoy'}>
                        <span style={{ display: 'block', fontSize: '12px', color: NAVY, fontWeight: 500 }}>
                          {nombreDia(f)}
                        </span>
                        {cortita(f)}
                        {s === 'hoy' && (
                          <span style={{ display: 'block', fontSize: '9px', marginTop: '3px', letterSpacing: '0.04em', color: AZUL }}>Hoy</span>
                        )}
                      </Th>
                    )
                  })}
                  <Th>Total semana</Th>
                  {verIndicadores && (
                    <>
                      <Th>A la fecha</Th>
                      <Th>Libras raleadas</Th>
                      <Th>Consumo prom. semanal</Th>
                      <Th>Libras por ha día</Th>
                      <Th>Gramaje precría</Th>
                      <Th>Peso miércoles</Th>
                      <Th>Peso domingo</Th>
                      <Th>Larva sembrada</Th>
                      <Th>Densidad por ha</Th>
                    </>
                  )}
                </div>

                {visibles.map((p, i) => (
                  <Fragment key={p.piscinaId}>
                  <div style={{ display: 'grid', gridTemplateColumns: COLS,
                        borderBottom: editSiembra === p.piscinaId ? 'none' : '0.5px solid #f1f6f9', alignItems: 'stretch' }}>
                    <Td pegado alineado="left">
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                        <button onClick={() => setAbierta(abierta === p.piscinaId ? null : p.piscinaId)}
                          title="Ver detalle del ciclo"
                          style={{ background: 'none', border: 'none', padding: '2px 0 0', cursor: 'pointer', color: GRIS, lineHeight: 1 }}>
                          <span style={{ fontSize: '11px' }}>{abierta === p.piscinaId ? '▾' : '▸'}</span>
                        </button>
                        <div>
                          <span style={{ fontWeight: 500, fontSize: '14px' }}>{p.nombre}</span>
                          <div style={{ fontSize: '11px', color: GRIS }}>
                            {p.hectareas.toFixed(2)} ha{p.tipo === 'precria' ? ' · precría' : ''}
                            {p.fechaSiembra ? ` · ${p.tipo === 'precria'
                              ? diasCultivo(p.fechaSiembra, corteDias)
                              : diasCultivo(p.fechaOcupacion || p.fechaSiembra, corteDias)} días` : ''}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Estado
                        fila={p} eventos={eventos[p.piscinaId] || []}
                        puede={!soloLectura && modo === 'registrar'}
                        onElegir={tipo => abrirEvento(tipo, p)}
                        onDeshacer={ev => borrarEvento(p, ev)}
                        onEditar={() => { setAbierta(p.piscinaId); setEditSiembra(p.piscinaId) }}
                      />
                    </Td>
                    {fechas.map((f, j) => {
                      const falta = faltantesKeys.has(`${p.piscinaId}|${f}`)
                      const marca = !!filtroProd && celTieneProd(cel(p, f), filtroProd)
                      return (
                      <Td key={f} fondo={falta ? '#FCEBC8'
                                        : marca ? '#E1F5EE'
                                        : situacionDia(f, hoy) === 'hoy' ? HOYB
                                        : situacionDia(f, hoy) === 'futuro' ? '#fbfcfd' : undefined}
                          borde={situacionDia(f, hoy) === 'hoy'}>
                        <Celda
                          p={p} f={f} c={cel(p, f)} productos={productos}
                          editable={editable(f)} situacion={situacionDia(f, hoy)}
                          onProducto={v => set(p, f, 'productoId', v)}
                          onLibras={v => set(p, f, 'libras', v)}
                          onAddExtra={() => addExtra(p, f)}
                          onExtra={(i, campo, v) => setExtra(p, f, i, campo, v)}
                          onRemoveExtra={i => removeExtra(p, f, i)}
                          onSin={() => marcarSin(p, f)}
                          onLimpiar={() => limpiar(p, f)}
                          inputRef={el => { refs.current[`${i}|${j}`] = el }}
                          onKeyDown={e => alTeclear(e, i, j)}
                        />
                      </Td>
                      )
                    })}
                    <Td>{totalPiscina(p) ? (
                      <>
                        <span style={{ fontWeight: 500 }}>{miles(totalPiscina(p))}</span>
                        <div style={{ fontSize: '11px', color: GRIS }}>{(totalPiscina(p) / LIBRAS_POR_SACO).toFixed(1)} sacos</div>
                      </>
                    ) : ''}</Td>
                    {verIndicadores && (() => {
                      const t = totalPiscina(p)
                      const g = pesos[p.piscinaId] || {}
                      return (
                        <>
                          <Td><span style={{ color: GRIS }}>{p.cicloId ? miles(acumulado[p.cicloId] || 0) : ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{raleado[p.cicloId] ? miles(raleado[p.cicloId]) : ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{t ? miles(t / 7) : ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{t && p.hectareas ? (t / p.hectareas / 7).toFixed(1) : ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{p.gramajePrecria ?? ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{g.mie ?? ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{g.dom ?? ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>{p.larva ? miles(p.larva) : ''}</span></Td>
                          <Td><span style={{ color: GRIS }}>
                            {p.larva && p.hectareas ? miles(p.larva / p.hectareas) : ''}
                          </span></Td>
                        </>
                      )
                    })()}
                  </div>
                  {abierta === p.piscinaId && (
                    <div style={{ background: '#f7fafc', borderBottom: '0.5px solid #f1f6f9', padding: '12px 16px 14px 34px' }}>
                      <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontSize: '11px', color: GRIS }}>Sembrada</div>
                          <div style={{ fontSize: '14px' }}>
                            {p.fechaSiembra ? corta(p.fechaSiembra) : '—'}
                            {p.cicloId && !soloLectura && modo === 'registrar' && (
                              <button onClick={() => setEditSiembra(editSiembra === p.piscinaId ? null : p.piscinaId)}
                                style={{ background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', padding: '0 0 0 8px' }}>{editSiembra === p.piscinaId ? 'Cerrar' : 'Editar'}</button>
                            )}
                            {p.cicloId && p.siembraLimpia && esJefe && !soloLectura && modo === 'registrar' && (
                              <button onClick={() => eliminarSiembra(p)}
                                style={{ background: 'none', border: 'none', color: ROJO, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', padding: '0 0 0 8px' }}>eliminar siembra</button>
                            )}
                          </div>
                        </div>
                        {p.cicloId && (
                          <div>
                            <div style={{ fontSize: '11px', color: GRIS }}>Larva</div>
                            <div style={{ fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>{p.larva ? miles(p.larva) : '—'}</div>
                          </div>
                        )}
                        {p.cicloId && (
                          <div>
                            <div style={{ fontSize: '11px', color: GRIS }}>Gramaje</div>
                            <div style={{ fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>{p.gramajePrecria != null ? p.gramajePrecria + (p.tipo === 'precria' ? ' PLs/g' : ' g') : '—'}</div>
                          </div>
                        )}
                        {p.cicloId && p.tipo !== 'precria' && p.fechaSiembra && (() => {
                          const ocup = p.fechaOcupacion || p.fechaSiembra
                          const precria = ocup !== p.fechaSiembra ? diasCultivo(p.fechaSiembra, ocup) : 0
                          const engorde = diasCultivo(ocup, corteDias)
                          const secado = p.prevCierre ? diasCultivo(p.prevCierre, ocup) : 0
                          const partes = []
                          if (precria > 0) partes.push(`${precria} en precría`)
                          partes.push(`${engorde} de engorde`)
                          if (secado > 0) partes.push(`${secado} de secado`)
                          return (
                            <div>
                              <div style={{ fontSize: '11px', color: GRIS }}>Fases</div>
                              <div style={{ fontSize: '14px' }}>{partes.join(' · ')}</div>
                            </div>
                          )
                        })()}
                        <div style={{ minWidth: '160px' }}>
                          <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Laboratorio</div>
                          <Laboratorio fila={p} laboratorios={laboratorios}
                            puede={!soloLectura && modo === 'registrar' && !semanaCerrada}
                            onElegir={id => cambiarLaboratorio(p, id)} onNuevo={() => nuevoLaboratorio(p)} />
                        </div>
                      </div>
                      {p.cicloId && <TransferenciaInfo cicloId={p.cicloId} />}
                      {editSiembra === p.piscinaId && (
                        <div style={{ marginTop: '10px' }}>
                          <EditorSiembra p={p} onGuardar={guardarSiembra} onCancelar={() => setEditSiembra(null)} />
                        </div>
                      )}
                    </div>
                  )}
                  </Fragment>
                ))}

                <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                              borderTop: '0.5px solid ' + BORDE, alignItems: 'center' }}>
                  <Td pegado alineado="left" fondo="#fafcfd">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>Total</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>{hectareas.toFixed(2)} ha · {piscinas.length} piscinas</div>
                  </Td>
                  <Td fondo="#fafcfd" />
                  {fechas.map(f => (
                    <Td key={f} fondo={situacionDia(f, hoy) === 'hoy' ? HOYB : '#fafcfd'}
                        borde={situacionDia(f, hoy) === 'hoy'}>
                      {situacionDia(f, hoy) === 'futuro' ? <span style={{ color: GRIS }}>—</span> : (
                        <>
                          <span style={{ fontWeight: 500 }}>{miles(totalDia(f)) || '0'}</span>
                          <div style={{ fontSize: '11px', color: GRIS }}>{(totalDia(f) / LIBRAS_POR_SACO).toFixed(1)} sacos</div>
                        </>
                      )}
                    </Td>
                  ))}
                  <Td fondo="#fafcfd">
                    <span style={{ fontWeight: 500, fontSize: '16px' }}>{miles(totalSemana)}</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>{(totalSemana / LIBRAS_POR_SACO).toFixed(1)} sacos</div>
                  </Td>
                  {verIndicadores && Array.from({ length: 9 }, (_, k) => <Td key={k} fondo="#fafcfd" />)}
                </div>
              </div>
            </div>

            {atrasadas.length > 0 && modo === 'registrar' && (
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px',
                            padding: '9px 16px', background: '#FAEEDA', color: '#854F0B' }}>
                <span>
                  {atrasadas.length === 1
                    ? `${atrasadas[0].p.nombre} quedó sin registrar el ${nombreDia(atrasadas[0].f).toLowerCase()}.`
                    : `Hay ${atrasadas.length} celdas sin registrar en días anteriores.`}
                  {' '}Ponles las libras o márcalas sin alimentación.
                </span>
                {/* Reabrir los días cerrados que tienen celdas atrasadas */}
                {!soloLectura && !semanaCerrada && [...new Set(atrasadas.map(a => a.f))]
                  .filter(f => dias[f] === 'cerrado')
                  .map(f => (
                    <span key={f} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      {esJefe
                        ? <button onClick={() => reabrirDia(f)} style={{ background: 'white', border: '0.5px solid #ecd9b3', borderRadius: '8px', padding: '5px 10px', fontFamily: 'inherit', fontSize: '12px', color: '#854F0B', cursor: 'pointer' }}>Reabrir {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}</button>
                        : solReapertura.some(x => x.registro_id === diasId[f])
                          ? <span style={{ fontSize: '12px' }}>Pedido de {nombreDia(f).slice(0, 3)} enviado</span>
                          : <button onClick={() => pedirReabrir(f)} style={{ background: 'white', border: '0.5px solid #ecd9b3', borderRadius: '8px', padding: '5px 10px', fontFamily: 'inherit', fontSize: '12px', color: '#854F0B', cursor: 'pointer' }}>Pedir reabrir {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}</button>}
                    </span>
                  ))}
              </div>
            )}

            {/* Reabrir CUALQUIER día cerrado de la semana (aunque esté
                completo), para poder corregir. Independiente de si tiene
                celdas sin registrar. */}
            {!soloLectura && !semanaCerrada && modo === 'registrar' && (() => {
              const yaArriba = new Set(atrasadas.map(a => a.f))
              const cerrados = fechas.filter(f => dias[f] === 'cerrado' && !yaArriba.has(f))
              if (cerrados.length === 0) return null
              return (
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px',
                              padding: '9px 16px', background: '#F4F7FA', color: GRIS, borderTop: '0.5px solid ' + BORDE }}>
                  <span>¿Necesitas corregir un día ya cerrado?</span>
                  {cerrados.map(f => (
                    <span key={f}>
                      {esJefe
                        ? <button onClick={() => reabrirDia(f)} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '5px 10px', fontFamily: 'inherit', fontSize: '12px', color: NAVY, cursor: 'pointer' }}>Reabrir {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}</button>
                        : solReapertura.some(x => x.registro_id === diasId[f])
                          ? <span style={{ fontSize: '12px' }}>Pedido de {nombreDia(f).slice(0, 3)} enviado</span>
                          : <button onClick={() => pedirReabrir(f)} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '5px 10px', fontFamily: 'inherit', fontSize: '12px', color: NAVY, cursor: 'pointer' }}>Pedir reabrir {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}</button>}
                    </span>
                  ))}
                </div>
              )
            })()}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '16px', flexWrap: 'wrap', padding: '14px 16px',
                          borderTop: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
              <div style={{ display: 'flex', gap: '30px' }}>
                {semanaDeHoy && <Dato k="Libras de hoy" v={miles(totalDia(hoy)) || '0'} />}
                <Dato k="Sacos de la semana" v={(totalSemana / LIBRAS_POR_SACO).toFixed(1)} />
                <Dato k="Total de la semana" v={miles(totalSemana)} />
              </div>
              {!soloLectura && modo === 'registrar' && !semanaCerrada && (
                (semanaDeHoy && dias[hoy] === 'cerrado') ? (
                  <div style={{ display: 'flex', gap: '9px', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', color: GRIS }}>El día de hoy está cerrado.</span>
                    {esJefe
                      ? <Btn onClick={() => reabrirDia(hoy)}>Reabrir día</Btn>
                      : solReapertura.some(x => x.registro_id === diasId[hoy])
                        ? <span style={{ fontSize: '13px', color: '#BA7517' }}>Pedido de reapertura enviado</span>
                        : <Btn onClick={() => pedirReabrir(hoy)}>Pedir reabrir</Btn>}
                  </div>
                ) : (
                <div style={{ display: 'flex', gap: '9px' }}>
                  <Btn onClick={() => guardar(false)} disabled={guardando}>
                    {guardando ? 'Guardando...' : (semanaDeHoy ? 'Guardar borrador' : 'Guardar cambios')}
                  </Btn>
                  {semanaDeHoy && dias[hoy] !== 'cerrado' && (
                    <Btn primario onClick={pedirCerrarDia} disabled={guardando}>Cerrar día</Btn>
                  )}
                </div>
                )
              )}
            </div>
          </div>

          {dialogo && (
            <DialogoEvento
              tipo={dialogo.tipo}
              ciclo={dialogo.fila}
              piscina={dialogo.fila}
              laboratorios={laboratorios}
              destinosPosibles={piscinas
                .filter(x => x.piscinaId !== dialogo.fila.piscinaId && !x.siembraPosterior)
                .map(x => ({ id: x.piscinaId, nombre: x.nombre,
                             ocupada: !!x.cicloId && !x.cosechadaEstaSemana }))}
              minima={dialogo.tipo === 'siembra' ? undefined : dialogo.fila.fechaSiembra}
              onCancelar={() => setDialogo(null)}
              onGuardar={registrarEvento}
              onLaboratorioAgregado={l =>
                setLaboratorios(ls => [...ls, l].sort((a, b) => a.nombre.localeCompare(b.nombre)))}
            />
          )}

          {/* Cerrar días de la semana: panel aparte, arriba del cierre de
              semana. Se puede cerrar día por día o todos de una vez. */}
          {!soloLectura && !semanaCerrada && (() => {
            const faltan = fechas.filter(f => dias[f] !== 'cerrado' && dias[f] !== 'reabierto'
                                             && f !== hoy && situacionDia(f, hoy) !== 'futuro')
            if (!faltan.length) return null
            return (
              <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                            padding: '14px 18px', marginTop: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <div style={{ fontSize: '15px', fontWeight: 500 }}>Cerrar días de la semana</div>
                  <Btn onClick={cerrarDiasPendientes}>Cerrar todos ({faltan.length})</Btn>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {faltan.map(f => (
                    <button key={f} onClick={() => cerrarUnDia(f)}
                      style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px',
                               padding: '7px 12px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }}>
                      Cerrar {nombreDia(f).slice(0, 3)} {corta(f).slice(0, 5)}
                    </button>
                  ))}
                </div>
              </div>
            )
          })()}

          <Cierre
            validaciones={validaciones}
            onRevisar={revisarSemana}
            onCerrar={cerrarSemana}
            puedeCerrar={!semanaCerrada && !soloLectura}
            cerrada={semanaCerrada}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Detalle de transferencia (se carga al abrir la flechita): a dónde se
// fue el camarón de este ciclo y con qué reparto, y de dónde vino.
// ---------------------------------------------------------------------
function TransferenciaInfo({ cicloId }) {
  const [envio, setEnvio] = useState([])   // destinos a los que se transfirió
  const [recibio, setRecibio] = useState([])  // de dónde vino
  useEffect(() => {
    let vivo = true
    ;(async () => {
      const [{ data: evs }, { data: dst }] = await Promise.all([
        supabase.schema('produccion').from('evento')
          .select('fecha, evento_destino ( porcentaje, cantidad, piscina:piscina_id ( nombre ) )')
          .eq('ciclo_id', cicloId).eq('tipo', 'transferencia'),
        supabase.schema('produccion').from('evento_destino')
          .select('porcentaje, cantidad, evento:evento_id ( fecha, gramaje, ciclo:ciclo_id ( cantidad_larva, gramaje_precria, piscina:piscina_origen_id ( nombre ) ) )')
          .eq('ciclo_destino_id', cicloId),
      ])
      if (!vivo) return
      const env = []
      ;(evs || []).forEach(e => (e.evento_destino || []).forEach(d =>
        env.push({ fecha: e.fecha, nombre: d.piscina?.nombre || '—', porc: d.porcentaje, cant: d.cantidad })))
      setEnvio(env)
      setRecibio((dst || []).map(d => ({
        fecha: d.evento?.fecha, origen: d.evento?.ciclo?.piscina?.nombre || null,
        porc: d.porcentaje, cant: d.cantidad,
        larvaPadre: d.evento?.ciclo?.cantidad_larva || null,
        plsG: d.evento?.ciclo?.gramaje_precria || null,
        gramaje: d.evento?.gramaje || null })))
    })()
    return () => { vivo = false }
  }, [cicloId])

  if (!envio.length && !recibio.length) return null
  const linea = { fontSize: '12px', color: NAVY, marginTop: '3px' }
  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '0.5px solid #e8eef4' }}>
      {recibio.map((r, i) => {
        const surv = r.cant != null && r.larvaPadre ? (r.cant / r.larvaPadre) * 100 : null
        const chip = { fontSize: '11px', borderRadius: '11px', padding: '1px 8px', display: 'inline-block' }
        return (
          <div key={'r' + i} style={{ ...linea, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
            <span>
              <span style={{ color: '#3C3489', fontWeight: 500 }}>Recibió</span>{' '}
              {r.origen ? <>desde <b>{r.origen}</b> </> : ''}
              {r.fecha ? `el ${corta(r.fecha)} · ` : ''}
              {r.cant != null ? `${miles(r.cant)} animales` : `${Math.round(r.porc)}%`}
            </span>
            {surv != null && <span style={{ ...chip, background: '#E1F5EE', color: '#0F6E56' }}>Sobrevivencia {Math.round(surv * 10) / 10}%</span>}
            {r.gramaje != null && <span style={{ ...chip, background: '#E6F1FB', color: AZUL }}>Gramaje {r.gramaje} g</span>}
          </div>
        )
      })}
      {envio.length > 0 && (
        <div style={linea}>
          <span style={{ color: '#3C3489', fontWeight: 500 }}>Transferida</span>{' '}
          {envio[0].fecha ? `el ${corta(envio[0].fecha)} a: ` : 'a: '}
          {envio.map((e, i) => (
            <span key={i}>{i > 0 ? ', ' : ''}{e.nombre} ({e.cant != null ? `${miles(e.cant)}` : `${Math.round(e.porc)}%`})</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Celda: las tres situaciones de la regla 2.3
// ---------------------------------------------------------------------
function Celda({ p, f, c, productos, editable, situacion, onProducto, onLibras, onAddExtra, onExtra, onRemoveExtra, onSin, onLimpiar, inputRef, onKeyDown }) {
  if (!p.cicloId) {
    return <div style={{ color: '#c3d0db', fontSize: '12px' }}>—</div>
  }
  // Come desde que ocupa la piscina (siembra, o transferencia si vino de
  // otra) hasta que el ciclo cierra.
  if (f < (p.fechaOcupacion || p.fechaSiembra) || (p.fechaCierre && f > p.fechaCierre)) {
    return <div style={{ color: '#c3d0db', fontSize: '12px' }}>—</div>
  }
  if (situacion === 'futuro') {
    return <div style={{ color: GRIS, fontSize: '13px' }}>—</div>
  }

  if (c?.sinAlimentacion) {
    return (
      <div style={{ ...cajaSinAlim, cursor: editable ? 'pointer' : 'default' }}
           onClick={() => editable && onLimpiar()}
           title={editable ? 'Clic para volver a registrar libras' : undefined}>
        Sin alimentación
      </div>
    )
  }

  const extras = (c?.extras || [])

  if (!editable) {
    const conExtras = extras.filter(e => numDec(e.libras) && e.productoId)
    if ((!c || !numDec(c.libras)) && conExtras.length === 0) return <div style={cajaVacia}>Sin registrar</div>
    const filas = []
    if (numDec(c?.libras)) filas.push({ productoId: c.productoId, libras: c.libras })
    conExtras.forEach(e => filas.push(e))
    const total = filas.reduce((s, x) => s + (numDec(x.libras) || 0), 0)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {filas.map((x, i) => {
          const pr = productos.find(y => y.id === x.productoId)
          return (
            <div key={i}>
              <div style={{ fontSize: '11px', color: GRIS }}>{pr?.nombre_corto || ''}</div>
              <div style={{ fontSize: '15px' }}>{miles(numDec(x.libras))}</div>
            </div>
          )
        })}
        {filas.length > 1 && (
          <div style={{ fontSize: '11px', color: GRIS, borderTop: '0.5px solid ' + BORDE, paddingTop: '2px' }}>
            Total {miles(total)}
          </div>
        )}
      </div>
    )
  }

  const selBal = (valor, onChange, key, ref, kd) => (
    <select
      value={valor || ''}
      onChange={e => onChange(e.target.value)}
      title={productos.find(x => x.id === valor)?.nombre || 'Elegir balanceado'}
      style={{ fontFamily: 'inherit', fontSize: '11px', padding: '5px', width: '100%',
               border: '0.5px solid ' + BORDE, borderRadius: '7px', background: 'white' }}
    >
      <option value="">Elegir balanceado</option>
      {productos.map(pr => <option key={pr.id} value={pr.id}>{pr.nombre}</option>)}
    </select>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {selBal(c?.productoId, onProducto)}
      <CampoNumero
        maxDec={2} placeholder="0"
        value={c?.libras || ''}
        ref={inputRef}
        onKeyDown={onKeyDown}
        onChange={v => onLibras(v)}
        style={{ fontFamily: 'inherit', fontSize: '15px', padding: '6px', width: '100%',
                 textAlign: 'center', border: '0.5px solid ' + BORDE, borderRadius: '7px',
                 fontVariantNumeric: 'tabular-nums' }}
      />
      {extras.map((e, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '4px',
             borderTop: '0.5px dashed ' + BORDE, paddingTop: '5px', marginTop: '1px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: GRIS }}>Balanceado extra</span>
            <button
              onClick={() => onRemoveExtra(i)}
              title="Quitar este balanceado"
              style={{ border: 'none', background: 'none', cursor: 'pointer',
                       fontFamily: 'inherit', fontSize: '11px', color: '#c0392b',
                       padding: '2px 4px', textDecoration: 'underline' }}>
              Quitar
            </button>
          </div>
          {selBal(e.productoId, v => onExtra(i, 'productoId', v))}
          <CampoNumero
            maxDec={2} placeholder="0"
            value={e.libras || ''}
            onChange={v => onExtra(i, 'libras', v)}
            style={{ fontFamily: 'inherit', fontSize: '15px', padding: '6px', width: '100%',
                     textAlign: 'center', border: '0.5px solid ' + BORDE, borderRadius: '7px',
                     fontVariantNumeric: 'tabular-nums' }}
          />
        </div>
      ))}
      {numDec(c?.libras) && c?.productoId && extras.every(e => numDec(e.libras) && e.productoId) ? (
        <button
          onClick={onAddExtra}
          title="Registrar otro balanceado en esta misma piscina y día"
          style={{ border: '0.5px solid ' + BORDE, background: '#f7fafc', cursor: 'pointer',
                   fontFamily: 'inherit', fontSize: '10px', color: GRIS, padding: '4px 6px',
                   borderRadius: '6px', width: '100%' }}>
          + Otro balanceado
        </button>
      ) : null}
      {!numDec(c?.libras) && extras.length === 0 && (
        <button
          onClick={onSin}
          title="Declarar que esta piscina no comió ese día"
          style={{ border: '0.5px solid ' + BORDE, background: '#f7fafc', cursor: 'pointer',
                   fontFamily: 'inherit', fontSize: '10px', color: GRIS, padding: '4px 6px',
                   borderRadius: '6px', width: '100%' }}>
          No comió
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Columna de laboratorio. Se puede llenar o corregir en cualquier
// momento del ciclo, no solo al sembrar.
// ---------------------------------------------------------------------
function Laboratorio({ fila, laboratorios, puede, onElegir, onNuevo }) {
  if (!fila.cicloId) return <span />
  if (!puede) {
    return <span style={{ color: GRIS, fontSize: '12px' }}>{fila.laboratorio || '—'}</span>
  }
  const vacio = !fila.laboratorioId
  return (
    <select
      value={fila.laboratorioId || ''}
      onChange={e => e.target.value === '__nuevo' ? onNuevo() : onElegir(e.target.value)}
      title={fila.laboratorio || 'Elegir laboratorio'}
      style={{ fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px', width: '100%',
               borderRadius: '7px', background: 'white',
               border: '0.5px solid ' + (vacio ? '#e8d5b0' : BORDE),
               color: vacio ? '#BA7517' : GRIS }}
    >
      <option value="">{vacio ? 'Sin laboratorio' : 'Quitar'}</option>
      {laboratorios.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
      {/* Agregar lo puede hacer cualquiera: si llega larva de un
          laboratorio que no esta en la lista, el bodeguero no puede
          quedarse esperando a que le contesten. Renombrar y desactivar
          siguen siendo del jefe, porque el catalogo es de las nueve
          fincas. */}
      <option value="__nuevo">+ Agregar laboratorio nuevo</option>
    </select>
  )
}

// ---------------------------------------------------------------------
// Columna de estado: es la columna ESTADO PISCINA del Excel.
// Si la piscina no tiene ciclo, lo unico posible es sembrarla.
// ---------------------------------------------------------------------
function Estado({ fila, eventos, puede, onElegir, onDeshacer, onEditar }) {
  // Tras cosechar o transferir, la piscina queda vacia y puede volver a
  // sembrarse esta misma semana.
  const vacia = !fila.cicloId || fila.cosechadaEstaSemana

  // Todos los eventos de la piscina esta semana, cada uno con su pill y
  // su Deshacer. Puede haber cosecha y luego siembra el mismo periodo.
  const pills = eventos.length > 0 && (
    <div style={{ marginBottom: puede ? '6px' : 0, display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {eventos.map(ev => {
        const t = TIPOS[ev.tipo] || TIPOS.siembra
        return (
          <div key={ev.id}>
            <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 9px', borderRadius: '20px',
                           background: t.fondo, color: t.color }}>{t.nombre}</span>
            <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px' }}>
              {corta(ev.fecha)}{ev.libras ? ` · ${miles(ev.libras)} lb` : ''}
              {puede && onEditar && ev.tipo === 'siembra' && (
                <button onClick={onEditar} title="Corregir fecha, larva o gramaje de la siembra"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                           fontSize: '11px', color: AZUL, padding: '0 0 0 7px' }}>
                  Editar
                </button>
              )}
              {puede && onDeshacer && (
                <button onClick={() => onDeshacer(ev)} title="Deshacer, me equivoqué"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                           fontSize: '11px', color: '#A32D2D', padding: '0 0 0 7px' }}>
                  Deshacer
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )

  if (!puede) return pills || <span style={{ color: '#c3d0db', fontSize: '12px' }}>—</span>

  if (fila.cicloCerrado) {
    return pills || <span style={{ color: GRIS, fontSize: '12px' }}>Ciclo cerrado</span>
  }

  // Vacia esta semana pero sembrada mas adelante: no se puede sembrar
  // otra vez. Antes se ofrecia Sembrar y la base lo rechazaba.
  if (vacia && fila.siembraPosterior) {
    return (
      <div>
        {pills}
        <span style={{ color: GRIS, fontSize: '12px' }}>
          Vacía · se siembra el {corta(fila.siembraPosterior)}
        </span>
      </div>
    )
  }

  const opciones = vacia
    ? [['siembra', 'Sembrar']]
    : [['raleo', 'Raleo'], ['transferencia', 'Transferencia'], ['cosecha', 'Cosecha']]

  return (
    <div>
      {pills}
      <select
        value=""
        onChange={e => { if (e.target.value) onElegir(e.target.value) }}
        style={{ fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px', width: '100%',
                 borderRadius: '7px', background: vacia ? '#E1F5EE' : 'white',
                 border: '0.5px solid ' + (vacia ? '#9fe1cb' : BORDE),
                 color: vacia ? '#0F6E56' : GRIS,
                 fontWeight: vacia ? 500 : 400 }}
      >
        <option value="">{vacia ? (fila.cosechadaEstaSemana ? 'Sembrar de nuevo' : 'Vacía') : 'Sin novedad'}</option>
        {opciones.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------
// Panel de cierre de semana (regla 5.1)
// ---------------------------------------------------------------------
function Cierre({ validaciones, onRevisar, onCerrar, puedeCerrar, cerrada }) {
  const todas = Array.isArray(validaciones) && validaciones.length > 0 && validaciones.every(v => v.pasa)
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '16px 18px', marginTop: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Cerrar la semana</h3>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0, maxWidth: '620px' }}>
            {cerrada ? 'Esta semana ya está cerrada.'
              : 'Esto se cierra al final de la semana (domingo). Durante la semana solo cierras cada día con “Cerrar día”; cuando estén los 7, se puede cerrar la semana. Cada validación dice qué revisar.'}
          </p>
        </div>
        {!cerrada && <Btn onClick={onRevisar}>Revisar cuadres</Btn>}
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
                        gap: '9px', marginTop: '14px', flexWrap: 'wrap' }}>
            <Btn primario disabled={!todas || !puedeCerrar} onClick={onCerrar}>
              {puedeCerrar ? 'Cerrar semana' : 'No se puede cerrar'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Piezas sueltas
// ---------------------------------------------------------------------
const chip = { border: '0.5px solid ' + BORDE, borderRadius: '20px', padding: '7px 14px',
               fontSize: '13px', background: 'white' }
const cajaVacia = { border: '1px dashed #c9d8e5', borderRadius: '7px', padding: '9px 6px',
                    color: '#adbccb', fontSize: '12px' }
const cajaSuave = { border: '1px dashed #e3ebf2', borderRadius: '7px', padding: '9px 6px',
                    color: '#c3d0db', fontSize: '12px' }
const cajaSinAlim = { background: '#f2f5f8', borderRadius: '7px', padding: '9px 6px',
                      color: GRIS, fontSize: '13px' }

function Th({ children, pegado, fondo, borde }) {
  return (
    <div style={{
      padding: '10px 9px', fontSize: '11px', color: GRIS, fontWeight: 500, textAlign: 'center',
      background: fondo || '#fafcfd',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 3, textAlign: 'left',
                     paddingLeft: '16px', borderRight: '0.5px solid ' + BORDE } : {}),
      ...(borde ? { boxShadow: `inset 2px 0 0 ${HOYL}, inset -2px 0 0 ${HOYL}` } : {}),
    }}>{children}</div>
  )
}

function Td({ children, pegado, fondo, borde, alineado }) {
  return (
    <div style={{
      padding: '9px', textAlign: alineado || 'center', fontSize: '13px',
      fontVariantNumeric: 'tabular-nums',
      background: fondo || 'white',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 2, paddingLeft: '16px',
                     borderRight: '0.5px solid ' + BORDE } : {}),
      ...(borde ? { boxShadow: `inset 2px 0 0 ${HOYL}, inset -2px 0 0 ${HOYL}` } : {}),
    }}>{children}</div>
  )
}

function Btn({ children, onClick, primario, fantasma, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: primario ? AZUL : (fantasma ? 'transparent' : 'white'),
      color: primario ? 'white' : (fantasma ? GRIS : NAVY),
      border: '0.5px solid ' + (primario ? AZUL : (fantasma ? 'transparent' : BORDE)),
      borderRadius: '9px', padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px',
      fontWeight: primario ? 500 : 400,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}

const Sep = () => <span style={{ width: '1px', height: '22px', background: BORDE }} />

// Editor en línea de larva y gramaje de siembra de un ciclo abierto.
function EditorSiembra({ p, onGuardar, onCancelar }) {
  const [larva, setLarva] = useState(p.larva != null ? String(p.larva) : '')
  const [gramaje, setGramaje] = useState(p.gramajePrecria != null ? String(p.gramajePrecria) : '')
  const [fecha, setFecha] = useState(p.fechaSiembra || '')
  const [enviando, setEnviando] = useState(false)
  return (
    <div style={{ background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9',
                  padding: '12px 16px', display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div style={{ fontSize: '13px', color: NAVY, fontWeight: 500, alignSelf: 'center' }}>
        Siembra de {p.nombre}
      </div>
      <div>
        <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Fecha de siembra</div>
        <input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)}
          style={{ padding: '8px 11px', fontSize: '14px', fontFamily: 'inherit',
                   border: '0.5px solid ' + BORDE, borderRadius: '9px' }} />
      </div>
      <div>
        <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Larva sembrada</div>
        <input inputMode="numeric" value={larva} onChange={e => setLarva(e.target.value)} placeholder="ej. 850000"
          style={{ padding: '8px 11px', fontSize: '14px', fontFamily: 'inherit', width: '150px',
                   border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right' }} />
      </div>
      <div>
        <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Gramaje de siembra (g)</div>
        <input inputMode="decimal" value={gramaje} onChange={e => setGramaje(e.target.value)} placeholder="ej. 0.02"
          style={{ padding: '8px 11px', fontSize: '14px', fontFamily: 'inherit', width: '130px',
                   border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right' }} />
      </div>
      <button disabled={enviando}
        onClick={async () => { setEnviando(true); await onGuardar(p, larva, gramaje, fecha); setEnviando(false) }}
        style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px', padding: '9px 18px',
                 fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer', opacity: enviando ? 0.5 : 1 }}>
        {enviando ? 'Guardando...' : 'Guardar'}
      </button>
      <button onClick={onCancelar}
        style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '9px 16px',
                 fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }}>Cancelar</button>
    </div>
  )
}

function TarjetaReg({ k, v }) {
  return (
    <div style={{ background: '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '12px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 500 }}>{v}</div>
    </div>
  )
}
function Dato({ k, v }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '18px', fontWeight: 500 }}>{v}</div>
    </div>
  )
}

function Vacio({ children }) {
  return (
    <div style={{ padding: '3rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE,
                  borderRadius: '12px', color: GRIS, fontSize: '14px', background: 'white' }}>
      {children}
    </div>
  )
}

function ordenar(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return (parseInt(a.codigo.replace(/\D/g, ''), 10) || 0) - (parseInt(b.codigo.replace(/\D/g, ''), 10) || 0)
}
