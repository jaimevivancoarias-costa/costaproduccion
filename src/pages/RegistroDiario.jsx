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
const GRIS = '#7d8fa0'

const DIAS = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO']
const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
               'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']

function hoyISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

const aFecha = iso => new Date(iso + 'T12:00:00')
const aISO = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

function esDiaDeMuestreo(iso) {
  const dia = aFecha(iso).getDay()
  return dia === 0 || dia === 3
}

function titulo(iso) {
  const d = aFecha(iso)
  return `${DIAS[d.getDay()]} ${d.getDate()} DE ${MESES[d.getMonth()]}`
}

// Semana de lunes a domingo, como en el Excel.
function semanaDe(iso) {
  const d = aFecha(iso)
  const lunes = new Date(d)
  lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const domingo = new Date(lunes)
  domingo.setDate(lunes.getDate() + 6)
  return { lunes, domingo }
}

const corta = d =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`

function diasCultivo(fechaSiembra, iso) {
  return Math.floor((aFecha(iso) - aFecha(fechaSiembra)) / 86400000) + 1
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

const miles = n => (n === null || n === undefined) ? '' : Math.round(n).toLocaleString('es-EC')

export default function RegistroDiario({ fincaId, fincaNombre, soloLectura = false }) {
  const [fecha, setFecha] = useState(hoyISO())
  const [piscinas, setPiscinas] = useState([])
  const [productos, setProductos] = useState([])
  const [frecuentes, setFrecuentes] = useState([])
  const [filas, setFilas] = useState({})
  const [ayer, setAyer] = useState({})
  const [acumulado, setAcumulado] = useState({})
  const [cerrado, setCerrado] = useState(false)
  const [semanaCerrada, setSemanaCerrada] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const celdas = useRef({})

  const muestreo = esDiaDeMuestreo(fecha)
  const bloqueado = soloLectura || semanaCerrada || cerrado
  const { lunes, domingo } = semanaDe(fecha)

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
          hectareas: Number(c.piscina.hectareas),
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
      if (ids.length === 0) { setFilas({}); setAyer({}); setAcumulado({}); return }

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

      // Todo lo comido por estos ciclos hasta hoy: sirve para el acumulado
      // y para saber que productos usa mas esta finca.
      const { data: historia } = await supabase
        .schema('produccion')
        .from('alimentacion')
        .select('ciclo_id, libras, producto_id, fecha')
        .in('ciclo_id', lista.map(p => p.cicloId))
        .lte('fecha', fecha)

      const acum = {}
      ;(historia || []).forEach(r => { acum[r.ciclo_id] = (acum[r.ciclo_id] || 0) + Number(r.libras) })
      setAcumulado(acum)

      const corte = aISO(new Date(aFecha(fecha).getTime() - 7 * 86400000))
      const cuenta = {}
      ;(historia || []).filter(r => r.fecha >= corte).forEach(r => {
        cuenta[r.producto_id] = (cuenta[r.producto_id] || 0) + 1
      })
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
    () => Object.values(filas).reduce((s, f) => s + (num(f.libras) || 0), 0), [filas])
  const totalHectareas = useMemo(
    () => piscinas.reduce((s, p) => s + p.hectareas, 0), [piscinas])
  const totalAcumulado = useMemo(
    () => piscinas.reduce((s, p) => s + (acumulado[p.cicloId] || 0), 0), [piscinas, acumulado])
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

  const COLS = muestreo
    ? '154px 94px 54px minmax(0,1fr) 104px 104px 84px'
    : '154px 94px 54px minmax(0,1fr) 104px 104px'

  const inputBase = {
    width: '100%', textAlign: 'right', padding: '8px 10px', fontSize: '15px',
    border: '0.5px solid ' + BORDE, borderRadius: '8px', outline: 'none',
    fontFamily: 'inherit', background: 'white', boxSizing: 'border-box',
  }
  const etiqueta = { fontSize: '10px', letterSpacing: '0.07em', color: GRIS, textTransform: 'uppercase' }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.5rem 1.25rem 3rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '1.25rem' }}>
        <div>
          <div style={{ fontSize: '11px', letterSpacing: '0.12em', color: AZUL, marginBottom: '4px' }}>
            {String(fincaNombre).toUpperCase()}
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>{titulo(fecha)}</h1>
          <div style={{ fontSize: '12px', color: GRIS, letterSpacing: '0.05em' }}>
            SEMANA DEL {corta(lunes)} AL {corta(domingo)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {muestreo && (
            <span style={{ fontSize: '11px', fontWeight: 500, letterSpacing: '0.07em', color: '#534AB7', background: '#EEEDFE', padding: '6px 12px', borderRadius: '20px' }}>
              DIA DE MUESTREO
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
          padding: '10px 14px', borderRadius: '8px', marginBottom: '1rem', fontSize: '13px', letterSpacing: '0.03em',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11',
        }}>{aviso.texto}</div>
      )}

      {semanaCerrada && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '1rem', fontSize: '13px', letterSpacing: '0.03em', background: '#FAEEDA', color: '#854F0B' }}>
          ESTA SEMANA YA ESTA CERRADA. PARA CORREGIR ALGO, PIDE A TU JEFE QUE LA ABRA.
        </div>
      )}

      {cargando ? (
        <div style={{ padding: '3rem 0', textAlign: 'center', color: GRIS, fontSize: '14px', letterSpacing: '0.05em' }}>CARGANDO PISCINAS...</div>
      ) : piscinas.length === 0 ? (
        <div style={{ padding: '3rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE, borderRadius: '12px' }}>
          <div style={{ fontSize: '15px', marginBottom: '6px', letterSpacing: '0.05em' }}>NO HAY PISCINAS SEMBRADAS</div>
          <div style={{ fontSize: '13px', color: GRIS }}>CUANDO SIEMBRES UNA PISCINA VA A APARECER AQUI.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: '10px', padding: '0 12px 8px' }}>
            <div style={etiqueta}>Piscina</div>
            <div style={etiqueta}>Siembra</div>
            <div style={{ ...etiqueta, textAlign: 'right' }}>Dias</div>
            <div style={etiqueta}>Balanceado</div>
            <div style={{ ...etiqueta, textAlign: 'right' }}>Libras</div>
            <div style={{ ...etiqueta, textAlign: 'right' }}>Acumulado</div>
            {muestreo && <div style={{ ...etiqueta, textAlign: 'right' }}>Gramos</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {piscinas.map((p, i) => {
              const f = filas[p.piscinaId] || {}
              const alerta = fueraDeRango(p)
              const acum = acumulado[p.cicloId] || 0
              return (
                <div key={p.piscinaId}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: COLS, gap: '10px', alignItems: 'center',
                    background: bloqueado ? '#f7fafc' : 'white',
                    border: '0.5px solid ' + (alerta ? '#EF9F27' : BORDE),
                    borderRadius: '10px', padding: '10px 12px',
                  }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 500, letterSpacing: '0.02em' }}>
                        {String(p.nombre).toUpperCase()}
                        {p.tipo === 'precria' && (
                          <span style={{ fontSize: '9px', marginLeft: '6px', color: AZUL, background: '#E6F1FB', padding: '2px 6px', borderRadius: '10px' }}>PRECRIA</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: GRIS }}>{p.hectareas.toFixed(2)} HA</div>
                    </div>

                    <div style={{ fontSize: '13px', color: GRIS }}>{corta(aFecha(p.fechaSiembra))}</div>

                    <div style={{ fontSize: '14px', fontWeight: 500, textAlign: 'right' }}>
                      {diasCultivo(p.fechaSiembra, fecha)}
                    </div>

                    <select
                      value={f.productoId || ''}
                      disabled={bloqueado}
                      ref={el => { celdas.current[`${i}-prod`] = el }}
                      onKeyDown={e => alTeclear(e, i, 'prod')}
                      onChange={e => set(p.piscinaId, 'productoId', e.target.value)}
                      style={{ padding: '8px 10px', fontSize: '13px', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: 'white', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
                    >
                      <option value="">ELEGIR BALANCEADO</option>
                      {frecuentes.length > 0 && (
                        <optgroup label="LOS QUE MAS USAS">
                          {frecuentes.map(id => {
                            const pr = productos.find(x => x.id === id)
                            return pr ? <option key={'f' + id} value={id}>{pr.nombre.toUpperCase()}</option> : null
                          })}
                        </optgroup>
                      )}
                      <optgroup label="TODOS">
                        {productos.map(pr => <option key={pr.id} value={pr.id}>{pr.nombre.toUpperCase()}</option>)}
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

                    <div style={{ fontSize: '14px', textAlign: 'right', color: GRIS }}>{miles(acum)}</div>

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
                    <div style={{ margin: '4px 0 2px', padding: '8px 14px', background: '#FAEEDA', color: '#854F0B', borderRadius: '8px', fontSize: '12px', letterSpacing: '0.03em' }}>
                      {alerta}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: '10px', alignItems: 'center', marginTop: '10px', paddingTop: '14px', paddingLeft: '12px', paddingRight: '12px', borderTop: '0.5px solid ' + BORDE }}>
            <div style={{ fontSize: '12px', fontWeight: 500, letterSpacing: '0.07em' }}>TOTAL</div>
            <div style={{ fontSize: '11px', color: GRIS }}>{piscinas.length} PISCINAS</div>
            <div />
            <div style={{ fontSize: '11px', color: GRIS }}>{totalHectareas.toFixed(2)} HA SEMBRADAS</div>
            <div style={{ fontSize: '17px', fontWeight: 500, textAlign: 'right' }}>{miles(totalLibras)}</div>
            <div style={{ fontSize: '14px', textAlign: 'right', color: GRIS }}>{miles(totalAcumulado)}</div>
            {muestreo && <div />}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px', padding: '16px 12px 0' }}>
            <div style={{ display: 'flex', gap: '30px' }}>
              <Dato titulo="Sacos del dia" valor={(totalLibras / LIBRAS_POR_SACO).toFixed(1)} />
              <Dato titulo="Libras por hectarea" valor={totalHectareas ? (totalLibras / totalHectareas).toFixed(1) : '0'} />
              {!bloqueado && pendientes > 0 && (
                <Dato titulo="Falta llenar" valor={pendientes + (pendientes === 1 ? ' PISCINA' : ' PISCINAS')} color="#BA7517" />
              )}
            </div>

            {!soloLectura && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {cerrado ? (
                  <>
                    <span style={{ fontSize: '12px', color: GRIS, letterSpacing: '0.05em' }}>DIA GUARDADO</span>
                    <button
                      onClick={reabrir}
                      disabled={semanaCerrada}
                      style={{
                        padding: '10px 18px', fontSize: '13px', fontFamily: 'inherit', letterSpacing: '0.05em',
                        background: 'white', color: NAVY, border: '0.5px solid ' + BORDE,
                        borderRadius: '8px', cursor: semanaCerrada ? 'default' : 'pointer',
                        opacity: semanaCerrada ? 0.5 : 1,
                      }}
                    >EDITAR</button>
                  </>
                ) : (
                  <button
                    onClick={guardar}
                    disabled={guardando}
                    style={{
                      padding: '10px 26px', fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', letterSpacing: '0.07em',
                      background: AZUL, color: 'white', border: 'none', borderRadius: '8px',
                      cursor: guardando ? 'default' : 'pointer', opacity: guardando ? 0.6 : 1,
                    }}
                  >{guardando ? 'GUARDANDO...' : 'GUARDAR EL DIA'}</button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Dato({ titulo, valor, color }) {
  return (
    <div>
      <div style={{ fontSize: '10px', letterSpacing: '0.07em', color: GRIS, textTransform: 'uppercase' }}>{titulo}</div>
      <div style={{ fontSize: '18px', fontWeight: 500, color: color || NAVY }}>{valor}</div>
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
