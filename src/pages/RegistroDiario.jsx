import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import DialogoEvento, { TIPOS, guardarEvento } from './DialogoEvento'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, corta, cortita,
  nombreDia, esDiaDeMuestreo, diasCultivo, semanaISO, situacionDia, num, miles,
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
const HOYB = '#E6F1FB'
const HOYL = '#85B7EB'

export default function RegistroDiario({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const [piscinas, setPiscinas] = useState([])
  const [productos, setProductos] = useState([])
  const [celdas, setCeldas] = useState({})       // clave `${piscinaId}|${fecha}`
  const [dias, setDias] = useState({})           // estado por fecha
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
  const refs = useRef({})

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const semanaDeHoy = lunesDe(hoy) === lunes

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
          .eq('finca_id', finca.id).eq('activa', true),
        supabase.schema('produccion').from('ciclo')
          .select('id, fecha_siembra, fecha_cierre, estado, cantidad_larva, gramaje_precria, piscina_origen_id, laboratorio_id, laboratorio:laboratorio_id (nombre)')
          .eq('finca_id', finca.id),
        supabase.schema('produccion').from('laboratorio')
          .select('id, nombre').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('producto')
          .select('id, nombre, nombre_corto').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('dia_registro')
          .select('fecha, estado').eq('finca_id', finca.id)
          .gte('fecha', lunes).lte('fecha', domingo),
        supabase.schema('produccion').from('semana_cerrada')
          .select('id').eq('finca_id', finca.id)
          .eq('anio', semanaISO(lunes).anio).eq('semana', semanaISO(lunes).semana)
          .maybeSingle(),
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
      // La siembra mas cercana posterior a esta semana, si existe.
      const posterior = {}
      ;(ciclos || []).forEach(c => {
        const pid = c.piscina_origen_id
        if (c.fecha_siembra > domingo) {
          if (!posterior[pid] || c.fecha_siembra < posterior[pid]) posterior[pid] = c.fecha_siembra
          return
        }
        if (c.fecha_cierre && c.fecha_cierre < lunes) return
        const previo = porPiscina[pid]
        if (!previo || c.fecha_siembra > previo.fecha_siembra) porPiscina[pid] = c
      })

      const lista = (todas || []).map(p => {
        const c = porPiscina[p.id]
        return {
          cicloId: c?.id || null, piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
          hectareas: Number(p.hectareas), tipo: p.tipo,
          fechaSiembra: c?.fecha_siembra || null, larva: c?.cantidad_larva || null,
          fechaCierre: c?.fecha_cierre || null,
          laboratorioId: c?.laboratorio_id || '',
          // Un ciclo esta cerrado PARA ESTA SEMANA solo si termino antes
          // del lunes. Mirar estado seria mirar la foto de hoy: la P2
          // cosecho el 18 de junio, y en la semana del 15 al 21 todavia
          // estaba viva y hay que poder registrarle esa cosecha.
          cicloCerrado: !!(c?.fecha_cierre && c.fecha_cierre < lunes),
          // Vacia esta semana, pero ya sembrada mas adelante. No se puede
          // volver a sembrar: la base solo admite un ciclo abierto por
          // piscina, y con razon.
          siembraPosterior: posterior[p.id] || null,
          laboratorio: c?.laboratorio?.nombre || null,
          gramajePrecria: c?.gramaje_precria ?? null,
        }
      }).sort(ordenar)
      setPiscinas(lista)

      setLaboratorios(labs || [])
      setProductos(prods || [])

      const md = {}
      ;(dr || []).forEach(d => { md[d.fecha] = d.estado })
      setDias(md)
      setSemanaCerrada(!!sc)

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
      ] = await Promise.all([
        ids.length ? supabase.schema('produccion').from('evento')
          .select('id, tipo, fecha, libras, piscina_origen_id')
          .in('piscina_origen_id', ids).gte('fecha', lunes).lte('fecha', domingo)
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
      ])

      // Si esta consulta falla y nadie mira el error, la semana se
      // dibuja vacia y parece que se borraron los datos. Nunca mas.
      if (eAlim) throw new Error('No se pudo leer la alimentación de la semana. ' + eAlim.message)

      const evs = {}
      ;(evs1 || []).forEach(x => { evs[x.piscina_origen_id] = x })
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

      const mapa = {}
      ;(alim || []).forEach(a => {
        mapa[`${a.piscina_id}|${a.fecha}`] = {
          id: a.id,
          productoId: a.producto_id || '',
          libras: a.sin_alimentacion ? '' : String(a.libras),
          sinAlimentacion: a.sin_alimentacion,
        }
      })
      setCeldas(mapa)

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
    if (esJefe) return true
    // El bodeguero trabaja su semana entera, no solo el dia de hoy. Si
    // se le paso cerrar el viernes, el lunes tiene que poder volver.
    // Semanas anteriores siguen siendo cosa del jefe.
    return semanaDeHoy
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
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    }
  }

  const clave = (p, f) => `${p.piscinaId}|${f}`
  const cel = (p, f) => celdas[clave(p, f)]

  function set(p, f, campo, valor) {
    const k = clave(p, f)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}), [campo]: valor, sinAlimentacion: false } }))
    setSucio(true)
  }

  function marcarSin(p, f) {
    const k = clave(p, f)
    setCeldas(c => ({ ...c, [k]: { ...(c[k] || {}), sinAlimentacion: true, libras: '', productoId: '' } }))
    setSucio(true)
  }

  function limpiar(p, f) {
    const k = clave(p, f)
    setCeldas(c => { const n = { ...c }; delete n[k]; return n })
    setSucio(true)
  }

  function copiarDiaAnterior(f) {
    const previo = sumarDias(f, -1)
    const nuevo = { ...celdas }
    piscinas.forEach(p => {
      const src = celdas[clave(p, previo)]
      if (src && !src.sinAlimentacion && src.libras) {
        nuevo[clave(p, f)] = { ...nuevo[clave(p, f)], productoId: src.productoId, libras: src.libras, sinAlimentacion: false }
      }
    })
    setCeldas(nuevo); setSucio(true)
    setAviso({ tipo: 'ok', texto: `Se copió el ${nombreDia(previo).toLowerCase()}. Revisa antes de guardar.` })
  }

  // ---- totales, todos calculados (regla P1) ----
  const totalPiscina = p =>
    fechas.reduce((s, f) => s + (cel(p, f)?.sinAlimentacion ? 0 : (num(cel(p, f)?.libras) || 0)), 0)
  const totalDia = f =>
    piscinas.reduce((s, p) => s + (cel(p, f)?.sinAlimentacion ? 0 : (num(cel(p, f)?.libras) || 0)), 0)
  const totalSemana = useMemo(
    () => piscinas.reduce((s, p) => s + totalPiscina(p), 0), [piscinas, celdas, fechas])
  const hectareas = useMemo(
    () => piscinas.reduce((s, p) => s + p.hectareas, 0), [piscinas])

  // Regla 2.4: solo cuenta lo pendiente de hoy y lo atrasado de dias pasados.
  const pendientesHoy = piscinas.filter(p => {
    if (!p.cicloId) return false
    if (p.tipo === 'precria') return false
    const c = cel(p, hoy)
    return !c || (!c.sinAlimentacion && !num(c.libras))
  })
  const atrasadas = []
  fechas.forEach(f => {
    if (situacionDia(f, hoy) !== 'pasado') return
    piscinas.forEach(p => {
      if (!p.cicloId || p.tipo === 'precria') return
      if (p.fechaSiembra && f < p.fechaSiembra) return
      if (p.fechaCierre && f > p.fechaCierre) return
      const c = cel(p, f)
      if (!c || (!c.sinAlimentacion && !num(c.libras))) atrasadas.push({ p, f })
    })
  })

  async function guardar(cerrarDia) {
    setGuardando(true); setAviso(null)
    try {
      const filas = []
      const borrar = []
      for (const p of piscinas) {
        if (!p.cicloId) continue
        for (const f of fechas) {
          if (!editable(f) && !(esJefe && situacionDia(f, hoy) !== 'futuro')) continue
          const c = cel(p, f)
          if (!c) continue
          // No se manda el id: el on conflict (piscina_id, fecha) resuelve
          // si toca insertar o actualizar. Si se mezclan filas con id y sin
          // id, PostgREST le pone null a las que no lo traen y la base lo
          // rechaza, porque el id tiene default y no acepta nulos.
          if (c.sinAlimentacion) {
            filas.push({ ciclo_id: p.cicloId, piscina_id: p.piscinaId,
                         fecha: f, producto_id: null, libras: 0, sin_alimentacion: true })
          } else {
            const lb = num(c.libras)
            if (lb === null || lb === 0) { if (c.id) borrar.push(c.id); continue }
            if (!c.productoId) continue
            filas.push({ ciclo_id: p.cicloId, piscina_id: p.piscinaId,
                         fecha: f, producto_id: c.productoId, libras: lb, sin_alimentacion: false })
          }
        }
      }

      if (borrar.length) {
        const { error } = await supabase.schema('produccion').from('alimentacion').delete().in('id', borrar)
        if (error) throw error
      }
      if (filas.length) {
        const { error } = await supabase.schema('produccion').from('alimentacion')
          .upsert(filas, { onConflict: 'piscina_id,fecha' })
        if (error) throw error
      }

      // Solo se toca el estado del dia cuando se esta en la semana en curso.
      // Corregir una semana pasada no debe reabrir ni cerrar nada.
      if (semanaDeHoy) {
        const estado = cerrarDia ? 'cerrado' : 'borrador'
        const { error: e2 } = await supabase.schema('produccion').from('dia_registro')
          .upsert({ finca_id: finca.id, fecha: hoy, estado,
                    ...(cerrarDia ? { cerrado_en: new Date().toISOString() } : {}) },
                  { onConflict: 'finca_id,fecha' })
        if (e2) throw e2
      }

      setAviso({ tipo: 'ok',
        texto: !semanaDeHoy ? 'Cambios guardados' : (cerrarDia ? 'Día cerrado' : 'Borrador guardado') })
      await cargar(true)
      return true
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
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
      .upsert(faltan.map(f => ({ finca_id: finca.id, fecha: f, estado: 'cerrado',
                                 cerrado_en: new Date().toISOString() })),
              { onConflict: 'finca_id,fecha' })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${faltan.length} días cerrados` })
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

  async function revisarSemana() {
    setValidaciones('cargando')
    const { data, error } = await supabase.schema('produccion')
      .rpc('fn_validar_semana', { p_finca: finca.id, p_lunes: lunes })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); setValidaciones(null); return }
    setValidaciones(data || [])
  }

  async function cerrarSemana() {
    const { anio, semana } = semanaISO(lunes)
    const { error } = await supabase.schema('produccion').from('semana_cerrada')
      .insert({ finca_id: finca.id, anio, semana, validaciones })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Semana cerrada' })
    await cargar(true)
  }

  function alTeclear(e, iFila, iDia) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    refs.current[`${iFila + 1}|${iDia}`]?.focus()
  }

  const visibles = soloPendientes
    ? piscinas.filter(p => pendientesHoy.includes(p) || atrasadas.some(a => a.p === p))
    : piscinas

  const COLS_BASE = '170px 96px 56px 124px 136px'
  const COLS_DIAS = 'repeat(7, minmax(132px, 1fr)) 104px'
  const COLS_IND = verIndicadores ? ' 104px 96px 104px 96px 92px 92px 92px 116px 104px' : ''
  const COLS = `${COLS_BASE} ${COLS_DIAS}${COLS_IND}`
  const ANCHO = verIndicadores ? '2160px' : '1260px'

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Registro diario</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana {semanaISO(lunes).semana} · del lunes {corta(lunes)} al domingo {corta(fechas[6])}
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

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
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
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      {semanaCerrada && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
                      background: '#FAEEDA', color: '#854F0B' }}>
          Esta semana ya está cerrada. Para corregir algo, pide a tu jefe que la reabra.
        </div>
      )}

      {modo === 'registrar' && !soloLectura && !semanaCerrada && (semanaDeHoy || esJefe) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                      background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '11px 14px', marginBottom: '10px' }}>
          {semanaDeHoy && <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13px', color: GRIS }}>
            <span>
              <b style={{ fontWeight: 500, color: NAVY }}>
                {piscinas.filter(p => p.tipo !== 'precria').length - pendientesHoy.length} de {piscinas.filter(p => p.tipo !== 'precria').length}
              </b> piscinas completadas hoy
            </span>
            <span style={{ width: '90px', height: '6px', background: '#e7eef5', borderRadius: '20px', overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', background: '#1D9E75',
                width: (piscinas.length ? ((piscinas.filter(p => p.tipo !== 'precria').length - pendientesHoy.length) / Math.max(1, piscinas.filter(p => p.tipo !== 'precria').length)) * 100 : 0) + '%' }} />
            </span>
          </div>}
          {semanaDeHoy && <><Sep />
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={soloPendientes} onChange={e => setSoloPendientes(e.target.checked)} />
            Solo pendientes
          </label>
          <Sep />
          <Btn fantasma onClick={() => copiarDiaAnterior(hoy)}>Copiar día anterior</Btn></>}
          {!semanaDeHoy && (
            <span style={{ fontSize: '13px', color: '#854F0B' }}>
              Estás editando una semana anterior. Los cambios quedan en la bitácora.
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '12px',
                         color: refrescando ? AZUL : sucio ? '#BA7517' : GRIS }}>
            {refrescando ? 'Actualizando...'
              : sucio ? 'Hay cambios sin guardar' : 'Sin cambios sin guardar'}
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
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: ANCHO }}>

                <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                              borderBottom: '0.5px solid ' + BORDE }}>
                  <Th pegado>Piscina</Th>
                  <Th>Siembra</Th>
                  <Th>Días</Th>
                  <Th>Laboratorio</Th>
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
                        <span style={{ display: 'block', fontSize: '9px', marginTop: '3px', letterSpacing: '0.04em',
                          color: est === 'cerrado' ? GRIS : (s === 'hoy' ? AZUL : GRIS) }}>
                          {est === 'cerrado' ? 'CERRADO' : est === 'reabierto' ? 'REABIERTO'
                            : est === 'borrador' ? 'BORRADOR' : s === 'hoy' ? 'HOY' : '—'}
                        </span>
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
                  <div key={p.piscinaId} style={{ display: 'grid', gridTemplateColumns: COLS,
                        borderBottom: '0.5px solid #f1f6f9', alignItems: 'center' }}>
                    <Td pegado alineado="left">
                      <span style={{ fontWeight: 500, fontSize: '14px' }}>{p.nombre}</span>
                      <div style={{ fontSize: '11px', color: GRIS }}>
                        {p.hectareas.toFixed(2)} ha
                        {p.tipo === 'precria' && ' · precría'}
                      </div>
                    </Td>
                    <Td><span style={{ color: GRIS, fontSize: '12px' }}>
                      {p.fechaSiembra ? corta(p.fechaSiembra) : '—'}
                    </span></Td>
                    <Td><span style={{ fontWeight: 500 }}>
                      {p.fechaSiembra ? diasCultivo(p.fechaSiembra, fechas[6]) : ''}
                    </span></Td>
                    <Td>
                      <Laboratorio
                        fila={p} laboratorios={laboratorios}
                        puede={!soloLectura && modo === 'registrar' && !semanaCerrada}
                        onElegir={id => cambiarLaboratorio(p, id)}
                      />
                    </Td>
                    <Td>
                      <Estado
                        fila={p} evento={eventos[p.piscinaId]}
                        puede={!soloLectura && modo === 'registrar'}
                        onElegir={tipo => abrirEvento(tipo, p)}
                      />
                    </Td>
                    {fechas.map((f, j) => (
                      <Td key={f} fondo={situacionDia(f, hoy) === 'hoy' ? HOYB
                                        : situacionDia(f, hoy) === 'futuro' ? '#fbfcfd' : undefined}
                          borde={situacionDia(f, hoy) === 'hoy'}>
                        <Celda
                          p={p} f={f} c={cel(p, f)} productos={productos}
                          editable={editable(f)} situacion={situacionDia(f, hoy)}
                          onProducto={v => set(p, f, 'productoId', v)}
                          onLibras={v => set(p, f, 'libras', v)}
                          onSin={() => marcarSin(p, f)}
                          onLimpiar={() => limpiar(p, f)}
                          inputRef={el => { refs.current[`${i}|${j}`] = el }}
                          onKeyDown={e => alTeclear(e, i, j)}
                        />
                      </Td>
                    ))}
                    <Td><span style={{ fontWeight: 500 }}>{miles(totalPiscina(p)) || ''}</span></Td>
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
                ))}

                <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                              borderTop: '0.5px solid ' + BORDE, alignItems: 'center' }}>
                  <Td pegado alineado="left" fondo="#fafcfd">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>Total</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>{hectareas.toFixed(2)} ha</div>
                  </Td>
                  <Td fondo="#fafcfd" />
                  <Td fondo="#fafcfd"><span style={{ fontSize: '11px', color: GRIS }}>{piscinas.length} piscinas</span></Td>
                  <Td fondo="#fafcfd" />
                  <Td fondo="#fafcfd" />
                  {fechas.map(f => (
                    <Td key={f} fondo={situacionDia(f, hoy) === 'hoy' ? HOYB : '#fafcfd'}
                        borde={situacionDia(f, hoy) === 'hoy'}>
                      <span style={{ fontWeight: 500 }}>
                        {situacionDia(f, hoy) === 'futuro' ? <span style={{ color: GRIS }}>—</span> : miles(totalDia(f)) || '0'}
                      </span>
                    </Td>
                  ))}
                  <Td fondo="#fafcfd"><span style={{ fontWeight: 500, fontSize: '16px' }}>{miles(totalSemana)}</span></Td>
                  {verIndicadores && Array.from({ length: 9 }, (_, k) => <Td key={k} fondo="#fafcfd" />)}
                </div>
              </div>
            </div>

            {atrasadas.length > 0 && modo === 'registrar' && (
              <div style={{ display: 'flex', gap: '9px', alignItems: 'center', fontSize: '13px',
                            padding: '9px 16px', background: '#FAEEDA', color: '#854F0B' }}>
                <span>
                  {atrasadas.length === 1
                    ? `${atrasadas[0].p.nombre} quedó sin registrar el ${nombreDia(atrasadas[0].f).toLowerCase()}.`
                    : `Hay ${atrasadas.length} celdas sin registrar en días anteriores.`}
                  {' '}Ponles las libras o márcalas sin alimentación.
                </span>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '16px', flexWrap: 'wrap', padding: '14px 16px',
                          borderTop: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
              <div style={{ display: 'flex', gap: '30px' }}>
                {semanaDeHoy && <Dato k="Libras de hoy" v={miles(totalDia(hoy)) || '0'} />}
                <Dato k="Sacos de la semana" v={(totalSemana / LIBRAS_POR_SACO).toFixed(1)} />
                <Dato k="Total de la semana" v={miles(totalSemana)} />
              </div>
              {!soloLectura && modo === 'registrar' && !semanaCerrada && (semanaDeHoy || esJefe) && (
                <div style={{ display: 'flex', gap: '9px' }}>
                  <Btn onClick={() => guardar(false)} disabled={guardando}>
                    {guardando ? 'Guardando...' : (semanaDeHoy ? 'Guardar borrador' : 'Guardar cambios')}
                  </Btn>
                  {semanaDeHoy && (
                    <Btn primario onClick={pedirCerrarDia} disabled={guardando}>Cerrar día</Btn>
                  )}
                </div>
              )}
            </div>
          </div>

          {dialogo && (
            <DialogoEvento
              tipo={dialogo.tipo}
              ciclo={dialogo.fila}
              piscina={dialogo.fila}
              laboratorios={laboratorios}
              destinosPosibles={piscinas.filter(x => !x.cicloId)}
              minima={dialogo.tipo === 'siembra' ? undefined : dialogo.fila.fechaSiembra}
              onCancelar={() => setDialogo(null)}
              onGuardar={registrarEvento}
            />
          )}

          <Cierre
            validaciones={validaciones}
            onRevisar={revisarSemana}
            onCerrar={cerrarSemana}
            onCerrarDias={cerrarDiasPendientes}
            // El dia de hoy no cuenta aqui: para eso esta "Cerrar dia".
            diasPendientes={fechas.filter(f => dias[f] !== 'cerrado' && dias[f] !== 'reabierto'
                                               && f !== hoy
                                               && situacionDia(f, hoy) !== 'futuro').length}
            // Un bodeguero puede firmar los dias sueltos de su semana.
            // Firmar hacia atras una semana pasada es cosa del jefe.
            puedeFirmarDias={!soloLectura && !semanaCerrada && (esJefe || semanaDeHoy)}
            puedeCerrar={esJefe && !semanaCerrada}
            cerrada={semanaCerrada}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Celda: las tres situaciones de la regla 2.3
// ---------------------------------------------------------------------
function Celda({ p, f, c, productos, editable, situacion, onProducto, onLibras, onSin, onLimpiar, inputRef, onKeyDown }) {
  if (!p.cicloId) {
    return <div style={{ color: '#c3d0db', fontSize: '12px' }}>—</div>
  }
  if (f < p.fechaSiembra || (p.fechaCierre && f > p.fechaCierre)) {
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
        sin alimentación
      </div>
    )
  }

  if (!editable) {
    if (!c || !num(c.libras)) return <div style={cajaVacia}>sin registrar</div>
    const pr = productos.find(x => x.id === c.productoId)
    return (
      <div>
        <div style={{ fontSize: '11px', color: GRIS }}>{pr?.nombre_corto || ''}</div>
        <div style={{ fontSize: '15px' }}>{miles(num(c.libras))}</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <select
        value={c?.productoId || ''}
        onChange={e => onProducto(e.target.value)}
        title={productos.find(x => x.id === c?.productoId)?.nombre || 'Elegir balanceado'}
        style={{ fontFamily: 'inherit', fontSize: '11px', padding: '5px', width: '100%',
                 border: '0.5px solid ' + BORDE, borderRadius: '7px', background: 'white' }}
      >
        <option value="">Elegir balanceado</option>
        {productos.map(pr => <option key={pr.id} value={pr.id}>{pr.nombre}</option>)}
      </select>
      <input
        inputMode="numeric" placeholder="0"
        value={c?.libras || ''}
        ref={inputRef}
        onKeyDown={onKeyDown}
        onChange={e => onLibras(e.target.value)}
        style={{ fontFamily: 'inherit', fontSize: '15px', padding: '6px', width: '100%',
                 textAlign: 'center', border: '0.5px solid ' + BORDE, borderRadius: '7px',
                 fontVariantNumeric: 'tabular-nums' }}
      />
      {!num(c?.libras) && (
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
function Laboratorio({ fila, laboratorios, puede, onElegir }) {
  if (!fila.cicloId) return <span />
  if (!puede) {
    return <span style={{ color: GRIS, fontSize: '12px' }}>{fila.laboratorio || '—'}</span>
  }
  const vacio = !fila.laboratorioId
  return (
    <select
      value={fila.laboratorioId || ''}
      onChange={e => onElegir(e.target.value)}
      title={fila.laboratorio || 'Elegir laboratorio'}
      style={{ fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px', width: '100%',
               borderRadius: '7px', background: 'white',
               border: '0.5px solid ' + (vacio ? '#e8d5b0' : BORDE),
               color: vacio ? '#BA7517' : GRIS }}
    >
      <option value="">{vacio ? 'Sin laboratorio' : 'Quitar'}</option>
      {laboratorios.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
    </select>
  )
}

// ---------------------------------------------------------------------
// Columna de estado: es la columna ESTADO PISCINA del Excel.
// Si la piscina no tiene ciclo, lo unico posible es sembrarla.
// ---------------------------------------------------------------------
function Estado({ fila, evento, puede, onElegir }) {
  if (evento) {
    const t = TIPOS[evento.tipo] || TIPOS.siembra
    return (
      <div>
        <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 9px', borderRadius: '20px',
                       background: t.fondo, color: t.color }}>{t.nombre}</span>
        <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px' }}>
          {corta(evento.fecha)}{evento.libras ? ` · ${miles(evento.libras)} lb` : ''}
        </div>
      </div>
    )
  }

  if (!puede) return <span style={{ color: '#c3d0db', fontSize: '12px' }}>—</span>

  // Mismo control en todas las filas. Lo que cambia son las opciones:
  // una piscina vacia solo se puede sembrar, una sembrada no.
  if (fila.cicloCerrado) {
    return <span style={{ color: GRIS, fontSize: '12px' }}>Ciclo cerrado</span>
  }

  // Vacia esta semana pero sembrada mas adelante: no se puede sembrar
  // otra vez. Antes se ofrecia Sembrar y la base lo rechazaba.
  if (!fila.cicloId && fila.siembraPosterior) {
    return (
      <span style={{ color: GRIS, fontSize: '12px' }}>
        Vacía · se siembra el {corta(fila.siembraPosterior)}
      </span>
    )
  }

  const opciones = fila.cicloId
    ? [['raleo', 'Raleo'], ['transferencia', 'Transferencia'], ['cosecha', 'Cosecha']]
    : [['siembra', 'Sembrar']]

  return (
    <select
      value=""
      onChange={e => { if (e.target.value) onElegir(e.target.value) }}
      style={{ fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px', width: '100%',
               borderRadius: '7px', background: fila.cicloId ? 'white' : '#E1F5EE',
               border: '0.5px solid ' + (fila.cicloId ? BORDE : '#9fe1cb'),
               color: fila.cicloId ? GRIS : '#0F6E56',
               fontWeight: fila.cicloId ? 400 : 500 }}
    >
      <option value="">{fila.cicloId ? 'Sin novedad' : 'Vacía'}</option>
      {opciones.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  )
}

// ---------------------------------------------------------------------
// Panel de cierre de semana (regla 5.1)
// ---------------------------------------------------------------------
function Cierre({ validaciones, onRevisar, onCerrar, onCerrarDias, diasPendientes,
                  puedeFirmarDias, puedeCerrar, cerrada }) {
  const todas = Array.isArray(validaciones) && validaciones.length > 0 && validaciones.every(v => v.pasa)
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '16px 18px', marginTop: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Cerrar la semana</h3>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            {cerrada ? 'Esta semana ya está cerrada.'
              : 'No se puede cerrar mientras alguna validación falle. Cada una dice qué revisar.'}
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
              <span style={{ fontWeight: 500, minWidth: '200px' }}>{v.codigo} · {v.nombre}</span>
              <span style={{ color: GRIS }}>{v.detalle}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
                        gap: '9px', marginTop: '14px', flexWrap: 'wrap' }}>
            {/* V5 pide la firma de los siete dias. En una semana pasada
                no hay boton de "Cerrar dia", asi que el jefe los firma
                aqui. Solo aparece cuando de verdad falta alguno. */}
            {puedeFirmarDias && diasPendientes > 0 && (
              <>
                <span style={{ fontSize: '12px', color: GRIS, marginRight: 'auto' }}>
                  Faltan {diasPendientes} {diasPendientes === 1 ? 'día' : 'días'} por dar por cerrados.
                </span>
                <Btn onClick={onCerrarDias}>
                  Cerrar los {diasPendientes} {diasPendientes === 1 ? 'día' : 'días'}
                </Btn>
              </>
            )}
            <Btn primario disabled={!todas || !puedeCerrar} onClick={onCerrar}>
              {puedeCerrar ? 'Cerrar semana' : 'Solo un jefe puede cerrar'}
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
