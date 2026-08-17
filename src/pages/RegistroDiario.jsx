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

export default function RegistroDiario({ finca, esJefe, soloLectura }) {
  const [lunes, setLunes] = useState(() => lunesDe(hoyISO()))
  const [piscinas, setPiscinas] = useState([])
  const [productos, setProductos] = useState([])
  const [celdas, setCeldas] = useState({})       // clave `${piscinaId}|${fecha}`
  const [dias, setDias] = useState({})           // estado por fecha
  const [semanaCerrada, setSemanaCerrada] = useState(false)
  const [modo, setModo] = useState('registrar')
  const [soloPendientes, setSoloPendientes] = useState(false)
  const [sucio, setSucio] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [validaciones, setValidaciones] = useState(null)
  const [eventos, setEventos] = useState({})     // clave piscinaId -> evento de la semana
  const [laboratorios, setLaboratorios] = useState([])
  const [dialogo, setDialogo] = useState(null)   // { tipo, fila }
  const refs = useRef({})

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const semanaDeHoy = lunesDe(hoy) === lunes

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]

      // Todas las piscinas de la finca, tengan o no ciclo. En el Excel
      // aparecen todas cada semana; una piscina vacia hay que poder verla
      // para poder sembrarla.
      const { data: todas, error } = await supabase
        .schema('produccion').from('piscina')
        .select('id, codigo, nombre, hectareas, tipo')
        .eq('finca_id', finca.id).eq('activa', true)
      if (error) throw error

      const { data: ciclos } = await supabase
        .schema('produccion').from('ciclo')
        .select('id, fecha_siembra, cantidad_larva, piscina_origen_id, laboratorio:laboratorio_id (nombre)')
        .eq('finca_id', finca.id).eq('estado', 'abierto').lte('fecha_siembra', domingo)

      const porPiscina = {}
      ;(ciclos || []).forEach(c => { porPiscina[c.piscina_origen_id] = c })

      const lista = (todas || []).map(p => {
        const c = porPiscina[p.id]
        return {
          cicloId: c?.id || null, piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
          hectareas: Number(p.hectareas), tipo: p.tipo,
          fechaSiembra: c?.fecha_siembra || null, larva: c?.cantidad_larva || null,
          laboratorio: c?.laboratorio?.nombre || null,
        }
      }).sort(ordenar)
      setPiscinas(lista)

      const { data: labs } = await supabase
        .schema('produccion').from('laboratorio')
        .select('id, nombre').eq('activo', true).order('nombre')
      setLaboratorios(labs || [])

      const { data: prods } = await supabase
        .schema('produccion').from('producto')
        .select('id, nombre, nombre_corto').eq('activo', true).order('nombre_corto')
      setProductos(prods || [])

      const ids = lista.map(p => p.piscinaId)

      // Eventos ocurridos en esta semana, para mostrarlos en la columna
      // de estado igual que la columna ESTADO PISCINA del Excel.
      const evs = {}
      if (ids.length) {
        const { data: e } = await supabase
          .schema('produccion').from('evento')
          .select('id, tipo, fecha, libras, piscina_origen_id')
          .in('piscina_origen_id', ids).gte('fecha', lunes).lte('fecha', domingo)
        ;(e || []).forEach(x => { evs[x.piscina_origen_id] = x })
      }
      setEventos(evs)

      const mapa = {}
      if (ids.length) {
        const { data: alim } = await supabase
          .schema('produccion').from('alimentacion')
          .select('id, piscina_id, fecha, producto_id, libras, sin_alimentacion')
          .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
        ;(alim || []).forEach(a => {
          mapa[`${a.piscina_id}|${a.fecha}`] = {
            id: a.id,
            productoId: a.producto_id || '',
            libras: a.sin_alimentacion ? '' : String(a.libras),
            sinAlimentacion: a.sin_alimentacion,
          }
        })
      }
      setCeldas(mapa)

      const { data: dr } = await supabase
        .schema('produccion').from('dia_registro')
        .select('fecha, estado').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo)
      const md = {}
      ;(dr || []).forEach(d => { md[d.fecha] = d.estado })
      setDias(md)

      const { anio, semana } = semanaISO(lunes)
      const { data: sc } = await supabase
        .schema('produccion').from('semana_cerrada')
        .select('id').eq('finca_id', finca.id).eq('anio', anio).eq('semana', semana).maybeSingle()
      setSemanaCerrada(!!sc)

      setSucio(false)
      setValidaciones(null)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
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
    return fecha === hoy
  }

  async function registrarEvento(datos) {
    try {
      await guardarEvento({
        tipo: dialogo.tipo, fincaId: finca.id,
        ciclo: dialogo.fila, piscina: dialogo.fila, datos,
      })
      setDialogo(null)
      setAviso({ tipo: 'ok', texto: TIPOS[dialogo.tipo].nombre + ' registrada' })
      await cargar()
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
          if (c.sinAlimentacion) {
            filas.push({ ...(c.id ? { id: c.id } : {}), ciclo_id: p.cicloId, piscina_id: p.piscinaId,
                         fecha: f, producto_id: null, libras: 0, sin_alimentacion: true })
          } else {
            const lb = num(c.libras)
            if (lb === null || lb === 0) { if (c.id) borrar.push(c.id); continue }
            if (!c.productoId) continue
            filas.push({ ...(c.id ? { id: c.id } : {}), ciclo_id: p.cicloId, piscina_id: p.piscinaId,
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

      const estado = cerrarDia ? 'cerrado' : 'borrador'
      const { error: e2 } = await supabase.schema('produccion').from('dia_registro')
        .upsert({ finca_id: finca.id, fecha: hoy, estado,
                  ...(cerrarDia ? { cerrado_en: new Date().toISOString() } : {}) },
                { onConflict: 'finca_id,fecha' })
      if (e2) throw e2

      setAviso({ tipo: 'ok', texto: cerrarDia ? 'Día cerrado' : 'Borrador guardado' })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
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
    await cargar()
  }

  function alTeclear(e, iFila, iDia) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    refs.current[`${iFila + 1}|${iDia}`]?.focus()
  }

  const visibles = soloPendientes
    ? piscinas.filter(p => pendientesHoy.includes(p) || atrasadas.some(a => a.p === p))
    : piscinas

  const COLS = `170px 96px 56px 124px 136px repeat(7, minmax(112px, 1fr)) 104px`

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
          <div style={{ display: 'flex', gap: '6px' }}>
            <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
            <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
            <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
          </div>
        </div>
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

      {modo === 'registrar' && !soloLectura && !semanaCerrada && semanaDeHoy && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                      background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '11px 14px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13px', color: GRIS }}>
            <span>
              <b style={{ fontWeight: 500, color: NAVY }}>
                {piscinas.filter(p => p.tipo !== 'precria').length - pendientesHoy.length} de {piscinas.filter(p => p.tipo !== 'precria').length}
              </b> piscinas completadas hoy
            </span>
            <span style={{ width: '90px', height: '6px', background: '#e7eef5', borderRadius: '20px', overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', background: '#1D9E75',
                width: (piscinas.length ? ((piscinas.filter(p => p.tipo !== 'precria').length - pendientesHoy.length) / Math.max(1, piscinas.filter(p => p.tipo !== 'precria').length)) * 100 : 0) + '%' }} />
            </span>
          </div>
          <Sep />
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={soloPendientes} onChange={e => setSoloPendientes(e.target.checked)} />
            Solo pendientes
          </label>
          <Sep />
          <Btn fantasma onClick={() => copiarDiaAnterior(hoy)}>Copiar día anterior</Btn>
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: sucio ? '#BA7517' : GRIS }}>
            {sucio ? 'Hay cambios sin guardar' : 'Sin cambios sin guardar'}
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
              <div style={{ minWidth: '1080px' }}>

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
                    <Td><span style={{ color: GRIS, fontSize: '12px' }}>
                      {p.laboratorio || (p.cicloId ? '—' : '')}
                    </span></Td>
                    <Td>
                      <Estado
                        fila={p} evento={eventos[p.piscinaId]}
                        puede={!soloLectura && modo === 'registrar'}
                        onElegir={tipo => setDialogo({ tipo, fila: p })}
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
              {!soloLectura && modo === 'registrar' && !semanaCerrada && semanaDeHoy && (
                <div style={{ display: 'flex', gap: '9px' }}>
                  <Btn onClick={() => guardar(false)} disabled={guardando}>
                    {guardando ? 'Guardando...' : 'Guardar borrador'}
                  </Btn>
                  <Btn primario onClick={pedirCerrarDia} disabled={guardando}>Cerrar día</Btn>
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
  if (f < p.fechaSiembra) {
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
        style={{ fontFamily: 'inherit', fontSize: '11px', padding: '5px', width: '100%',
                 border: '0.5px solid ' + BORDE, borderRadius: '7px', background: 'white' }}
      >
        <option value=""></option>
        {productos.map(pr => <option key={pr.id} value={pr.id}>{pr.nombre_corto}</option>)}
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
        <button onClick={onSin} style={{ border: 0, background: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: '10px', color: GRIS, padding: '1px' }}>
          sin alimentación
        </button>
      )}
    </div>
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
function Cierre({ validaciones, onRevisar, onCerrar, puedeCerrar, cerrada }) {
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
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
