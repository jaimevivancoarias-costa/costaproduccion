import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  hoyISO, lunesDe, sumarDias, semanaDe, corta, nombreDia,
  esDiaDeMuestreo, diasCultivo, situacionDia, num, numDec, semanaISO,
} from '../lib/fechas'

// Gramaje · peso promedio del camaron
//
// Regla 6: se mide miercoles y domingo. Solo se escribe el peso actual;
// el incremento, los dias entre muestras y el crecimiento diario son
// calculo contra el muestreo anterior del mismo ciclo.
//
// Si el peso baja se avisa: un camaron no adelgaza. No bloquea, porque
// puede haber un raleo de por medio que cambio la poblacion.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#A32D2D'   // mismo rojo que ya usa la app
const HOYB = '#E6F1FB'
const AMBAR = '#854F0B'
const RBG = '#FBEAEA'   // fondo rojo suave
const ABG = '#FAEEDA'   // fondo ambar suave
// Semaforo de crecimiento semanal (g/semana, domingo->domingo). Cada finca
// fija su propia meta; estos son los valores por defecto si no la configuro.
const JOVEN_DIAS = 30    // piscinas con menos dias no se evaluan
const DEF_VERDE = 3.8    // meta por defecto si la finca no configuro la suya
const DEF_ROJO = 3.0
const VERDE = '#0F6E56'

