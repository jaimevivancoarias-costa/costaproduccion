import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, num, numDec, miles } from '../lib/fechas'

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

// Traduce los errores técnicos de la base a algo entendible en español.
// Los mensajes que ya vienen en español (de fn_transferir) pasan tal cual.
export function mensajeError(err) {
  const m = (err && err.message) || String(err || '')
  if (/ciclo_uno_abierto_por_piscina/.test(m)) return 'Una de las piscinas de destino ya tiene un cultivo vivo. Cosecha o transfiere el actual antes de meter otro ahí.'
  if (/ciclo_siembra_unica/.test(m)) return 'Ya hay un cultivo con esa misma fecha de siembra en esa piscina. Revisa el cultivo existente o usa otra fecha.'
  if (/duplicate key/i.test(m) && /dia_registro/.test(m)) return 'Ese día ya estaba registrado.'
  if (/duplicate key/i.test(m)) return 'Ese registro ya existe (puede ser un doble clic o un dato repetido). Recarga la página y revisa antes de reintentar.'
  if (/foreign key/i.test(m)) return 'Falta un dato relacionado o ya no existe. Recarga la página e intenta de nuevo.'
  if (/permission|row-level|rls/i.test(m)) return 'Tu usuario no tiene permiso para hacer esto.'
  return m
}

export async function guardarEvento({ tipo, fincaId, ciclo, piscina, datos }) {
  const { fecha, laboratorioId, larva, gramaje, libras, destinos, observacion } = datos

  if (tipo === 'siembra') {
    const pid = idPiscina(piscina)
    if (!pid) throw new Error('No se identificó la piscina')
    // Atómico: crea ciclo + ocupación + evento de una sola vez.
    const { error } = await supabase.schema('produccion').rpc('fn_sembrar', {
      p_finca: fincaId, p_piscina: pid, p_fecha: fecha,
      p_laboratorio: laboratorioId || null, p_larva: larva || null,
      p_gramaje: gramaje || null, p_observacion: observacion || null,
    })
    if (error) throw error
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
    // Atómico: registra la cosecha, cierra el ciclo y libera la piscina de
    // una sola vez. Si falla, no queda a medias.
    const { error } = await supabase.schema('produccion').rpc('fn_cosechar', {
      p_ciclo: cid, p_fecha: fecha, p_libras: lb, p_observacion: observacion || null,
    })
    if (error) throw error
    return
  }

  // Transferencia ATÓMICA: todo se hace en una sola operación en la base
  // (fn_transferir). Si algo falla, se revierte completo — nunca deja un
  // ciclo o evento colgado. Si la piscina destino ya tiene cultivo, se
  // juntan. destinos = [{ piscinaId, porcentaje?, cantidad? }].
  const dest = (destinos || []).map(d => ({
    piscina_id: d.piscinaId,
    porcentaje: d.porcentaje != null ? d.porcentaje : null,
    cantidad: d.cantidad != null ? d.cantidad : null,
  }))
  const { error } = await supabase.schema('produccion').rpc('fn_transferir', {
    p_ciclo: cid, p_fecha: fecha, p_libras: lb,
    p_observacion: observacion || null, p_destinos: dest,
    p_gramaje: gramaje > 0 ? gramaje : null,
  })
  if (error) throw error
}

// Cuenta el consumo REAL posterior a una fecha, para uno o varios ciclos.
// Es la regla que decide si se puede deshacer: la preparación de antes y
// las marcas "Sin alimentación" NO son consumo real y no deben bloquear;
// solo el cultivo de verdad (balanceado con libras, o insumos) posterior
// a la fecha del evento impide deshacerlo.
async function consumoRealDespues(cicloIds, fecha) {
  const ids = (Array.isArray(cicloIds) ? cicloIds : [cicloIds]).filter(Boolean)
  if (!ids.length) return { balanceado: 0, insumos: 0 }
  const [{ count: bal }, { count: ins }] = await Promise.all([
    supabase.schema('produccion').from('alimentacion')
      .select('id', { count: 'exact', head: true })
      .in('ciclo_id', ids).eq('sin_alimentacion', false).gt('libras', 0).gt('fecha', fecha),
    supabase.schema('produccion').from('consumo_insumo')
      .select('id', { count: 'exact', head: true })
      .in('ciclo_id', ids).gt('fecha', fecha),
  ])
  return { balanceado: bal || 0, insumos: ins || 0 }
}

