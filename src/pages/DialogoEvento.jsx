import { useState, useEffect } from 'react'
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
  const { fecha, laboratorioId, larva, gramaje, libras, destinos, observacion, cerrarOrigen } = datos

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
    // Si queda remanente, el origen NO se cierra (sigue vivo con lo que quedó).
    p_cerrar_origen: cerrarOrigen !== false,
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

  // Destinos que se JUNTARON con un ciclo que ya existía (no son hijos nuevos):
  // al deshacer hay que restarles la cantidad que esta transferencia les sumó,
  // si no, quedan inflados (el ciclo se queda, solo se corrige su larva).
  const { data: destTodos } = await supabase.schema('produccion').from('evento_destino')
    .select('ciclo_destino_id, cantidad').eq('evento_id', id)
  const juntados = (destTodos || []).filter(d =>
    d.ciclo_destino_id && !idsHijos.includes(d.ciclo_destino_id) && d.cantidad != null)

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
  // Restar lo que la transferencia sumó a los ciclos con los que se juntó.
  for (const j of juntados) {
    const { data: cic } = await supabase.schema('produccion').from('ciclo')
      .select('cantidad_larva').eq('id', j.ciclo_destino_id).maybeSingle()
    const nueva = Math.max(0, (Number(cic?.cantidad_larva) || 0) - (Number(j.cantidad) || 0))
    await supabase.schema('produccion').from('ciclo')
      .update({ cantidad_larva: nueva }).eq('id', j.ciclo_destino_id)
  }
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
  const [repartirPor, setRepartirPor] = useState('pct')   // 'pct' | 'animales' (piscina→piscina)
  const [yaTransferido, setYaTransferido] = useState(0)   // animales ya transferidos antes (este ciclo)

  // Las libras nunca bloquean el registro. El bodeguero no las sabe el
  // dia de la cosecha, llegan despues de la empacadora. Exigirlas hace
  // que invente un numero, y un numero inventado es peor que un vacio.
  const pideLibras = tipo === 'raleo' || tipo === 'cosecha'

  // Origen precria: se pasa el NUMERO real de animales a cada piscina y se
  // transfiere TODO (queda limpia). Piscina->piscina: por % o por animales,
  // puede quedar remanente en el origen (ya no obliga al 100%).
  const esPrecria = objetivo?.tipo === 'precria'
  const larvasSembradas = num(objetivo?.larva) || 0
  // Población disponible del origen = lo que tiene menos lo ya transferido antes.
  const poblacion = Math.max(0, larvasSembradas - (Number(yaTransferido) || 0))

  // Al abrir una transferencia piscina->piscina, cuánto ya se transfirió de
  // este ciclo (para no repartir más de lo que queda).
  useEffect(() => {
    if (tipo !== 'transferencia' || esPrecria) return
    const cid = idCiclo(ciclo)
    if (!cid) return
    let vivo = true
    ;(async () => {
      const { data } = await supabase.schema('produccion').from('evento_destino')
        .select('cantidad, evento:evento_id!inner(ciclo_id, tipo)')
        .eq('evento.ciclo_id', cid).eq('evento.tipo', 'transferencia')
      if (!vivo) return
      setYaTransferido((data || []).reduce((t, x) => t + (Number(x.cantidad) || 0), 0))
    })()
    return () => { vivo = false }
  }, [tipo, esPrecria, ciclo])

  // Totales (ambos campos se mantienen en sync en setPct/setCant).
  const sumaPct = destinos.reduce((t, d) => t + (num(d.porcentaje) || 0), 0)
  const totalCant = destinos.reduce((t, d) => t + (num(d.cantidad) || 0), 0)
  const remanente = Math.max(0, poblacion - totalCant)
  const remanentePct = Math.max(0, Math.round((100 - sumaPct) * 10) / 10)
  const seExcede = !esPrecria && ((poblacion > 0 && totalCant > poblacion + 0.5) || sumaPct > 100.01)
  const cantOk = destinos.length > 0 && destinos.every(d => num(d.cantidad) > 0)
  // Piscina->piscina válido: al menos un destino con valor, sin excederse.
  const transfOk = esPrecria
    ? cantOk
    : (destinos.length > 0 && !seExcede &&
       destinos.every(d => (repartirPor === 'pct' ? num(d.porcentaje) : num(d.cantidad)) > 0))
  const sobrevivencia = esPrecria && larvasSembradas > 0 ? (totalCant / larvasSembradas) * 100 : null

  function toggleDestino(pid) {
    setDestinos(ds => {
      const existe = ds.some(d => d.piscinaId === pid)
      if (existe) return ds.filter(d => d.piscinaId !== pid)
      // Sin reparto automático: se escribe lo de cada una (ya no obliga al 100%).
      return [...ds, { piscinaId: pid, porcentaje: '', cantidad: '' }]
    })
  }
  // Al escribir un %, se prellena los animales (y al revés), usando la población.
  function setPct(pid, valor) {
    setDestinos(ds => ds.map(d => d.piscinaId === pid
      ? { ...d, porcentaje: valor,
          cantidad: poblacion > 0 ? String(Math.round(poblacion * (num(valor) || 0) / 100)) : d.cantidad }
      : d))
  }
  function setCant(pid, valor) {
    setDestinos(ds => ds.map(d => d.piscinaId === pid
      ? { ...d, cantidad: valor,
          porcentaje: (!esPrecria && poblacion > 0) ? String(Math.round((num(valor) || 0) / poblacion * 1000) / 10) : d.porcentaje }
      : d))
  }

  // Gramaje obligatorio: al sembrar una precría (PLs/gramos) y en toda
  // transferencia (gramaje de transferencia).
  const gramajeOk = numDec(gramaje) > 0
  const listo = fecha && (
    tipo === 'transferencia'
      ? (transfOk && gramajeOk)
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
    // Precria: el % de costo sale del numero real de cada destino, y se cierra
    // (queda limpia). Piscina->piscina: se manda % y animales; el origen se
    // cierra solo si no quedó remanente.
    const dest = esPrecria
      ? destinos.map(d => ({ piscinaId: d.piscinaId, cantidad: num(d.cantidad),
                             porcentaje: totalCant > 0 ? (num(d.cantidad) / totalCant) * 100 : 0 }))
      : destinos.map(d => ({ piscinaId: d.piscinaId, porcentaje: num(d.porcentaje) || 0,
                             cantidad: num(d.cantidad) || null }))
    const cerrarOrigen = esPrecria || remanentePct <= 0.01
    await onGuardar({
      fecha, laboratorioId: lab || null, larva: num(larva), gramaje: numDec(gramaje),
      libras: num(libras), destinos: dest, observacion: obs, cerrarOrigen,
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
                {/* Repartir por % o por animales (el otro se prellena). */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                  {[['pct', '%'], ['animales', 'Animales']].map(([id, txt]) => {
                    const on = repartirPor === id
                    const dis = id === 'animales' && poblacion <= 0
                    return (
                      <button key={id} type="button" disabled={dis}
                        onClick={() => setRepartirPor(id)}
                        style={{ border: 'none', cursor: dis ? 'default' : 'pointer', fontFamily: 'inherit',
                                 fontSize: '13px', fontWeight: 600, padding: '6px 14px', borderRadius: '8px',
                                 background: on ? '#E6F1FB' : '#f2f5f8', color: on ? AZUL : GRIS, opacity: dis ? 0.45 : 1 }}>
                        {txt}
                      </button>
                    )
                  })}
                </div>
                {poblacion > 0
                  ? <div style={{ fontSize: '12px', color: GRIS, marginBottom: '8px' }}>
                      Población actual: <b style={{ color: NAVY, fontWeight: 500 }}>{miles(poblacion)}</b> animales
                      {yaTransferido > 0 && <span> (ya transferido antes: {miles(yaTransferido)})</span>}
                    </div>
                  : <div style={{ fontSize: '12px', color: '#BA7517', marginBottom: '8px' }}>
                      Esta piscina no tiene población registrada; reparte por %.
                    </div>}
                {destinos.map(d => {
                  const nombre = destinosPosibles.find(p => p.id === d.piscinaId)?.nombre || ''
                  return (
                    <div key={d.piscinaId} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '7px' }}>
                      <span style={{ flex: 1, fontSize: '14px' }}>{nombre}</span>
                      {repartirPor === 'pct' ? (
                        <>
                          <input inputMode="decimal" value={d.porcentaje}
                            onChange={e => setPct(d.piscinaId, e.target.value)}
                            style={{ ...entrada, width: '80px', textAlign: 'right' }} />
                          <span style={{ fontSize: '13px', color: GRIS, width: '12px' }}>%</span>
                          <span style={{ fontSize: '12px', color: '#aab8c6', width: '96px', textAlign: 'right' }}>
                            {d.cantidad ? miles(num(d.cantidad)) + ' anim.' : ''}</span>
                        </>
                      ) : (
                        <>
                          <input inputMode="decimal" value={d.cantidad}
                            onChange={e => setCant(d.piscinaId, e.target.value)}
                            style={{ ...entrada, width: '120px', textAlign: 'right' }} />
                          <span style={{ fontSize: '12px', color: '#aab8c6', width: '48px', textAlign: 'right' }}>
                            {d.porcentaje ? num(d.porcentaje) + '%' : ''}</span>
                        </>
                      )}
                    </div>
                  )
                })}
                {/* Lo que se queda en el origen (ya no obliga al 100%). */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px',
                              padding: '8px 11px', borderRadius: '9px',
                              background: seExcede ? '#FDECEA' : '#E1F5EE' }}>
                  <span style={{ flex: 1, fontSize: '13px', fontWeight: 600, color: seExcede ? '#A32D2D' : '#0F6E56' }}>
                    Se queda en {objetivo?.nombre}</span>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: seExcede ? '#A32D2D' : '#0F6E56' }}>
                    {seExcede ? 'Te pasaste'
                      : `${remanentePct}%${poblacion > 0 ? ` · ${miles(remanente)} anim.` : ''}`}</span>
                </div>
                {seExcede && (
                  <div style={{ fontSize: '12px', color: '#A32D2D', marginTop: '6px' }}>
                    {poblacion > 0
                      ? `Repartiste ${miles(totalCant)} y solo hay ${miles(poblacion)}. Ajusta.`
                      : `Sumaste ${sumaPct}%. No puede pasar de 100%.`}
                  </div>
                )}
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

            {!esPrecria && destinos.length > 0 && transfOk && (
              <div style={{ background: '#E1F5EE', border: '1px solid #bfe6d2', borderRadius: '10px',
                            padding: '9px 12px', marginBottom: '12px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                              color: '#0F6E56', marginBottom: '5px' }}>Al registrar</div>
                {destinos.map(d => {
                  const nombre = destinosPosibles.find(p => p.id === d.piscinaId)?.nombre || ''
                  return (
                    <div key={d.piscinaId} style={{ fontSize: '12.5px', color: '#20604f', lineHeight: 1.7 }}>
                      Se transfiere el <b style={{ color: '#0F6E56' }}>{num(d.porcentaje)}%</b> de {objetivo?.nombre} a <b style={{ color: '#0F6E56' }}>{nombre}</b>
                      {d.cantidad ? ` · ${miles(num(d.cantidad))}` : ''}
                    </div>
                  )
                })}
              </div>
            )}
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
