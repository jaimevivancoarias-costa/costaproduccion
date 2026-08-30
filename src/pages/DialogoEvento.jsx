import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, num, miles } from '../lib/fechas'

// Los cuatro eventos, en un dialogo que se abre desde la fila de la
// piscina en el registro diario. No es una pantalla aparte: en el Excel
// el estado de la piscina es una columna mas de la tabla semanal.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export const TIPOS = {
  siembra:       { nombre: 'Siembra',       color: '#0F6E56', fondo: '#E1F5EE' },
  raleo:         { nombre: 'Raleo',         color: '#854F0B', fondo: '#FAEEDA' },
  transferencia: { nombre: 'Transferencia', color: '#3C3489', fondo: '#EEEDFE' },
  cosecha:       { nombre: 'Cosecha',       color: '#0C447C', fondo: '#E6F1FB' },
}

// La fila del registro diario trae piscinaId; una piscina suelta trae id.
const idPiscina = p => p?.piscinaId ?? p?.id
const idCiclo   = c => c?.cicloId ?? c?.id

export async function guardarEvento({ tipo, fincaId, ciclo, piscina, datos }) {
  const { fecha, laboratorioId, larva, gramaje, libras, destinos, observacion } = datos

  if (tipo === 'siembra') {
    const pid = idPiscina(piscina)
    if (!pid) throw new Error('No se identificó la piscina')
    const { data: c, error } = await supabase.schema('produccion').from('ciclo')
      .insert({ finca_id: fincaId, piscina_origen_id: pid, fecha_siembra: fecha,
                laboratorio_id: laboratorioId || null, cantidad_larva: larva || null,
                gramaje_precria: gramaje || null })
      .select('id').single()
    if (error) throw error
    await supabase.schema('produccion').from('ciclo_piscina')
      .insert({ ciclo_id: c.id, piscina_id: pid, fecha_desde: fecha })
    await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: c.id, tipo: 'siembra', fecha, piscina_origen_id: pid,
                observacion: observacion || null })
    return
  }

  const cid = idCiclo(ciclo)
  const base = { ciclo_id: cid, fecha, piscina_origen_id: idPiscina(ciclo),
                 observacion: observacion || null }

  // Vacio se guarda como null, no como cero. Cero significaria que se
  // coseho y no salio nada; null significa que el dato no ha llegado.
  const lb = num(libras) > 0 ? num(libras) : null

  if (tipo === 'raleo') {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ...base, tipo: 'raleo', libras: lb })
    if (error) throw error
    return
  }

  if (tipo === 'cosecha') {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ...base, tipo: 'cosecha', libras: lb })
    if (error) throw error
    const { error: e2 } = await supabase.schema('produccion').from('ciclo')
      .update({ estado: 'cerrado', fecha_cierre: fecha, libras_cosechadas: lb })
      .eq('id', cid)
    if (e2) throw e2
    await supabase.schema('produccion').from('ciclo_piscina')
      .update({ fecha_hasta: fecha }).eq('ciclo_id', cid).is('fecha_hasta', null)
    return
  }

  // Transferencia: es TOTAL. El ciclo de origen se cierra (la piscina
  // queda vacia) y nace un ciclo hijo en cada destino con su porcentaje.
  // El hijo conserva la fecha de siembra del padre para que los dias de
  // cultivo sigan corriendo: es el mismo lote de camaron.
  //
  // destinos aqui es [{ piscinaId, porcentaje }].
  const { data: padre, error: eP } = await supabase.schema('produccion').from('ciclo')
    .select('finca_id, fecha_siembra, laboratorio_id, cantidad_larva').eq('id', cid).single()
  if (eP) throw eP

  const { data: ev, error } = await supabase.schema('produccion').from('evento')
    .insert({ ...base, tipo: 'transferencia', libras: lb })
    .select('id').single()
  if (error) throw error

  await supabase.schema('produccion').from('evento_destino')
    .insert(destinos.map(d => ({ evento_id: ev.id, piscina_id: d.piscinaId, porcentaje: d.porcentaje })))

  // Cerrar el ciclo de origen: transferido, no cosechado, pero la
  // piscina queda libre igual.
  await supabase.schema('produccion').from('ciclo')
    .update({ estado: 'cerrado', fecha_cierre: fecha }).eq('id', cid)
  await supabase.schema('produccion').from('ciclo_piscina')
    .update({ fecha_hasta: fecha }).eq('ciclo_id', cid).is('fecha_hasta', null)

  // Un ciclo hijo por destino.
  for (const d of destinos) {
    const { data: hijo, error: eH } = await supabase.schema('produccion').from('ciclo')
      .insert({
        finca_id: fincaId,
        piscina_origen_id: d.piscinaId,
        fecha_siembra: padre.fecha_siembra,   // conserva los dias de cultivo
        fecha_ocupacion: fecha,               // empieza a comer aqui hoy
        laboratorio_id: padre.laboratorio_id,
        ciclo_padre_id: cid,
        origen_porcentaje: d.porcentaje,
      }).select('id').single()
    if (eH) throw eH
    await supabase.schema('produccion').from('ciclo_piscina')
      .insert({ ciclo_id: hijo.id, piscina_id: d.piscinaId, fecha_desde: fecha })
  }
}