// Deja el ciclo listo para borrarlo sin perder datos que no le pertenecen:
//  - Borra las marcas "Sin alimentación" (son solo notas, no consumo).
//  - Borra los muestreos de gramaje (no se borran en cascada; la base
//    rechazaría el borrado del ciclo si quedan).
//  - Suelta la preparación anterior (consumo de insumos con fecha <= la del
//    evento) dejándola SIN ciclo: no se pierde y queda disponible para el
//    cultivo que entre después. Es el caso "se cosecha, se cierra el ciclo,
//    y luego empieza la preparación del siguiente" (Sevilla).
async function soltarPreparacionYMarcas(cicloIds, fecha) {
  const ids = (Array.isArray(cicloIds) ? cicloIds : [cicloIds]).filter(Boolean)
  if (!ids.length) return
  await supabase.schema('produccion').from('alimentacion')
    .delete().in('ciclo_id', ids).eq('sin_alimentacion', true)
  await supabase.schema('produccion').from('muestreo').delete().in('ciclo_id', ids)
  await supabase.schema('produccion').from('consumo_insumo')
    .update({ ciclo_id: null }).in('ciclo_id', ids).lte('fecha', fecha)
}

// Deshacer un evento ya registrado. Es lo que permite corregir "me
// confundi": se borra el evento y se revierte lo que dejo hecho.
export async function eliminarEvento({ evento, cicloId }) {
  const id = evento.id
  const fecha = evento.fecha
  const tipo = evento.tipo

  if (tipo === 'siembra') {
    // Deshacer una siembra borra el ciclo entero. Solo se bloquea si el
    // cultivo ya vivió de verdad (balanceado o insumos DESPUÉS de la
    // siembra), o si tiene otra novedad sobre el mismo ciclo (esa se
    // deshace primero). La preparación anterior y las marcas no bloquean.
    const { count: cEv } = await supabase.schema('produccion').from('evento')
      .select('id', { count: 'exact', head: true }).eq('ciclo_id', cicloId).neq('id', id)
    const r = await consumoRealDespues(cicloId, fecha)
    if (r.balanceado > 0) {
      throw new Error('Este cultivo ya tiene balanceado registrado después de la siembra. Borra primero ese consumo.')
    }
    if (r.insumos > 0) {
      throw new Error('Este cultivo ya tiene consumo de insumos después de la siembra. Borra primero ese consumo.')
    }
    if ((cEv || 0) > 0) {
      throw new Error('Esta piscina tiene otra novedad (cosecha, raleo o transferencia) sobre el mismo ciclo. Deshaz esa primero.')
    }
    await soltarPreparacionYMarcas(cicloId, fecha)
    await supabase.schema('produccion').from('evento').delete().eq('id', id)
    await supabase.schema('produccion').from('ciclo_piscina').delete().eq('ciclo_id', cicloId)
    const { error } = await supabase.schema('produccion').from('ciclo').delete().eq('id', cicloId)
    if (error) throw new Error(mensajeError(error))
    return
  }

  if (tipo === 'cosecha') {
    // Reabrir el ciclo: vuelve a estar vivo y la piscina ocupada. Si la
    // piscina ya tiene un cultivo nuevo (siembra o transferencia posterior),
    // la base no deja dos ciclos abiertos: se avisa y NO se borra el evento,
    // para no dejar el ciclo cerrado sin cosecha (estado fantasma).
    const { error: eReabrir } = await supabase.schema('produccion').from('ciclo')
      .update({ estado: 'abierto', fecha_cierre: null, libras_cosechadas: null }).eq('id', cicloId)
    if (eReabrir) {
      if (/ciclo_uno_abierto_por_piscina/.test(eReabrir.message))
        throw new Error('No se puede deshacer esta cosecha: la piscina ya tiene un cultivo nuevo (una siembra o transferencia posterior). Deshaz primero ese cultivo nuevo.')
      throw new Error(eReabrir.message)
    }
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
    // Solo bloquea el cultivo REAL posterior a la transferencia. La
    // preparación de la piscina destino (secado/insumos de antes) no
    // bloquea: se suelta y queda para el cultivo que corresponda. Las
    // marcas "Sin alimentación" tampoco bloquean.
    const r = await consumoRealDespues(idsHijos, fecha)
    if (r.balanceado > 0) {
      throw new Error('Alguna piscina destino ya tiene balanceado registrado después de la transferencia. Borra primero ese consumo.')
    }
    if (r.insumos > 0) {
      throw new Error('Alguna piscina destino ya tiene consumo de insumos después de la transferencia. Borra primero ese consumo.')
    }
    await soltarPreparacionYMarcas(idsHijos, fecha)
    // El evento_destino apunta al ciclo hijo (ciclo_destino_id): hay que quitar
    // esa referencia ANTES o la base rechaza el borrado del ciclo (FK).
    await supabase.schema('produccion').from('evento_destino').delete().in('ciclo_destino_id', idsHijos)
    await supabase.schema('produccion').from('ciclo_piscina').delete().in('ciclo_id', idsHijos)
    const { error: eHijos } = await supabase.schema('produccion').from('ciclo').delete().in('id', idsHijos)
    if (eHijos) throw new Error('No se pudo borrar el cultivo destino: ' + mensajeError(eHijos))
  }

  // Reabrir el ciclo padre y devolverle la ocupacion del origen. Si el
  // origen ya tiene un cultivo nuevo, la base no deja dos abiertos: se avisa.
  const { error: eReabrir } = await supabase.schema('produccion').from('ciclo')
    .update({ estado: 'abierto', fecha_cierre: null }).eq('id', cicloId)
  if (eReabrir) {
    if (/ciclo_uno_abierto_por_piscina/.test(eReabrir.message))
      throw new Error('No se puede deshacer esta transferencia: la piscina de origen ya tiene un cultivo nuevo. Deshaz primero ese.')
    throw new Error(eReabrir.message)
  }
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
  const [dropAbierto, setDropAbierto] = useState(false)   // lista de piscinas destino

  // Las libras nunca bloquean el registro. El bodeguero no las sabe el
  // dia de la cosecha, llegan despues de la empacadora. Exigirlas hace
  // que invente un numero, y un numero inventado es peor que un vacio.
  const pideLibras = tipo === 'raleo' || tipo === 'cosecha'

  // Origen precria: se pasa el NUMERO real de animales (millones) a cada
  // piscina, no un %. De ahi sale la sobrevivencia. Piscina->piscina va en %.
  const esPrecria = objetivo?.tipo === 'precria'
  const larvasSembradas = num(objetivo?.larva) || 0

  // Para transferencia %, destinos = [{ piscinaId, porcentaje }]. Para
  // precria, destinos = [{ piscinaId, cantidad }].
  const sumaPct = destinos.reduce((t, d) => t + (Number(d.porcentaje) || 0), 0)
  const pctOk = destinos.length > 0 && Math.abs(sumaPct - 100) < 0.01
  const totalCant = destinos.reduce((t, d) => t + (num(d.cantidad) || 0), 0)
  const cantOk = destinos.length > 0 && destinos.every(d => num(d.cantidad) > 0)
  const sobrevivencia = esPrecria && larvasSembradas > 0 ? (totalCant / larvasSembradas) * 100 : null

  function toggleDestino(pid) {
    setDestinos(ds => {
      const existe = ds.some(d => d.piscinaId === pid)
      if (esPrecria) {
        // Sin reparto automatico: se escribe el numero real de cada una.
        return existe ? ds.filter(d => d.piscinaId !== pid) : [...ds, { piscinaId: pid, cantidad: '' }]
      }
      const base = existe ? ds.filter(d => d.piscinaId !== pid) : [...ds, { piscinaId: pid, porcentaje: 0 }]
      const n = base.length
      if (!n) return base
      const cada = Math.floor((100 / n) * 100) / 100
      return base.map((d, i) => ({
        ...d, porcentaje: i === n - 1 ? Number((100 - cada * (n - 1)).toFixed(2)) : cada,
      }))
    })
  }
  function setPct(pid, valor) {
    setDestinos(ds => ds.map(d => d.piscinaId === pid ? { ...d, porcentaje: valor } : d))
  }
  function setCant(pid, valor) {
    setDestinos(ds => ds.map(d => d.piscinaId === pid ? { ...d, cantidad: valor } : d))
  }

  // Gramaje obligatorio: al sembrar una precría (PLs/gramos) y en toda
  // transferencia (gramaje de transferencia).
  const gramajeOk = numDec(gramaje) > 0
  const listo = fecha && (
    tipo === 'transferencia'
      ? ((esPrecria ? cantOk : pctOk) && gramajeOk)
      : tipo === 'siembra' && esPrecria ? gramajeOk
      : true
  )

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
    // Precria: el % de costo sale del numero real de cada destino.
    const dest = esPrecria
      ? destinos.map(d => ({ piscinaId: d.piscinaId, cantidad: num(d.cantidad),
                             porcentaje: totalCant > 0 ? (num(d.cantidad) / totalCant) * 100 : 0 }))
      : destinos.map(d => ({ piscinaId: d.piscinaId, porcentaje: Number(d.porcentaje) || 0 }))
    await onGuardar({
      fecha, laboratorioId: lab || null, larva: num(larva), gramaje: numDec(gramaje),
      libras: num(libras), destinos: dest, observacion: obs,
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
            <Campo label={esPrecria ? 'PLs por gramo' : 'Gramaje de siembra (g)'}>
              <input inputMode="decimal" value={gramaje}
                     placeholder={esPrecria ? 'ej. 80 · Obligatorio' : 'Opcional'}
                     onChange={e => setGramaje(e.target.value)} style={entrada} />
              {esPrecria && (
                <div style={{ fontSize: '12px', color: GRIS, marginTop: '5px' }}>
                  Cuántas post-larvas (PLs) hay por gramo. Es obligatorio para sembrar la precría.
                </div>
              )}
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
                <div style={{ fontSize: '13px', color: GRIS }}>No hay otras piscinas disponibles.</div>
              ) : (
                <>
                  {/* Campo con las elegidas como chips + abrir la lista. */}
                  <div onClick={() => setDropAbierto(v => !v)}
                    style={{ border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '7px 9px',
                             display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
                             cursor: 'pointer', minHeight: '38px', boxSizing: 'border-box' }}>
                    {destinos.map(d => {
                      const nom = destinosPosibles.find(p => p.id === d.piscinaId)?.nombre || ''
                      return (
                        <span key={d.piscinaId} style={{ fontSize: '13px', background: '#E6F1FB', color: AZUL,
                              borderRadius: '14px', padding: '3px 6px 3px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          {nom}
                          <span onClick={e => { e.stopPropagation(); toggleDestino(d.piscinaId) }}
                            style={{ cursor: 'pointer', fontSize: '12px' }}>✕</span>
                        </span>
                      )
                    })}
                    <span style={{ flex: 1, minWidth: '70px', fontSize: '13px', color: GRIS,
                                   display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      {destinos.length ? 'Agregar…' : 'Elegir piscinas…'} <span style={{ fontSize: '11px' }}>▾</span>
                    </span>
                  </div>
                  {dropAbierto && (
                    <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '9px', maxHeight: '160px',
                                  overflow: 'auto', marginTop: '6px' }}>
                      {destinosPosibles.map((p, i) => {
                        const on = destinos.some(d => d.piscinaId === p.id)
                        return (
                          <div key={p.id} onClick={() => toggleDestino(p.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '8px 11px',
                                     fontSize: '13.5px', cursor: 'pointer',
                                     borderBottom: i < destinosPosibles.length - 1 ? '0.5px solid #f1f6f9' : 'none',
                                     background: on ? '#f6fafe' : 'white' }}>
                            <input type="checkbox" readOnly checked={on} />
                            <span style={{ flex: 1 }}>{p.nombre}</span>
                            {p.ocupada && <span style={{ color: '#BA7517' }}>•</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {destinosPosibles.some(p => p.ocupada) && (
                    <div style={{ fontSize: '12px', color: '#BA7517', marginTop: '7px' }}>
                      Las piscinas con un punto ya tienen camarón (se juntan los lotes).
                    </div>
                  )}
                </>
              )}
            </Campo>

            {destinos.length > 0 && esPrecria && (
              <Campo label="Animales que pasaron a cada una">
                {destinos.map(d => {
                  const nombre = destinosPosibles.find(p => p.id === d.piscinaId)?.nombre || ''
                  return (
                    <div key={d.piscinaId} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '7px' }}>
                      <span style={{ flex: 1, fontSize: '14px' }}>{nombre}</span>
                      <input inputMode="decimal" value={d.cantidad}
                        placeholder={larvasSembradas > 0 ? String(Math.round(larvasSembradas * 0.9)) : 'número'}
                        onChange={e => setCant(d.piscinaId, e.target.value)}
                        style={{ ...entrada, width: '150px', textAlign: 'right' }} />
                      <span style={{ fontSize: '13px', color: GRIS, width: '52px' }}>animales</span>
                    </div>
                  )
                })}
                {larvasSembradas > 0 && totalCant > 0 && (
                  <div style={{ fontSize: '13px', marginTop: '8px', padding: '8px 11px', borderRadius: '9px',
                                background: '#E1F5EE', color: '#0F6E56' }}>
                    Pasaron {Math.round(totalCant).toLocaleString('es-EC')} de {larvasSembradas.toLocaleString('es-EC')} sembrados ·
                    <b> sobrevivencia {Math.round(sobrevivencia * 10) / 10}%</b>
                  </div>
                )}
                {larvasSembradas <= 0 && (
                  <div style={{ fontSize: '12px', color: '#BA7517', marginTop: '6px' }}>
                    Esta precría no tiene larvas sembradas registradas, así que no se puede calcular sobrevivencia.
                  </div>
                )}
              </Campo>
            )}

            {destinos.length > 0 && !esPrecria && (
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
              </Campo>
            )}

            {destinos.length > 0 && (
              <Campo label="Gramaje de transferencia (g)">
                <input inputMode="decimal" value={gramaje} placeholder="Obligatorio"
                       onChange={e => setGramaje(e.target.value)} style={entrada} />
                <div style={{ fontSize: '12px', color: GRIS, marginTop: '5px' }}>
                  El tamaño (gramaje) del camarón al momento de pasarlo. Es obligatorio.
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