export default function Gramaje({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const [filas, setFilas] = useState([])
  const [valores, setValores] = useState({})     // `${piscinaId}|${fecha}` -> peso
  const [previos, setPrevios] = useState({})     // cicloId -> { fecha, peso }
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [practica, setPractica] = useState(false)  // sin ciclos: solo para familiarizarse
  const [dias, setDias] = useState({})          // fecha -> estado del día de gramaje (cerrado/reabierto)
  const [diasId, setDiasId] = useState({})      // fecha -> id del dia_registro
  const [solReapertura, setSolReapertura] = useState([])
  const [userId, setUserId] = useState(null)
  const [cerrando, setCerrando] = useState('')  // fecha que se está cerrando/reabriendo
  const [guardadoOk, setGuardadoOk] = useState(false)
  const [serie, setSerie] = useState({})        // cicloId -> muestreos [{fecha,peso}] asc (historial)
  const [meta, setMeta] = useState(null)        // {verde, rojo} de la finca (null = usa defecto)
  const [metaOpen, setMetaOpen] = useState(false)
  const [metaForm, setMetaForm] = useState({ verde: '', rojo: '' })
  const [metaMsg, setMetaMsg] = useState(null)
  const [orden, setOrden] = useState('piscina')  // 'piscina' | 'peor' | 'mejor'

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const muestreos = useMemo(() => fechas.filter(esDiaDeMuestreo), [fechas])
  const hoy = hoyISO()
  const mVerde = meta?.verde ?? DEF_VERDE
  const mRojo = meta?.rojo ?? DEF_ROJO
  // Nunca se cuentan dias que no han pasado. Ver "6 días" en una
  // piscina sembrada ayer, solo porque el domingo queda lejos, es
  // mentira y ademas desalinea el gramaje esperado.
  const corteDias = fechas[6] > hoy ? hoy : fechas[6]

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]

      const { data: ciclos, error } = await supabase
        .schema('produccion').from('ciclo')
        .select('id, fecha_siembra, fecha_ocupacion, fecha_cierre, cantidad_larva, gramaje_precria, piscina:piscina_origen_id (id, codigo, nombre, hectareas, tipo)')
        .eq('finca_id', finca.id)
        .lte('fecha_siembra', domingo)
        .or(`fecha_cierre.is.null,fecha_cierre.gte.${lunes}`)
      if (error) throw error

      const lista = (ciclos || [])
        .filter(c => c.piscina && c.piscina.tipo === 'engorde')
        .map(c => ({
          cicloId: c.id, piscinaId: c.piscina.id, codigo: c.piscina.codigo,
          nombre: c.piscina.nombre, hectareas: Number(c.piscina.hectareas),
          fechaSiembra: c.fecha_siembra,
          // Dias de engorde = desde que el camaron entra a ESTA piscina. Para
          // uno transferido es el dia que llego; para siembra directa es la
          // misma siembra. Nunca la edad total (que incluiria la precria).
          fechaOcupacion: c.fecha_ocupacion || c.fecha_siembra,
          fechaCierre: c.fecha_cierre,
          larva: c.cantidad_larva,
          // Peso al entrar a engorde (precría/transferencia): base del crec. diario.
          gramajePrecria: c.gramaje_precria,
        }))
        .sort(ordenar)
      // Sin ciclos sembrados: mostramos igual el formato con las piscinas
      // de engorde de la finca, para que el equipo se familiarice. Se puede
      // escribir para practicar, pero todavia no se guarda (no hay ciclo).
      if (!lista.length) {
        const { data: pisc } = await supabase
          .schema('produccion').from('piscina')
          .select('id, codigo, nombre, hectareas, tipo')
          .eq('finca_id', finca.id).eq('tipo', 'engorde').eq('activa', true).eq('es_reservorio', false)
        const demo = (pisc || []).map(p => ({
          cicloId: null, piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
          hectareas: Number(p.hectareas), fechaSiembra: null, fechaCierre: null, larva: null,
        })).sort(ordenar)
        setFilas(demo); setPractica(demo.length > 0)
        setValores({}); setPrevios({}); return
      }
      setFilas(lista); setPractica(false)

      const { data: ms } = await supabase
        .schema('produccion').from('muestreo')
        .select('piscina_id, ciclo_id, fecha, peso_gramos')
        .in('ciclo_id', lista.map(f => f.cicloId))
        .order('fecha')

      const v = {}, prev = {}, serieMap = {}
      ;(ms || []).forEach(m => {
        if (m.fecha >= lunes && m.fecha <= domingo) {
          v[`${m.piscina_id}|${m.fecha}`] = String(m.peso_gramos)
        }
        // El ultimo muestreo anterior al lunes de esta semana.
        if (m.fecha < lunes) prev[m.ciclo_id] = { fecha: m.fecha, peso: Number(m.peso_gramos) }
        // Historial completo por ciclo (ya viene ordenado por fecha asc): sirve
        // para el ISP de las 2 ultimas semanas en el ranking.
        ;(serieMap[m.ciclo_id] ||= []).push({ fecha: m.fecha, peso: Number(m.peso_gramos) })
      })
      setValores(v); setPrevios(prev); setSerie(serieMap)

      // Meta de crecimiento de la finca (si el jefe la configuro).
      const { data: mrow } = await supabase.schema('produccion').from('meta_crecimiento')
        .select('verde_desde, rojo_bajo').eq('finca_id', finca.id).maybeSingle()
      const mObj = mrow ? { verde: Number(mrow.verde_desde), rojo: Number(mrow.rojo_bajo) } : null
      setMeta(mObj)
      setMetaForm({ verde: String(mObj?.verde ?? DEF_VERDE), rojo: String(mObj?.rojo ?? DEF_ROJO) })

      // Estado del día de gramaje (cerrado/reabierto) por muestreo.
      const { data: dr } = await supabase.schema('produccion').from('dia_registro')
        .select('id, fecha, estado').eq('finca_id', finca.id).eq('ambito', 'gramaje')
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
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  // Se puede editar cualquier día de muestreo que ya pasó (o el de hoy),
  // no solo el del día exacto: si se olvidaron el miércoles, lo llenan
  // después. Los días futuros siguen bloqueados.
  const editable = f =>
    !soloLectura && situacionDia(f, hoy) !== 'futuro' && dias[f] !== 'cerrado'

  // Peso de referencia para el incremento: preferimos el último muestreo de
  // la semana anterior (normalmente el domingo), así el domingo mide de
  // domingo a domingo (semana completa) y el miércoles desde el domingo
  // pasado. Si no hay domingo anterior (semana sin muestreo), caemos al
  // muestreo anterior de esta misma semana para no dejar el dato en blanco.
  function anterior(fila, fecha) {
    if (previos[fila.cicloId]) return previos[fila.cicloId]
    const dentro = muestreos
      .filter(f => f < fecha && numDec(valores[`${fila.piscinaId}|${f}`]))
      .map(f => ({ fecha: f, peso: numDec(valores[`${fila.piscinaId}|${f}`]) }))
    return dentro.length ? dentro[dentro.length - 1] : null
  }

  function calculo(fila, fecha) {
    const actual = numDec(valores[`${fila.piscinaId}|${fecha}`])
    const ant = anterior(fila, fecha)
    if (actual === null || !ant) return { actual, ant: null }
    const inc = actual - ant.peso
    const dias = Math.round((new Date(fecha + 'T12:00:00') - new Date(ant.fecha + 'T12:00:00')) / 86400000)
    return { actual, ant, inc, dias, crec: dias > 0 ? inc / dias : null }
  }

  const bajaron = filas.flatMap(f =>
    muestreos.filter(fe => {
      const c = calculo(f, fe)
      return c.inc !== undefined && c.inc < 0
    }).map(fe => ({ fila: f, fecha: fe }))
  )

  // Ranking de crecimiento semanal (g/sem, normalizado): toma el último
  // muestreo de la semana con crecimiento calculable, ordena de peor a mejor.
  // Las jóvenes (<30 días) no entran, igual que en el semáforo.
  // ISP (incremento semanal de peso, g/sem) por piscina: se toma el ultimo
  // muestreo de cada semana ISO y se compara con el de la semana anterior.
  // Incluye lo que se esta escribiendo esta semana (aun sin guardar).
  function serieSemanal(fila) {
    const S = [...(serie[fila.cicloId] || [])].filter(m => m.fecha <= fechas[6])
    muestreos.forEach(fe => {
      const val = numDec(valores[`${fila.piscinaId}|${fe}`])
      if (val === null) return
      const i = S.findIndex(m => m.fecha === fe)
      if (i >= 0) S[i] = { fecha: fe, peso: val }; else S.push({ fecha: fe, peso: val })
    })
    S.sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    // Crecimiento semanal = domingo a domingo: se toma SOLO el peso del domingo
    // de cada semana. Una semana sin domingo medido no entra.
    const byW = {}
    S.forEach(m => { if (new Date(m.fecha + 'T12:00:00').getDay() === 0) { const w = semanaISO(m.fecha); byW[w.anio + '-' + String(w.semana).padStart(2, '0')] = m } })
    return Object.keys(byW).sort().map(k => byW[k])   // un domingo por semana, asc
  }
  function ispEntre(a, b) {
    if (!a || !b) return null
    const d = Math.round((new Date(b.fecha + 'T12:00:00') - new Date(a.fecha + 'T12:00:00')) / 86400000)
    return d > 0 ? (b.peso - a.peso) / d * 7 : null
  }

  async function guardarMeta() {
    setMetaMsg(null)
    const verde = numDec(metaForm.verde), rojo = numDec(metaForm.rojo)
    if (verde === null || rojo === null) { setMetaMsg({ tipo: 'error', texto: 'Escribe los dos números.' }); return }
    if (rojo >= verde) { setMetaMsg({ tipo: 'error', texto: 'El rojo debe ser menor que el verde.' }); return }
    const { error } = await supabase.schema('produccion').from('meta_crecimiento')
      .upsert({ finca_id: finca.id, verde_desde: verde, rojo_bajo: rojo,
                actualizado_en: new Date().toISOString(), actualizado_por: userId }, { onConflict: 'finca_id' })
    if (error) { setMetaMsg({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setMeta({ verde, rojo }); setMetaOpen(false); setMetaMsg(null)
    setAviso({ tipo: 'ok', texto: 'Meta de gramaje guardada.' })
  }

  async function guardar() {
    setGuardando(true); setAviso(null)
    try {
      const nuevos = [], borrar = []
      for (const f of filas) {
        for (const fe of muestreos) {
          if (!editable(fe)) continue
          if (f.fechaCierre && fe > f.fechaCierre) continue
          if (fe < f.fechaSiembra) continue
          const p = numDec(valores[`${f.piscinaId}|${fe}`])
          if (p === null) { borrar.push({ piscina: f.piscinaId, fecha: fe }); continue }
          nuevos.push({ ciclo_id: f.cicloId, piscina_id: f.piscinaId, fecha: fe, peso_gramos: p })
        }
      }

      for (const b of borrar) {
        await supabase.schema('produccion').from('muestreo')
          .delete().eq('piscina_id', b.piscina).eq('fecha', b.fecha)
      }
      if (nuevos.length) {
        const { error } = await supabase.schema('produccion').from('muestreo')
          .upsert(nuevos, { onConflict: 'piscina_id,fecha' })
        if (error) throw error
      }
      setAviso(null)
      setGuardadoOk(true); setTimeout(() => setGuardadoOk(false), 2500)
      await cargar()
      return true
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
      return false
    } finally {
      setGuardando(false)
    }
  }

  // Cerrar un día de muestreo: guarda los pesos y lo deja cerrado.
  async function cerrarDia(fe) {
    setCerrando(fe)
    const ok = await guardar()
    if (!ok) { setCerrando(''); return }
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha: fe, ambito: 'gramaje', estado: 'cerrado', cerrado_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    setCerrando('')
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo cerrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: `Gramaje del ${corta(fe)} cerrado.` }); await cargar()
  }

  // El jefe reabre directo.
  async function reabrirDia(fe) {
    setCerrando(fe)
    const { error } = await supabase.schema('produccion').from('dia_registro')
      .upsert({ finca_id: finca.id, fecha: fe, ambito: 'gramaje', estado: 'reabierto', reabierto_en: new Date().toISOString() },
              { onConflict: 'finca_id,fecha,ambito' })
    setCerrando('')
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo reabrir. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Día reabierto.' }); await cargar()
  }

  // El bodeguero pide, el jefe autoriza.
  async function pedirReabrir(fe) {
    const id = diasId[fe]
    if (!id) return
    const motivo = window.prompt(`¿Por qué necesitas reabrir el gramaje del ${corta(fe)}? El jefe lo revisará.`)
    if (!motivo || !motivo.trim()) return
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'dia_registro', registro_id: id,
      valor_anterior: { estado: 'cerrado' }, valor_propuesto: { estado: 'reabierto', fecha: fe, ambito: 'gramaje' },
      motivo: motivo.trim(), solicitado_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido enviado. El jefe lo revisará.' }); await cargar()
  }

  async function resolverReapertura(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Día reabierto.' : 'Pedido rechazado.' }); await cargar()
  }

  // Crecimiento por piscina: alimenta las columnas de resultado, los chips
  // y el orden. Reusa serieSemanal / ispEntre de arriba.
  const crecPorPisc = {}
  filas.forEach(f => {
    const dEng = diasCultivo(f.fechaOcupacion || f.fechaSiembra, corteDias)
    const sem = serieSemanal(f)                 // un muestreo por semana, asc
    const n = sem.length
    // Incrementos semanales (g/sem) entre semanas consecutivas.
    const incs = []
    for (let i = 1; i < n; i++) { const v = ispEntre(sem[i - 1], sem[i]); if (v != null) incs.push(v) }
    const prom = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
    const isp = prom(incs)              // ISP = promedio de TODOS los incrementos
    const isp2 = prom(incs.slice(-2))   // ISP 2 sem = promedio de los 2 últimos
    const ultSem = incs.length ? incs[incs.length - 1] : null   // crecimiento de la última semana
    // Crec. diario = (peso último − gramaje de precría/transferencia) / días de engorde.
    const pesoUlt = n ? sem[n - 1].peso : null
    const base = f.gramajePrecria != null ? Number(f.gramajePrecria) : (n ? sem[0].peso : null)
    const diario = (pesoUlt != null && base != null && dEng > 0) ? (pesoUlt - base) / dEng : null
    crecPorPisc[f.piscinaId] = { dias: dEng, isp, isp2, ultSem, diario, joven: dEng < JOVEN_DIAS }
  })
  // El semáforo y el orden usan el ISP 2 sem (lo más reciente).
  const evalC = Object.values(crecPorPisc).filter(c => c.isp2 != null && !c.joven)
  const nMeta = evalC.filter(c => c.isp2 >= mVerde).length
  const nLento = evalC.filter(c => c.isp2 >= mRojo && c.isp2 < mVerde).length
  const nMuy = evalC.filter(c => c.isp2 < mRojo).length
  const filasVista = orden === 'piscina' ? filas : (() => {
    const k = f => { const c = crecPorPisc[f.piscinaId]; return (c && c.isp2 != null && !c.joven) ? c.isp2 : null }
    const con = filas.filter(f => k(f) != null), sin = filas.filter(f => k(f) == null)
    con.sort((a, b) => orden === 'peor' ? k(a) - k(b) : k(b) - k(a))
    return [...con, ...sin]
  })()

  const COLS = `minmax(170px,1.3fr) ${muestreos.map(() => 'minmax(78px,1fr) 46px minmax(88px,1fr) minmax(96px,1.1fr)').join(' ')} 72px 84px 118px 100px`

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Gramaje</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Peso promedio del camarón · se mide miércoles y domingo ·
            {' '}del {corta(lunes)} al {corta(fechas[6])}
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

      {!practica && filas.length > 0 && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <ChipG k="Piscinas" v={filas.length} />
          <ChipG k="En meta" v={nMeta} color={VERDE} />
          <ChipG k="Van lento" v={nLento} color={AMBAR} />
          <ChipG k="Muy lento" v={nMuy} color={ROJO} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: GRIS }}>
            Orden:
            <select value={orden} onChange={e => setOrden(e.target.value)}
              style={{ padding: '7px 10px', fontSize: '12px', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: '#fff', color: NAVY, fontFamily: 'inherit' }}>
              <option value="piscina">Por piscina (normal)</option>
              <option value="peor">Peor → mejor</option>
              <option value="mejor">Mejor → peor</option>
            </select>
          </div>
        </div>
      )}

      {!practica && !cargando && (
        <MetaBar meta={meta} mVerde={mVerde} mRojo={mRojo} esJefe={esJefe}
          open={metaOpen} setOpen={setMetaOpen} form={metaForm} setForm={setMetaForm}
          onGuardar={guardarMeta} msg={metaMsg} />
      )}

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      {bajaron.map(({ fila, fecha }) => {
        const c = calculo(fila, fecha)
        return (
          <div key={fila.piscinaId + fecha} style={{ padding: '9px 14px', borderRadius: '9px',
                marginBottom: '8px', fontSize: '13px', background: '#FAEEDA', color: '#854F0B' }}>
            {fila.nombre} bajó de {c.ant.peso} a {c.actual} gramos el {nombreDia(fecha).toLowerCase()}.
            Un camarón no adelgaza: revisa la medición.
          </div>
        )
      })}

      {practica && !cargando && (
        <div style={{ padding: '11px 14px', borderRadius: '10px', marginBottom: '10px', fontSize: '13px',
                      background: '#EAF1F8', color: '#1E4E79', border: '0.5px solid #cfe0f0' }}>
          <b style={{ fontWeight: 600 }}>Modo práctica.</b> Todavía no hay piscinas sembradas en esta
          finca, así que este es el formato para que se familiaricen. Pueden escribir pesos para
          practicar, pero aún no se guarda nada: se guardará cuando haya un ciclo sembrado.
        </div>
      )}

      {cargando ? (
        <Vacio>Cargando...</Vacio>
      ) : !filas.length ? (
        <Vacio>Esta finca no tiene piscinas de engorde activas.</Vacio>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '940px' }}>

              {/* Encabezados de grupo: Miércoles / Domingo, centrados sobre su bloque */}
              <div style={{ display: 'grid', gridTemplateColumns: COLS }}>
                <div />
                {muestreos.map((f, i) => (
                  <div key={f} style={{ gridColumn: 'span 4', textAlign: 'center', padding: '9px 0 5px',
                        fontSize: '12px', fontWeight: 600, color: NAVY,
                        background: i === muestreos.length - 1 ? '#eef6fc' : '#f7fafd',
                        borderLeft: '2px solid #cfe0ef' }}>
                    {nombreDia(f)} {corta(f).slice(0, 5)}
                  </div>
                ))}
                <div style={{ gridColumn: 'span 4', textAlign: 'center', padding: '9px 0 5px',
                      fontSize: '12px', fontWeight: 600, color: NAVY, background: '#eef3f7',
                      borderLeft: '2px solid #cfe0ef' }}>Resultado</div>
              </div>
              {/* Sub-encabezados por columna */}
              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Piscina</Th>
                {muestreos.flatMap(f => ([
                  <Th key={f + 'a'} bordeIzq>Peso ant.</Th>,
                  <Th key={f + 'b'}>Días</Th>,
                  <Th key={f + 'c'}>Peso g</Th>,
                  <Th key={f + 'd'}>Crecim.</Th>,
                ]))}
                <Th key="rc" bordeIzq>Crec. diario</Th>
                <Th key="ri">ISP prom.</Th>
                <Th key="rd">ISP 2 sem</Th>
                <Th key="re">Estado</Th>
              </div>

              {filasVista.map(fila => (
                <div key={fila.piscinaId} style={{ display: 'grid', gridTemplateColumns: COLS,
                      borderBottom: '0.5px solid #f1f6f9', alignItems: 'center' }}>
                  <Td pegado alineado="left">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>{fila.nombre}</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>
                      {fila.fechaSiembra ? diasCultivo(fila.fechaOcupacion || fila.fechaSiembra, corteDias) + ' días' : fila.hectareas.toFixed(2) + ' ha'}
                    </div>
                  </Td>

                  {muestreos.map((f, gi) => {
                    const fuera = (fila.fechaCierre && f > fila.fechaCierre) || f < (fila.fechaOcupacion || fila.fechaSiembra)
                    const c = calculo(fila, f)
                    const ant = anterior(fila, f)
                    const diasBloque = ant ? Math.round((new Date(f + 'T12:00:00') - new Date(ant.fecha + 'T12:00:00')) / 86400000) : null
                    const puede = (practica ? situacionDia(f, hoy) !== 'futuro' : editable(f)) && !fuera
                    const futuro = situacionDia(f, hoy) === 'futuro'
                    const joven = fila.fechaSiembra ? diasCultivo(fila.fechaOcupacion || fila.fechaSiembra, corteDias) < JOVEN_DIAS : true
                    return (
                      <Celdas
                        key={f} fecha={f} hoy={hoy} joven={joven} ant={ant} diasBloque={diasBloque}
                        fuera={fuera} futuro={futuro} puede={puede} calc={c} divide={gi > 0}
                        valor={valores[`${fila.piscinaId}|${f}`] || ''}
                        onChange={v => setValores(x => ({ ...x, [`${fila.piscinaId}|${f}`]: v }))}
                      />
                    )
                  })}

                  {(() => {
                    const rc = crecPorPisc[fila.piscinaId] || {}
                    const diarioTxt = rc.diario != null ? rc.diario.toFixed(2) : null
                    const ispTxt = rc.isp != null ? rc.isp.toFixed(1) : null
                    if (rc.joven || rc.isp2 == null) {
                      return (
                        <>
                          <Td bordeIzq><span style={{ color: GRIS }}>{diarioTxt ?? <Guion />}</span></Td>
                          <Td><span style={{ color: GRIS }}>{ispTxt ?? <Guion />}</span></Td>
                          <Td><Guion /></Td>
                          <Td><span style={{ color: GRIS, fontSize: '11px' }}>{rc.joven ? 'joven' : 'aún no'}</span></Td>
                        </>
                      )
                    }
                    const col = rc.isp2 < mRojo ? ROJO : rc.isp2 < mVerde ? AMBAR : VERDE
                    const bg = rc.isp2 < mRojo ? RBG : rc.isp2 < mVerde ? ABG : '#E1F5EE'
                    const txt = rc.isp2 < mRojo ? 'Muy lento' : rc.isp2 < mVerde ? 'Va lento' : 'En meta'
                    return (
                      <>
                        <Td bordeIzq><span style={{ color: GRIS }}>{diarioTxt ?? '—'}</span></Td>
                        <Td><span style={{ color: GRIS }}>{ispTxt ?? '—'}</span></Td>
                        <Td><span style={{ fontWeight: 600, color: col }}>{rc.isp2.toFixed(1)}</span></Td>
                        <Td>
                          <span style={{ fontSize: '11px', fontWeight: 600, padding: '3px 9px', borderRadius: '20px', background: bg, color: col, whiteSpace: 'nowrap' }}>{txt}</span>
                        </Td>
                      </>
                    )
                  })()}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: '16px', flexWrap: 'wrap', padding: '14px 16px',
                        borderTop: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
            <div style={{ fontSize: '13px', color: GRIS }}>
              Solo se escribe el peso. Crec. diario = (peso − gramaje de precría)
              ÷ días de engorde. ISP prom. = promedio de todos los incrementos
              semanales. ISP 2 sem = promedio de los 2 últimos. El semáforo usa el ISP 2 sem.
            </div>
            {practica ? (
              <span style={{ fontSize: '13px', color: GRIS, fontStyle: 'italic' }}>
                Práctica · no se guarda
              </span>
            ) : !soloLectura && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                {guardadoOk && <span style={{ fontSize: '13px', color: '#0F6E56', fontWeight: 500 }}>✓ Guardado</span>}
                <Btn primario onClick={guardar} disabled={guardando}>
                  {guardando ? 'Guardando...' : 'Guardar pesos'}
                </Btn>
                {muestreos.filter(fe => situacionDia(fe, hoy) !== 'futuro').map(fe => {
                  const cerrado = dias[fe] === 'cerrado'
                  const pedido = solReapertura.some(x => x.registro_id === diasId[fe])
                  const et = `${nombreDia(fe).slice(0, 3)} ${corta(fe).slice(0, 5)}`
                  if (cerrado) return (
                    <span key={fe} style={{ fontSize: '12px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      {et} cerrado
                      {esJefe
                        ? <button onClick={() => reabrirDia(fe)} disabled={cerrando === fe} style={{ background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', padding: 0 }}>reabrir</button>
                        : pedido
                          ? <span style={{ color: '#BA7517' }}>· pedido enviado</span>
                          : <button onClick={() => pedirReabrir(fe)} style={{ background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', padding: 0 }}>pedir reabrir</button>}
                    </span>
                  )
                  return (
                    <button key={fe} onClick={() => cerrarDia(fe)} disabled={cerrando === fe || guardando} style={{
                      padding: '9px 13px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                      border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY,
                      cursor: 'pointer', opacity: (cerrando === fe || guardando) ? 0.6 : 1 }}>
                      {cerrando === fe ? 'Cerrando...' : `Cerrar ${et}`}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Análisis · tendencia de crecimiento (gráfico de lo sucedido) */}
      {!cargando && !practica && filas.length > 0 && (
        <ChartBarras filas={filas} serie={serie} hasta={fechas[6]} mVerde={mVerde} mRojo={mRojo} crec={crecPorPisc} />
      )}

      {/* Reaperturas por autorizar (jefe) */}
      {!cargando && esJefe && solReapertura.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px',
                      padding: '13px 16px', marginTop: '14px' }}>
          <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>
            Reaperturas de gramaje por autorizar ({solReapertura.length})
          </div>
          {solReapertura.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: '10px', flexWrap: 'wrap', borderTop: '0.5px solid #ecd9b3', paddingTop: '9px', marginTop: '9px' }}>
              <div style={{ fontSize: '13px' }}>
                Reabrir el {corta(s.valor_propuesto?.fecha)}
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
    </div>
  )
}

// Análisis en barras. Todas las pestañas comparan TODAS las piscinas (barras
// horizontales, de peor a mejor). Al hacer clic en una piscina se abre su
// desglose semana a semana (domingo a domingo).
function ChartBarras({ filas, serie, hasta, mVerde, mRojo, crec }) {
  const [tab, setTab] = useState('sem')     // 'sem' | 'isp2' | 'isp' | 'diario'
  const [drill, setDrill] = useState(null)  // piscinaId del desglose, o null
  const meta = mVerde
  const colMeta = v => v < mRojo ? ROJO : v < mVerde ? AMBAR : VERDE
  const TABS = [['sem', 'Crec. sem'], ['isp2', 'ISP 2 sem'], ['isp', 'ISP prom.'], ['diario', 'Crec. diario']]
  const selStyle = { padding: '7px 10px', fontSize: '12px', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: '#fff', color: NAVY, fontFamily: 'inherit' }

  // ---------- Desglose de UNA piscina: barras domingo a domingo ----------
  if (drill) {
    const fila = filas.find(f => f.piscinaId === drill) || filas[0]
    const byW = {}
    ;(serie[fila?.cicloId] || []).forEach(m => {
      if (m.fecha <= hasta && new Date(m.fecha + 'T12:00:00').getDay() === 0) { const w = semanaISO(m.fecha); byW[w.anio + '-' + String(w.semana).padStart(2, '0')] = m }
    })
    const sem = Object.keys(byW).sort().map(kk => byW[kk]).slice(-9)
    const barras = []
    for (let i = 1; i < sem.length; i++) {
      const d = Math.round((new Date(sem[i].fecha + 'T12:00:00') - new Date(sem[i - 1].fecha + 'T12:00:00')) / 86400000)
      barras.push({ label: corta(sem[i].fecha).slice(0, 5), inc: d > 0 ? (sem[i].peso - sem[i - 1].peso) / d * 7 : null })
    }
    const vals = barras.map(b => b.inc).filter(v => v != null)
    const ymax = Math.max(meta + 1, ...(vals.length ? vals : [meta]))
    return (
      <div style={{ background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '14px', padding: '16px 18px', marginTop: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '2px' }}>
          <span onClick={() => setDrill(null)} style={{ fontSize: '13px', color: AZUL, fontWeight: 600, cursor: 'pointer' }}>‹ Volver</span>
          <span style={{ fontSize: '15px', fontWeight: 600 }}>Así creció {fila?.nombre}</span>
          <select value={fila?.piscinaId || ''} onChange={e => setDrill(e.target.value)} style={{ marginLeft: 'auto', ...selStyle }}>
            {filas.map(f => <option key={f.piscinaId} value={f.piscinaId}>{f.nombre}</option>)}
          </select>
        </div>
        <div style={{ fontSize: '12px', color: GRIS, marginBottom: '14px' }}>Crecimiento semanal domingo a domingo. La línea punteada es la meta ({meta}).</div>
        {barras.length === 0 ? <div style={{ fontSize: '13px', color: GRIS, padding: '20px 0' }}>Sin domingos suficientes para {fila?.nombre}.</div> : (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: '14px', height: '190px', borderBottom: '0.5px solid ' + BORDE, paddingTop: '10px' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, borderTop: '1.5px dashed ' + VERDE, top: (10 + (1 - meta / ymax) * 170) + 'px' }} />
            {barras.map((b, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                {b.inc != null && <span style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: colMeta(b.inc) }}>{b.inc.toFixed(1)}</span>}
                <div style={{ width: '100%', maxWidth: '44px', height: (b.inc != null ? Math.max(2, b.inc / ymax * 160) : 0) + 'px', background: b.inc != null ? colMeta(b.inc) : 'transparent', borderRadius: '6px 6px 0 0' }} />
                <span style={{ fontSize: '10px', color: GRIS, marginTop: '6px' }}>{b.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ---------- Comparación de TODAS las piscinas (según la pestaña) ----------
  const esSem = tab !== 'diario'
  const val = c => tab === 'sem' ? c.ultSem : tab === 'isp2' ? c.isp2 : tab === 'isp' ? c.isp : c.diario
  const items = filas.map(f => ({ f, c: crec[f.piscinaId] || {} }))
    .filter(x => !x.c.joven && val(x.c) != null)
    .sort((a, b) => val(a.c) - val(b.c))
  const vals = items.map(x => val(x.c))
  const ymax = esSem ? Math.max(meta * 1.15, ...(vals.length ? vals : [meta])) : Math.max(...(vals.length ? vals : [1]))
  const colBar = v => !esSem ? AZUL : colMeta(v)
  const subt = tab === 'sem' ? 'Crecimiento de la última semana (domingo a domingo) por piscina.'
    : tab === 'isp2' ? 'Promedio de las 2 últimas semanas por piscina.'
    : tab === 'isp' ? 'Promedio de todo el historial por piscina.'
    : 'Crecimiento diario (g/día) por piscina.'
  const tabEl = (id, txt) => (
    <span key={id} onClick={() => setTab(id)} style={{ fontSize: '12px', padding: '7px 13px', borderRadius: '8px', cursor: 'pointer',
      border: '0.5px solid ' + (tab === id ? NAVY : BORDE), background: tab === id ? NAVY : '#fff', color: tab === id ? '#fff' : GRIS }}>{txt}</span>
  )
  return (
    <div style={{ background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '14px', padding: '16px 18px', marginTop: '14px' }}>
      <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '2px' }}>Análisis · crecimiento</div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '14px' }}>{subt} Clic en una piscina para ver su desglose semana a semana.</div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map(([id, txt]) => tabEl(id, txt))}
      </div>
      {items.length === 0 ? <div style={{ fontSize: '13px', color: GRIS, padding: '20px 0' }}>Todavía no hay datos para comparar.</div> : (
        <div>
          {items.map(({ f, c }) => {
            const v = val(c), col = colBar(v)
            const w = Math.max(2, Math.min(100, v / ymax * 100))
            const metaPct = esSem ? Math.min(100, meta / ymax * 100) : null
            return (
              <div key={f.piscinaId} onClick={() => setDrill(f.piscinaId)} title="Clic para ver su desglose semana a semana"
                style={{ display: 'grid', gridTemplateColumns: '150px 1fr 52px', gap: '10px', alignItems: 'center', marginBottom: '11px', fontSize: '13px', cursor: 'pointer' }}>
                <span><span style={{ fontWeight: 500 }}>{f.nombre}</span><span style={{ color: GRIS, fontSize: '11px' }}> · {c.dias}d</span></span>
                <span style={{ position: 'relative', height: '20px', background: '#f2f6fa', borderRadius: '6px' }}>
                  <span style={{ position: 'absolute', left: 0, top: 0, height: '20px', width: w + '%', background: col, borderRadius: '6px' }} />
                  {metaPct != null && <span style={{ position: 'absolute', top: '-4px', height: '28px', width: '2px', background: VERDE, left: metaPct + '%' }} />}
                </span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: col, fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(tab === 'diario' ? 2 : 1)}</span>
              </div>
            )
          })}
          <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px' }}>
            {esSem ? 'Barra según la meta. La línea verde vertical es la meta (' + meta + ').' : 'Crecimiento diario (g/día).'} Clic en una piscina para su desglose.
          </div>
        </div>
      )}
    </div>
  )
}

// Panel de la meta de crecimiento de la finca: colapsado por defecto; el
// jefe lo abre para editar los dos cortes (verde/rojo). El ambar es lo del medio.
function MetaBar({ meta, mVerde, mRojo, esJefe, open, setOpen, form, setForm, onGuardar, msg }) {
  const dot = c => <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: c, display: 'inline-block', marginRight: '6px', verticalAlign: 'middle' }} />
  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: '#fff',
            border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 18px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>Meta de Gramaje</span>
        <span style={{ display: 'flex', gap: '16px', fontSize: '12.5px' }}>
          <span>{dot(ROJO)}&lt; {mRojo}</span>
          <span>{dot(AMBAR)}{mRojo} – {mVerde}</span>
          <span>{dot(VERDE)}&ge; {mVerde}</span>
        </span>
        {esJefe && (
          <span onClick={() => setOpen(true)} style={{ marginLeft: 'auto', fontSize: '13px', color: AZUL, fontWeight: 600, cursor: 'pointer' }}>Editar &#9662;</span>
        )}
      </div>
    )
  }
  return (
    <div style={{ border: '0.5px solid ' + AZUL, borderRadius: '12px', background: '#fff', overflow: 'hidden', marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', background: '#f2f8fd', padding: '14px 18px', borderBottom: '0.5px solid ' + BORDE }}>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>Meta de Gramaje</span>
        <span onClick={() => setOpen(false)} style={{ marginLeft: 'auto', fontSize: '13px', color: AZUL, fontWeight: 600, cursor: 'pointer' }}>Cerrar &#9652;</span>
      </div>
      <div style={{ padding: '22px 20px' }}>
        <div style={{ display: 'flex', gap: '40px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: '12px', color: GRIS, display: 'block', marginBottom: '8px' }}>{dot(VERDE)}Verde · en meta desde</label>
            <input value={form.verde} onChange={e => setForm(x => ({ ...x, verde: e.target.value }))} inputMode="decimal"
              style={{ width: '80px', padding: '11px 10px', fontSize: '18px', textAlign: 'center', border: '0.5px solid ' + BORDE, borderRadius: '9px', fontFamily: 'inherit' }} />
            <span style={{ fontSize: '12px', color: GRIS, marginLeft: '9px' }}>g/semana</span>
          </div>
          <div>
            <label style={{ fontSize: '12px', color: GRIS, display: 'block', marginBottom: '8px' }}>{dot(ROJO)}Rojo · muy lento bajo de</label>
            <input value={form.rojo} onChange={e => setForm(x => ({ ...x, rojo: e.target.value }))} inputMode="decimal"
              style={{ width: '80px', padding: '11px 10px', fontSize: '18px', textAlign: 'center', border: '0.5px solid ' + BORDE, borderRadius: '9px', fontFamily: 'inherit' }} />
            <span style={{ fontSize: '12px', color: GRIS, marginLeft: '9px' }}>g/semana</span>
          </div>
        </div>
        {msg && <div style={{ fontSize: '12px', color: msg.tipo === 'error' ? ROJO : VERDE, marginTop: '14px' }}>{msg.texto}</div>}
        <div style={{ display: 'flex', gap: '10px', marginTop: '24px', alignItems: 'center' }}>
          <button onClick={onGuardar} style={{ padding: '11px 20px', background: NAVY, color: '#fff', border: 'none', borderRadius: '9px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>Guardar</button>
          <button onClick={() => setOpen(false)} style={{ padding: '11px 16px', background: '#fff', border: '0.5px solid ' + BORDE, color: GRIS, borderRadius: '9px', fontSize: '13px', cursor: 'pointer' }}>Cancelar</button>
          {meta && <span style={{ marginLeft: 'auto', fontSize: '11px', color: GRIS }}>Guardado: {meta.verde} / {meta.rojo}</span>}
        </div>
        <div style={{ fontSize: '11px', color: GRIS, marginTop: '18px' }}>Solo el jefe de la finca puede cambiar la meta.</div>
      </div>
    </div>
  )
}

// Un bloque de día (Miércoles o Domingo): Peso ant. · Días · Peso · Crecimiento.
function Celdas({ fecha, hoy, fuera, puede, calc, valor, onChange, joven, ant, diasBloque, divide }) {
  const f = fecha === hoy ? HOYB : undefined
  if (fuera) return <><Td fondo={f} bordeIzq={divide} /><Td fondo={f} /><Td fondo={f}><Guion /></Td><Td fondo={f} /></>
  const baja = calc.inc !== undefined && calc.inc < 0
  const incColor = baja ? ROJO : GRIS, incPeso = baja ? 500 : 400
  return (
    <>
      <Td fondo={f} bordeIzq={divide}><span style={{ color: GRIS }}>{ant ? ant.peso + ' g' : <Guion />}</span></Td>
      <Td fondo={f}><span style={{ color: GRIS }}>{diasBloque ?? ''}</span></Td>
      <Td fondo={f}>
        {puede ? (
          <input inputMode="decimal" value={valor} placeholder="-"
            onChange={e => onChange(e.target.value)}
            style={{ width: '100%', padding: '6px', fontSize: '15px', textAlign: 'center',
                     fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '7px',
                     fontVariantNumeric: 'tabular-nums' }} />
        ) : (
          <span style={{ fontSize: '15px' }}>{valor || <Guion />}</span>
        )}
      </Td>
      <Td fondo={f}>
        {calc.inc === undefined ? '' : (
          <span style={{ color: incColor, fontWeight: incPeso }}>{(calc.inc > 0 ? '+' : '') + calc.inc.toFixed(2)}</span>
        )}
      </Td>
    </>
  )
}

function ChipG({ k, v, color }) {
  return (
    <div style={{ flex: '1 1 130px', background: 'white', border: '0.5px solid ' + BORDE,
                  borderRadius: '12px', padding: '10px 14px' }}>
      <div style={{ fontSize: '12px', color: color || GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 600, color: color || NAVY }}>{v}</div>
    </div>
  )
}

const Guion = () => <span style={{ color: '#c3d0db', fontSize: '12px' }}>—</span>

function Th({ children, pegado, fondo, bordeIzq }) {
  return (
    <div style={{
      padding: '10px 9px', fontSize: '11px', color: GRIS, fontWeight: 500, textAlign: 'center',
      background: fondo || '#fafcfd',
      ...(bordeIzq ? { borderLeft: '2px solid #cfe0ef' } : {}),
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 3, textAlign: 'left',
                     paddingLeft: '16px', borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Td({ children, pegado, fondo, alineado, bordeIzq }) {
  return (
    <div style={{
      padding: '9px', textAlign: alineado || 'center', fontSize: '13px',
      fontVariantNumeric: 'tabular-nums', background: fondo || 'white',
      ...(bordeIzq ? { borderLeft: '2px solid #cfe0ef' } : {}),
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 2, paddingLeft: '16px',
                     borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Btn({ children, onClick, primario, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: primario ? AZUL : 'white', color: primario ? 'white' : NAVY,
      border: '0.5px solid ' + (primario ? AZUL : BORDE), borderRadius: '9px',
      padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px',
      fontWeight: primario ? 500 : 400,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    }}>{children}</button>
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
  return (parseInt(a.codigo.replace(/\D/g, ''), 10) || 0) - (parseInt(b.codigo.replace(/\D/g, ''), 10) || 0)
}