// Deshacer un evento ya registrado. Es lo que permite corregir "me
// confundi": se borra el evento y se revierte lo que dejo hecho.
export async function eliminarEvento({ evento, cicloId }) {
  const id = evento.id
  const fecha = evento.fecha
  const tipo = evento.tipo

  if (tipo === 'siembra') {
    // Deshacer una siembra borra el ciclo entero. No se puede si tiene
    // consumo colgando (quedarian registros huerfanos), ni si tiene otra
    // novedad sobre el mismo ciclo: en ese caso hay que deshacer esa
    // primero, para que quede claro que se esta borrando.
    const [{ count: cAlim }, { count: cIns }, { count: cEv }] = await Promise.all([
      supabase.schema('produccion').from('alimentacion')
        .select('id', { count: 'exact', head: true }).eq('ciclo_id', cicloId),
      supabase.schema('produccion').from('consumo_insumo')
        .select('id', { count: 'exact', head: true }).eq('ciclo_id', cicloId),
      supabase.schema('produccion').from('evento')
        .select('id', { count: 'exact', head: true }).eq('ciclo_id', cicloId).neq('id', id),
    ])
    if ((cAlim || 0) > 0 || (cIns || 0) > 0) {
      throw new Error('Esta siembra ya tiene consumo registrado. Borra primero el consumo de esos días.')
    }
    if ((cEv || 0) > 0) {
      throw new Error('Esta piscina tiene otra novedad (cosecha, raleo o transferencia) sobre el mismo ciclo. Deshaz esa primero.')
    }
    // Los muestreos de gramaje no borran en cascada: hay que quitarlos
    // a mano antes de borrar el ciclo, o la base lo rechaza (error 409).
    await supabase.schema('produccion').from('muestreo').delete().eq('ciclo_id', cicloId)
    await supabase.schema('produccion').from('evento').delete().eq('id', id)
    await supabase.schema('produccion').from('ciclo_piscina').delete().eq('ciclo_id', cicloId)
    const { error } = await supabase.schema('produccion').from('ciclo').delete().eq('id', cicloId)
    if (error) throw new Error(error.message)
    return
  }

  if (tipo === 'cosecha') {
    // Reabrir el ciclo: vuelve a estar vivo y la piscina ocupada.
    await supabase.schema('produccion').from('ciclo')
      .update({ estado: 'abierto', fecha_cierre: null, libras_cosechadas: null }).eq('id', cicloId)
    await supabase.schema('produccion').from('ciclo_piscina')
      .update({ fecha_hasta: null }).eq('ciclo_id', cicloId).eq('fecha_hasta', fecha)
    await supabase.schema('produccion').from('evento').delete().eq('id', id)
    return
  }

  if (tipo === 'raleo') {
    await supabase.schema('produccion').from('evento').delete().eq('id', id)
    return
  }

  // Transferencia: borrar los ciclos hijos que nacieron y reabrir el
  // padre. Solo se puede si ningun hijo tiene ya consumo colgando.
  const { data: hijos } = await supabase.schema('produccion').from('ciclo')
    .select('id').eq('ciclo_padre_id', cicloId).eq('fecha_ocupacion', fecha)
  const idsHijos = (hijos || []).map(h => h.id)

  if (idsHijos.length) {
    const [{ count: cAlim }, { count: cIns }] = await Promise.all([
      supabase.schema('produccion').from('alimentacion')
        .select('id', { count: 'exact', head: true }).in('ciclo_id', idsHijos),
      supabase.schema('produccion').from('consumo_insumo')
        .select('id', { count: 'exact', head: true }).in('ciclo_id', idsHijos),
    ])
    if ((cAlim || 0) > 0 || (cIns || 0) > 0) {
      throw new Error('Alguna piscina destino ya tiene consumo registrado. Borra primero ese consumo.')
    }
    await supabase.schema('produccion').from('ciclo_piscina').delete().in('ciclo_id', idsHijos)
    await supabase.schema('produccion').from('ciclo').delete().in('id', idsHijos)
  }

  // Reabrir el ciclo padre y devolverle la ocupacion del origen.
  await supabase.schema('produccion').from('ciclo')
    .update({ estado: 'abierto', fecha_cierre: null }).eq('id', cicloId)
  await supabase.schema('produccion').from('ciclo_piscina')
    .update({ fecha_hasta: null }).eq('ciclo_id', cicloId).eq('fecha_hasta', fecha)
  await supabase.schema('produccion').from('evento_destino').delete().eq('evento_id', id)
  await supabase.schema('produccion').from('evento').delete().eq('id', id)
}

