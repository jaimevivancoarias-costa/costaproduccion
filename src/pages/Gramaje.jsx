import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  hoyISO, lunesDe, sumarDias, semanaDe, corta, nombreDia,
  esDiaDeMuestreo, diasCultivo, situacionDia, num, numDec, miles,
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
const HOYB = '#E6F1FB'

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

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const muestreos = useMemo(() => fechas.filter(esDiaDeMuestreo), [fechas])
  const hoy = hoyISO()
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
        .select('id, fecha_siembra, fecha_cierre, cantidad_larva, piscina:piscina_origen_id (id, codigo, nombre, hectareas, tipo)')
        .eq('finca_id', finca.id)
        .lte('fecha_siembra', domingo)
        .or(`fecha_cierre.is.null,fecha_cierre.gte.${lunes}`)
      if (error) throw error

      const lista = (ciclos || [])
        .filter(c => c.piscina && c.piscina.tipo === 'engorde')
        .map(c => ({
          cicloId: c.id, piscinaId: c.piscina.id, codigo: c.piscina.codigo,
          nombre: c.piscina.nombre, hectareas: Number(c.piscina.hectareas),
          fechaSiembra: c.fecha_siembra, fechaCierre: c.fecha_cierre,
          larva: c.cantidad_larva,
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

      const v = {}, prev = {}
      ;(ms || []).forEach(m => {
        if (m.fecha >= lunes && m.fecha <= domingo) {
          v[`${m.piscina_id}|${m.fecha}`] = String(m.peso_gramos)
        }
        // El ultimo muestreo anterior al lunes de esta semana.
        if (m.fecha < lunes) prev[m.ciclo_id] = { fecha: m.fecha, peso: Number(m.peso_gramos) }
      })
      setValores(v); setPrevios(prev)

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

  // Peso anterior a una fecha dada, mirando primero dentro de la semana.
  function anterior(fila, fecha) {
    const dentro = muestreos
      .filter(f => f < fecha && numDec(valores[`${fila.piscinaId}|${f}`]))
      .map(f => ({ fecha: f, peso: numDec(valores[`${fila.piscinaId}|${f}`]) }))
    if (dentro.length) return dentro[dentro.length - 1]
    return previos[fila.cicloId] || null
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

  const COLS = `170px 56px 128px ${muestreos.map(() => '112px 88px 74px 88px').join(' ')} 116px`

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
            <div style={{ minWidth: '1100px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Piscina</Th>
                <Th>Días</Th>
                <Th>Muestreo anterior</Th>
                {muestreos.map(f => (
                  <Grupo key={f} fecha={f} hoy={hoy} />
                ))}
                <Th>Densidad por ha</Th>
              </div>

              {filas.map(fila => (
                <div key={fila.piscinaId} style={{ display: 'grid', gridTemplateColumns: COLS,
                      borderBottom: '0.5px solid #f1f6f9', alignItems: 'center' }}>
                  <Td pegado alineado="left">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>{fila.nombre}</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>{fila.hectareas.toFixed(2)} ha</div>
                  </Td>
                  <Td><span style={{ fontWeight: 500 }}>
                    {fila.fechaSiembra ? diasCultivo(fila.fechaSiembra, corteDias) : <Guion />}
                  </span></Td>
                  <Td>
                    {previos[fila.cicloId] ? (
                      <>
                        <div style={{ fontSize: '14px' }}>{previos[fila.cicloId].peso} g</div>
                        <div style={{ fontSize: '11px', color: GRIS }}>{corta(previos[fila.cicloId].fecha)}</div>
                      </>
                    ) : <span style={{ color: '#c3d0db', fontSize: '12px' }}>sin muestreos</span>}
                  </Td>

                  {muestreos.map(f => {
                    const fuera = (fila.fechaCierre && f > fila.fechaCierre) || f < fila.fechaSiembra
                    const c = calculo(fila, f)
                    const puede = (practica ? situacionDia(f, hoy) !== 'futuro' : editable(f)) && !fuera
                    const futuro = situacionDia(f, hoy) === 'futuro'
                    return (
                      <Grupo.Celdas
                        key={f} fecha={f} hoy={hoy}
                        fuera={fuera} futuro={futuro} puede={puede} calc={c}
                        valor={valores[`${fila.piscinaId}|${f}`] || ''}
                        onChange={v => setValores(x => ({ ...x, [`${fila.piscinaId}|${f}`]: v }))}
                      />
                    )
                  })}

                  <Td><span style={{ color: GRIS }}>
                    {fila.larva ? miles(fila.larva / fila.hectareas) : ''}
                  </span></Td>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: '16px', flexWrap: 'wrap', padding: '14px 16px',
                        borderTop: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
            <div style={{ fontSize: '13px', color: GRIS }}>
              Solo se escribe el peso. El incremento, los días entre muestras y el
              crecimiento diario se calculan contra el muestreo anterior del mismo ciclo.
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

// Cabecera de un dia de muestreo: cuatro columnas agrupadas.
function Grupo({ fecha, hoy }) {
  const es = fecha === hoy
  const f = es ? HOYB : undefined
  return (
    <>
      <Th fondo={f}>{nombreDia(fecha)} {corta(fecha).slice(0, 5)}<br />
        <span style={{ color: NAVY }}>Peso g</span></Th>
      <Th fondo={f}>Incremento</Th>
      <Th fondo={f}>Días</Th>
      <Th fondo={f}>Crec. diario</Th>
    </>
  )
}

Grupo.Celdas = function Celdas({ fecha, hoy, fuera, futuro, puede, calc, valor, onChange }) {
  const f = fecha === hoy ? HOYB : undefined
  if (fuera) return <><Td fondo={f}><Guion /></Td><Td fondo={f} /><Td fondo={f} /><Td fondo={f} /></>
  if (futuro) return <><Td fondo={f}><Guion /></Td><Td fondo={f} /><Td fondo={f} /><Td fondo={f} /></>
  const baja = calc.inc !== undefined && calc.inc < 0
  return (
    <>
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
      <Td fondo={f}><span style={{ color: baja ? '#A32D2D' : GRIS, fontWeight: baja ? 500 : 400 }}>
        {calc.inc === undefined ? '' : (calc.inc > 0 ? '+' : '') + calc.inc.toFixed(2)}
      </span></Td>
      <Td fondo={f}><span style={{ color: GRIS }}>{calc.dias ?? ''}</span></Td>
      <Td fondo={f}><span style={{ color: baja ? '#A32D2D' : GRIS, fontWeight: baja ? 500 : 400 }}>
        {calc.crec == null ? '' : calc.crec.toFixed(2)}
      </span></Td>
    </>
  )
}

const Guion = () => <span style={{ color: '#c3d0db', fontSize: '12px' }}>—</span>

function Th({ children, pegado, fondo }) {
  return (
    <div style={{
      padding: '10px 9px', fontSize: '11px', color: GRIS, fontWeight: 500, textAlign: 'center',
      background: fondo || '#fafcfd',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 3, textAlign: 'left',
                     paddingLeft: '16px', borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Td({ children, pegado, fondo, alineado }) {
  return (
    <div style={{
      padding: '9px', textAlign: alineado || 'center', fontSize: '13px',
      fontVariantNumeric: 'tabular-nums', background: fondo || 'white',
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
