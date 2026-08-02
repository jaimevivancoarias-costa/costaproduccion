import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'

// Registro diario de balanceado - modulo Produccion
//
// Regla del negocio: el bodeguero llena todos los dias, una fila por
// piscina con ciclo abierto. Guardar cierra el dia; puede reabrirlo el
// mismo dia sin pedir permiso. Una vez cerrada la semana, solo el jefe.
//
// Los muestreos de gramaje se piden solo miercoles y domingo.

const LIBRAS_POR_SACO = 55

const AZUL = '#0D6CB0'
const NAVY = '#022847'
const BORDE = '#d4e0eb'

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

function hoyISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function esDiaDeMuestreo(iso) {
  const dia = new Date(iso + 'T12:00:00').getDay()
  return dia === 0 || dia === 3
}

function titulo(iso) {
  const d = new Date(iso + 'T12:00:00')
  return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`
}

function diasCultivo(fechaSiembra, iso) {
  const a = new Date(fechaSiembra + 'T12:00:00')
  const b = new Date(iso + 'T12:00:00')
  return Math.floor((b - a) / 86400000) + 1
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function miles(n) {
  return n === null || n === undefined ? '' : n.toLocaleString('es-EC')
}

export default function RegistroDiario({ fincaId, fincaNombre, soloLectura = false }) {
  const [fecha, setFecha] = useState(hoyISO())
  const [piscinas, setPiscinas] = useState([])
  const [productos, setProductos] = useState([])
  const [frecuentes, setFrecuentes] = useState([])
  const [filas, setFilas] = useState({})
  const [ayer, setAyer] = useState({})
  const [cerrado, setCerrado] = useState(false)
  const [semanaCerrada, setSemanaCerrada] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const celdas = useRef({})

  const muestreo = esDiaDeMuestreo(fecha)
  const bloqueado = soloLectura || semanaCerrada || cerrado

  useEffect(() => { cargar() }, [fincaId, fecha])

  async function cargar() {
    setCargando(true)
    setAviso(null)
    try {
      // Piscinas con ciclo abierto a la fecha. Una piscina vacia no se muestra.
      const { data: ciclos, error: e1 } = await supabase
        .schema('produccion')
        .from('ciclo')
        .select('id, fecha_siembra, piscina_origen_id, piscina:piscina_origen_id (id, codigo, nombre, hectareas, tipo)')
        .eq('finca_id', fincaId)
        .eq('estado', 'abierto')
        .lte('fecha_siembra', fecha)
      if (e1) throw e1

      const lista = (ciclos || [])
        .filter(c => c.piscina)
        .map(c => ({
          cicloId: c.id,
          piscinaId: c.piscina.id,
          codigo: c.piscina.codigo,
          nombre: c.piscina.nombre,
          hectareas: c.piscina.hectareas,
          tipo: c.piscina.tipo,
          fechaSiembra: c.fecha_siembra,
        }))
        .sort(ordenarPiscinas)
      setPiscinas(lista)

      const { data: prods } = await supabase
        .schema('produccion')
        .from('producto')
        .select('id, nombre')
        .eq('activo', true)
        .order('nombre')
      setProductos(prods || [])

      const ids = lista.map(p => p.piscinaId)
      if (ids.length === 0) { setFilas({}); setAyer({}); return }

      const { data: hoyData } = await supabase
        .schema('produccion')
        .from('alimentacion')
        .select('id, piscina_id, producto_id, libras')
        .in('piscina_id', ids)
        .eq('fecha', fecha)

      const { data: muestras } = await supabase
        .schema('produccion')
        .from('muestreo')
        .select('id, piscina_id, peso_gramos')
        .in('piscina_id', ids)
        .eq('fecha', fecha)

      const previo = new Date(fecha + 'T12:00:00')
      previo.setDate(previo.getDate() - 1)
      const isoAyer = previo.toISOString().slice(0, 10)
      const { data: ayerData } = await supabase
        .schema('produccion')
        .from('alimentacion')
        .select('piscina_id, libras, producto_id')
        .in('piscina_id', ids)
        .eq('fecha', isoAyer)

      // Los productos que esta finca uso la ultima semana van primero.
      const desde = new Date(fecha + 'T12:00:00')
      desde.setDate(desde.getDate() - 7)
      const { data: recientes } = await supabase
        .schema('produccion')
        .from('alimentacion')
        .select('producto_id')
        .in('piscina_id', ids)
        .gte('fecha', desde.toISOString().slice(0, 10))
        .lt('fecha', fecha)

      const cuenta = {}
      ;(recientes || []).forEach(r => { cuenta[r.producto_id] = (cuenta[r.producto_id] || 0) + 1 })
      setFrecuentes(Object.entries(cuenta).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id))

      const mapaAyer = {}
      ;(ayerData || []).forEach(a => { mapaAyer[a.piscina_id] = a })
      setAyer(mapaAyer)

      const mapa = {}
      lista.forEach(p => {
        const a = (hoyData || []).find(x => x.piscina_id === p.piscinaId)
        const m = (muestras || []).find(x => x.piscina_id === p.piscinaId)
        mapa[p.piscinaId] = {
          alimentacionId: a?.id ?? null,
          productoId: a?.producto_id ?? mapaAyer[p.piscinaId]?.producto_id ?? '',
          libras: a ? String(a.libras) : '',
          muestreoId: m?.id ?? null,
          gramos: m ? String(m.peso_gramos) : '',
        }
      })
      setFilas(mapa)

      const { data: dc } = await supabase
        .schema('produccion')
        .from('dia_cerrado')
        .select('id')
        .eq('finca_id', fincaId)
        .eq('fecha', fecha)
        .maybeSingle()
      setCerrado(!!dc)

      const d = new Date(fecha + 'T12:00:00')
      const { data: sc } = await supabase
        .schema('produccion')
        .from('semana_cerrada')
        .select('id')
        .eq('finca_id', fincaId)
        .eq('anio', d.getFullYear())
        .eq('semana', semanaISO(d))
        .maybeSingle()
      setSemanaCerrada(!!sc)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudieron cargar las piscinas. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }

  function set(piscinaId, campo, valor) {
    setFilas(f => ({ ...f, [piscinaId]: { ...f[piscinaId], [campo]: valor } }))
  }

  const totalLibras = useMemo(
    () => Object.values(filas).reduce((s, f) => s + (num(f.libras) || 0), 0),
    [filas]
  )
  const totalSacos = totalLibras / LIBRAS_POR_SACO

  const pendientes = piscinas.filter(p => !num(filas[p.piscinaId]?.libras)).length

  // Aviso, no bloqueo: una carga muy distinta a la de ayer casi siempre
  // es un cero de mas.
  function fueraDeRango(p) {
    const hoy = num(filas[p.piscinaId]?.libras)
    const prev = ayer[p.piscinaId]?.libras
    if (!hoy || !prev || prev <= 0) return null
    const razon = hoy / prev
    if (razon >= 3 || razon <= 0.34) {
      return `Ayer fueron ${miles(Number(prev))} lb. Hoy van ${miles(hoy)}. Confirma que este bien.`
    }
    return null
  }

  async function guardar() {
    setGuardando(true)
    setAviso(null)
    try {
      const alimentacion = []
      const muestreos = []
      for (const p of piscinas) {
        const f = filas[p.piscinaId]
        const lb = num(f?.libras)
        if (lb !== null && f.productoId) {
          alimentacion.push({
            ...(f.alimentacionId ? { id: f.alimentacionId } : {}),
            ciclo_id: p.cicloId,
            piscina_id: p.piscinaId,
            fecha,
            producto_id: f.productoId,
            libras: lb,
          })
        }
        const gr = num(f?.gramos)
        if (muestreo && gr !== null) {
          muestreos.push({
            ...(f.muestreoId ? { id: f.muestreoId } : {}),
            ciclo_id: p.cicloId,
            piscina_id: p.piscinaId,
            fecha,
            peso_gramos: gr,
          })
        }
      }

      if (alimentacion.length) {
        const { error } = await supabase
          .schema('produccion')
          .from('alimentacion')
          .upsert(alimentacion, { onConflict: 'piscina_id,fecha' })
        if (error) throw error
      }
      if (muestreos.length) {
        const { error } = await supabase
          .schema('produccion')
          .from('muestreo')
          .upsert(muestreos, { onConflict: 'piscina_id,fecha' })
        if (error) throw error
      }

      const { error: e3 } = await supabase
        .schema('produccion')
        .from('dia_cerrado')
        .upsert({ finca_id: fincaId, fecha }, { onConflict: 'finca_id,fecha' })
      if (e3) throw e3

      setCerrado(true)
      setAviso({ tipo: 'ok', texto: 'Dia guardado' })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    } finally {
      setGuardando(false)
    }
  }

  async function reabrir() {
    if (semanaCerrada) {
      setAviso({ tipo: 'error', texto: 'La semana ya esta cerrada. Pide a tu jefe que la abra.' })
      return
    }
    const { error } = await supabase
      .schema('produccion')
      .from('dia_cerrado')
      .delete()
      .eq('finca_id', fincaId)
      .eq('fecha', fecha)
    if (error) {
      setAviso({ tipo: 'error', texto: 'No se pudo abrir el dia. ' + error.message })
      return
    }
    setCerrado(false)
    setAviso(null)
  }

  // Enter baja a la misma columna de la fila siguiente, como en Excel.
  function alTeclear(e, indice, columna) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const siguiente = celdas.current[`${indice + 1}-${columna}`]
    if (siguiente) siguiente.focus()
  }

  const inputBase = {
    width: '100%', textAlign: 'right', padding: '8px 10px', fontSize: '15px',
    border: '0.5px solid ' + BORDE, borderRadius: '8px', outline: 'none',
    fontFamily: 'inherit', background: 'white',
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, maxWidth: '1100px', margin: '0 auto', padding: '1.5rem 1rem 3rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '1.25rem' }}>
        <div>
          <div style={{ fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: AZUL, marginBottom: '4px' }}>
            {fincaNombre}
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: 0, textTransform: 'capitalize' }}>{titulo(fecha)}</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {muestreo && (
            <span style={{ fontSize: '12px', fontWeight: 500, color: '#534AB7', background: '#EEEDFE', padding: '6px 12px', borderRadius: '20px' }}>
              Dia de muestreo
            </span>
          )}
          <input
            type="date"
            value={fecha}
            max={hoyISO()}
            onChange={e => setFecha(e.target.value)}
            style={{ padding: '7px 10px', fontSize: '14px', border: '0.5px solid ' + BORDE, borderRadius: '8px', fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {aviso && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '1rem', fontSize: '14px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11',
        }}>{aviso.texto}</div>
      )}

      {semanaCerrada && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '1rem', fontSize: '14px', background: '#FAEEDA', color: '#854F0B' }}>
          Esta semana ya esta cerrada. Para corregir algo, pide a tu jefe que la abra.
        </div>
      )}

      {cargando ? (
        <div style={{ padding: '3rem 0', textAlign: 'center', color: '#7d8fa0', fontSize: '15px' }}>Cargando piscinas...</div>
      ) : piscinas.length === 0 ? (
        <div style={{ padding: '3rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE, borderRadius: '12px' }}>
          <div style={{ fontSize: '16px', marginBottom: '6px' }}>No hay piscinas sembradas</div>
          <div style={{ fontSize: '14px', color: '#7d8fa0' }}>
            Cuando siembres una piscina va a aparecer aqui para que registres su comida.
          </div>
        </div>
      ) : (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: muestreo ? '150px 1fr 130px 110px' : '150px 1fr 130px',
            gap: '10px', padding: '0 12px 8px', fontSize: '12px', color: '#7d8fa0',
          }}>
            <div>Piscina</div>
            <div>Balanceado</div>
            <div style={{ textAlign: 'right' }}>Libras</div>
            {muestreo && <div style={{ textAlign: 'right' }}>Gramos</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {piscinas.map((p, i) => {
              const f = filas[p.piscinaId] || {}
              const alerta = fueraDeRango(p)
              return (
                <div key={p.piscinaId}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: muestreo ? '150px 1fr 130px 110px' : '150px 1fr 130px',
                    gap: '10px', alignItems: 'center',
                    background: bloqueado ? '#f7fafc' : 'white',
                    border: '0.5px solid ' + (alerta ? '#EF9F27' : BORDE),
                    borderRadius: '10px', padding: '10px 12px',
                  }}>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 500 }}>
                        {p.nombre}
                        {p.tipo === 'precria' && (
                          <span style={{ fontSize: '10px', marginLeft: '6px', color: AZUL, background: '#E6F1FB', padding: '2px 6px', borderRadius: '10px' }}>precria</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#7d8fa0' }}>
                        {p.hectareas} ha · dia {diasCultivo(p.fechaSiembra, fecha)}
                      </div>
                    </div>

                    <select
                      value={f.productoId || ''}
                      disabled={bloqueado}
                      ref={el => { celdas.current[`${i}-prod`] = el }}
                      onKeyDown={e => alTeclear(e, i, 'prod')}
                      onChange={e => set(p.piscinaId, 'productoId', e.target.value)}
                      style={{ padding: '8px 10px', fontSize: '14px', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: 'white', fontFamily: 'inherit', maxWidth: '340px' }}
                    >
                      <option value="">Elegir balanceado</option>
                      {frecuentes.length > 0 && (
                        <optgroup label="Los que mas usas">
                          {frecuentes.map(id => {
                            const pr = productos.find(x => x.id === id)
                            return pr ? <option key={'f' + id} value={id}>{pr.nombre}</option> : null
                          })}
                        </optgroup>
                      )}
                      <optgroup label="Todos">
                        {productos.map(pr => <option key={pr.id} value={pr.id}>{pr.nombre}</option>)}
                      </optgroup>
                    </select>

                    <input
                      inputMode="numeric"
                      value={f.libras || ''}
                      disabled={bloqueado}
                      placeholder="0"
                      ref={el => { celdas.current[`${i}-lb`] = el }}
                      onKeyDown={e => alTeclear(e, i, 'lb')}
                      onChange={e => set(p.piscinaId, 'libras', e.target.value)}
                      style={inputBase}
                    />

                    {muestreo && (
                      <input
                        inputMode="decimal"
                        value={f.gramos || ''}
                        disabled={bloqueado}
                        placeholder="-"
                        ref={el => { celdas.current[`${i}-gr`] = el }}
                        onKeyDown={e => alTeclear(e, i, 'gr')}
                        onChange={e => set(p.piscinaId, 'gramos', e.target.value)}
                        style={inputBase}
                      />
                    )}
                  </div>

                  {alerta && (
                    <div style={{ margin: '4px 0 2px', padding: '8px 14px', background: '#FAEEDA', color: '#854F0B', borderRadius: '8px', fontSize: '13px' }}>
                      {alerta}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: '16px',
            borderTop: '0.5px solid ' + BORDE, marginTop: '16px', paddingTop: '16px',
          }}>
            <div style={{ display: 'flex', gap: '28px' }}>
              <div>
                <div style={{ fontSize: '12px', color: '#7d8fa0' }}>Total del dia</div>
                <div style={{ fontSize: '20px', fontWeight: 500 }}>{miles(totalLibras)} lb</div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: '#7d8fa0' }}>Sacos</div>
                <div style={{ fontSize: '20px', fontWeight: 500 }}>{totalSacos.toFixed(1)}</div>
              </div>
              {!bloqueado && pendientes > 0 && (
                <div>
                  <div style={{ fontSize: '12px', color: '#7d8fa0' }}>Falta llenar</div>
                  <div style={{ fontSize: '20px', fontWeight: 500, color: '#BA7517' }}>
                    {pendientes} {pendientes === 1 ? 'piscina' : 'piscinas'}
                  </div>
                </div>
              )}
            </div>

            {!soloLectura && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {cerrado ? (
                  <>
                    <span style={{ fontSize: '13px', color: '#7d8fa0' }}>Dia guardado</span>
                    <button
                      onClick={reabrir}
                      disabled={semanaCerrada}
                      style={{
                        padding: '10px 18px', fontSize: '14px', fontFamily: 'inherit',
                        background: 'white', color: NAVY, border: '0.5px solid ' + BORDE,
                        borderRadius: '8px', cursor: semanaCerrada ? 'default' : 'pointer',
                        opacity: semanaCerrada ? 0.5 : 1,
                      }}
                    >Editar</button>
                  </>
                ) : (
                  <button
                    onClick={guardar}
                    disabled={guardando}
                    style={{
                      padding: '10px 24px', fontSize: '14px', fontWeight: 500, fontFamily: 'inherit',
                      background: AZUL, color: 'white', border: 'none', borderRadius: '8px',
                      cursor: guardando ? 'default' : 'pointer', opacity: guardando ? 0.6 : 1,
                    }}
                  >{guardando ? 'Guardando...' : 'Guardar el dia'}</button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// P1, P2, P10 en orden natural; las precrias al final.
function ordenarPiscinas(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  const na = parseInt(a.codigo.replace(/\D/g, ''), 10) || 0
  const nb = parseInt(b.codigo.replace(/\D/g, ''), 10) || 0
  return na - nb
}

function semanaISO(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dia = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dia)
  const inicio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t - inicio) / 86400000 + 1) / 7)
}