export default function DialogoEvento({ tipo, ciclo, piscina, laboratorios, destinosPosibles,
                                        minima, onCancelar, onGuardar, onLaboratorioAgregado }) {
  const t = TIPOS[tipo]
  const objetivo = piscina || ciclo
  const [fecha, setFecha] = useState(hoyISO())
  const [libras, setLibras] = useState('')
  const [larva, setLarva] = useState('')
  const [gramaje, setGramaje] = useState('')
  const [lab, setLab] = useState('')
  const [destinos, setDestinos] = useState([])
  const [obs, setObs] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [errorLab, setErrorLab] = useState(null)

  // Las libras nunca bloquean el registro. El bodeguero no las sabe el
  // dia de la cosecha, llegan despues de la empacadora. Exigirlas hace
  // que invente un numero, y un numero inventado es peor que un vacio.
  const pideLibras = tipo === 'raleo' || tipo === 'cosecha'

  // Para transferencia, destinos = [{ piscinaId, porcentaje }]. Al
  // marcar o desmarcar una piscina se reparte el 100% en partes iguales;
  // despues se puede ajustar a mano.
  const sumaPct = destinos.reduce((t, d) => t + (Number(d.porcentaje) || 0), 0)
  const pctOk = destinos.length > 0 && Math.abs(sumaPct - 100) < 0.01

  function toggleDestino(pid) {
    setDestinos(ds => {
      const existe = ds.some(d => d.piscinaId === pid)
      const base = existe ? ds.filter(d => d.piscinaId !== pid) : [...ds, { piscinaId: pid, porcentaje: 0 }]
      const n = base.length
      if (!n) return base
      // Reparto en partes iguales, ajustando el ultimo para que sume 100.
      const cada = Math.floor((100 / n) * 100) / 100
      return base.map((d, i) => ({
        ...d, porcentaje: i === n - 1 ? Number((100 - cada * (n - 1)).toFixed(2)) : cada,
      }))
    })
  }
  function setPct(pid, valor) {
    setDestinos(ds => ds.map(d => d.piscinaId === pid ? { ...d, porcentaje: valor } : d))
  }

  const listo = fecha && (tipo !== 'transferencia' || pctOk)

  // Mismo comportamiento que en la columna del registro diario: si ya
  // existe escrito de otra forma, se usa el que esta en vez de crear un
  // duplicado. El catalogo lo comparten las nueve fincas.
  async function agregarLaboratorio() {
    const escrito = window.prompt('Nombre del laboratorio')
    if (!escrito) return
    const nombre = escrito.trim()
    if (!nombre) return

    const ya = laboratorios.find(l => l.nombre.toLowerCase() === nombre.toLowerCase())
    if (ya) { setLab(ya.id); setErrorLab(`Ya existía como "${ya.nombre}". Se usó ese.`); return }

    const { data, error } = await supabase.schema('produccion').from('laboratorio')
      .insert({ nombre }).select('id, nombre').single()
    if (error) { setErrorLab('No se pudo agregar. ' + error.message); return }
    setErrorLab(null)
    onLaboratorioAgregado?.(data)
    setLab(data.id)
  }

  async function enviar() {
    setEnviando(true)
    await onGuardar({
      fecha, laboratorioId: lab || null, larva: num(larva), gramaje: num(gramaje),
      libras: num(libras), destinos, observacion: obs,
    })
    setEnviando(false)
  }

  const ha = Number(objetivo?.hectareas || 0)
  const densidad = num(larva) && ha ? num(larva) / ha : null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
      <div style={{ background: 'white', borderRadius: '14px', padding: '22px', width: '100%',
                    maxWidth: '440px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px',
                         background: t.fondo, color: t.color }}>{t.nombre}</span>
          <span style={{ fontSize: '17px', fontWeight: 500 }}>{objetivo?.nombre}</span>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: GRIS }}>{ayuda(tipo)}</p>

        <Campo label="Fecha">
          <input type="date" value={fecha} max={hoyISO()} min={minima || undefined}
                 onChange={e => setFecha(e.target.value)} style={entrada} />
        </Campo>

        {tipo === 'siembra' && (
          <>
            <Campo label="Laboratorio">
              <select
                value={lab}
                onChange={e => e.target.value === '__nuevo' ? agregarLaboratorio() : setLab(e.target.value)}
                style={entrada}
              >
                <option value="">Sin especificar</option>
                {laboratorios.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                <option value="__nuevo">+ Agregar laboratorio nuevo</option>
              </select>
              {errorLab && (
                <div style={{ fontSize: '12px', color: '#854F0B', marginTop: '5px' }}>{errorLab}</div>
              )}
            </Campo>
            <Campo label="Cantidad de larva">
              <input inputMode="numeric" value={larva} placeholder="Por ejemplo 2500000"
                     onChange={e => setLarva(e.target.value)} style={entrada} />
            </Campo>
            {densidad && (
              <div style={{ fontSize: '12px', color: GRIS, margin: '-6px 0 12px' }}>
                Densidad: <b style={{ color: NAVY, fontWeight: 500 }}>{miles(densidad)}</b> larvas por hectárea
              </div>
            )}
            <Campo label="Gramaje de precría">
              <input inputMode="decimal" value={gramaje} placeholder="Opcional"
                     onChange={e => setGramaje(e.target.value)} style={entrada} />
            </Campo>
          </>
        )}

        {pideLibras && (
          <Campo label={tipo === 'raleo' ? 'Libras raleadas' : 'Libras cosechadas'}>
            <input inputMode="numeric" value={libras} placeholder="Si todavía no las sabes, déjalo vacío"
                   onChange={e => setLibras(e.target.value)} style={entrada} />
            <div style={{ fontSize: '12px', color: GRIS, marginTop: '5px' }}>
              {num(libras) > 0
                ? 'Con este dato el sistema calcula el costo por libra del ciclo.'
                : 'Puedes registrarla ahora y cargar las libras cuando llegue el dato de la empacadora. Mientras esté vacía, el costo por libra queda pendiente.'}
            </div>
          </Campo>
        )}

        {tipo === 'transferencia' && (
          <>
            <Campo label="Transferido a">
              {!destinosPosibles?.length ? (
                <div style={{ fontSize: '13px', color: GRIS }}>No hay piscinas vacías disponibles.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {destinosPosibles.map(p => {
                    const on = destinos.some(d => d.piscinaId === p.id)
                    return (
                      <button key={p.id} onClick={() => toggleDestino(p.id)}
                        style={{ padding: '7px 13px', borderRadius: '20px', fontFamily: 'inherit',
                                 fontSize: '13px', cursor: 'pointer',
                                 border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
                                 background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY,
                                 fontWeight: on ? 500 : 400 }}>
                        {p.nombre}
                      </button>
                    )
                  })}
                </div>
              )}
            </Campo>

            {destinos.length > 0 && (
              <Campo label="Cuánto va a cada una">
                {destinos.map(d => {
                  const nombre = destinosPosibles.find(p => p.id === d.piscinaId)?.nombre || ''
                  return (
                    <div key={d.piscinaId} style={{ display: 'flex', alignItems: 'center', gap: '10px',
                          marginBottom: '7px' }}>
                      <span style={{ flex: 1, fontSize: '14px' }}>{nombre}</span>
                      <input inputMode="decimal" value={d.porcentaje}
                        onChange={e => setPct(d.piscinaId, e.target.value)}
                        style={{ ...entrada, width: '90px', textAlign: 'right' }} />
                      <span style={{ fontSize: '13px', color: GRIS, width: '14px' }}>%</span>
                    </div>
                  )
                })}
                <div style={{ fontSize: '12px', marginTop: '4px',
                              color: pctOk ? '#0F6E56' : '#A32D2D' }}>
                  {pctOk ? 'Suma 100%.'
                    : `Suman ${sumaPct}%. Tienen que sumar exactamente 100%.`}
                </div>
                <div style={{ fontSize: '12px', color: GRIS, marginTop: '4px' }}>
                  El porcentaje reparte el costo del ciclo entre los destinos. Cada piscina
                  sigue el mismo ciclo: conserva los días de cultivo desde la siembra.
                </div>
              </Campo>
            )}

            <Campo label="Libras transferidas">
              <input inputMode="numeric" value={libras} placeholder="Opcional"
                     onChange={e => setLibras(e.target.value)} style={entrada} />
            </Campo>
          </>
        )}

        <Campo label="Observación">
          <input value={obs} placeholder="Opcional" onChange={e => setObs(e.target.value)} style={entrada} />
        </Campo>

        <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button onClick={onCancelar} style={{ ...boton, background: 'white', color: NAVY }}>Cancelar</button>
          <button onClick={enviar} disabled={!listo || enviando}
                  style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL,
                           opacity: (!listo || enviando) ? 0.45 : 1,
                           cursor: (!listo || enviando) ? 'default' : 'pointer' }}>
            {enviando ? 'Guardando...' : 'Registrar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ayuda(tipo) {
  if (tipo === 'siembra') return 'Entra la larva y arranca el ciclo. Los días de cultivo se cuentan desde esta fecha.'
  if (tipo === 'raleo') return 'Cosecha parcial. El ciclo sigue vivo y la piscina sigue comiendo.'
  if (tipo === 'transferencia') return 'El camarón pasa a otras piscinas. El ciclo continúa, no nace uno nuevo.'
  return 'Se saca todo. El ciclo se cierra y la piscina queda libre para sembrar de nuevo.'
}

const entrada = { width: '100%', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const boton = { padding: '10px 18px', fontSize: '14px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', cursor: 'pointer' }

function Campo({ label, children }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>
      {children}
    </div>
  )
}
