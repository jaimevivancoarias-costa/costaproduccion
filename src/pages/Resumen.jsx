import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, semanaISO,
  corta, miles, dinero,
} from '../lib/fechas'

// Resumen · las fincas de un vistazo
//
// Es la vista que no existe en ningun Excel: hoy cada finca vive en su
// archivo y nadie ve las nueve juntas. Todo sale de vw_semana_finca,
// que suma los registros diarios.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export default function Resumen({ fincas, lunes, setLunes, onIrAFinca }) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const idsFincas = useMemo(() => fincas.map(f => f.id), [fincas])

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]
      const { anio, semana } = semanaISO(lunes)

      const [sem, pisc, dias, cerradas, ciclos] = await Promise.all([
        supabase.schema('produccion').from('vw_semana_finca')
          .select('finca_id, libras_semana, sacos_semana, costo_semana')
          .eq('lunes', lunes).in('finca_id', idsFincas),
        supabase.schema('produccion').from('piscina')
          .select('id, finca_id, hectareas, tipo').in('finca_id', idsFincas).eq('activa', true),
        supabase.schema('produccion').from('dia_registro')
          .select('finca_id, fecha, estado').in('finca_id', idsFincas)
          .gte('fecha', lunes).lte('fecha', domingo),
        supabase.schema('produccion').from('semana_cerrada')
          .select('finca_id').in('finca_id', idsFincas).eq('anio', anio).eq('semana', semana),
        supabase.schema('produccion').from('ciclo')
          .select('finca_id, piscina_origen_id, fecha_siembra, fecha_cierre')
          .in('finca_id', idsFincas).lte('fecha_siembra', domingo)
          .or(`fecha_cierre.is.null,fecha_cierre.gte.${lunes}`),
      ])

      const porFinca = {}
      ;(sem.data || []).forEach(r => { porFinca[r.finca_id] = r })

      const has = {}, nPisc = {}
      ;(pisc.data || []).forEach(p => {
        has[p.finca_id] = (has[p.finca_id] || 0) + Number(p.hectareas)
        nPisc[p.finca_id] = (nPisc[p.finca_id] || 0) + 1
      })

      const sembradas = {}, hasSembradas = {}
      const areaPiscina = {}
      ;(pisc.data || []).forEach(p => { areaPiscina[p.id] = Number(p.hectareas) })
      ;(ciclos.data || []).forEach(c => {
        sembradas[c.finca_id] = (sembradas[c.finca_id] || 0) + 1
        hasSembradas[c.finca_id] = (hasSembradas[c.finca_id] || 0) + (areaPiscina[c.piscina_origen_id] || 0)
      })

      const cerrados = {}
      ;(dias.data || []).forEach(d => {
        if (d.estado === 'cerrado' || d.estado === 'reabierto') {
          cerrados[d.finca_id] = (cerrados[d.finca_id] || 0) + 1
        }
      })

      const semCerrada = new Set((cerradas.data || []).map(r => r.finca_id))

      setFilas(fincas.map(f => {
        const r = porFinca[f.id] || {}
        const libras = Number(r.libras_semana || 0)
        return {
          id: f.id, nombre: f.nombre,
          piscinas: nPisc[f.id] || 0,
          sembradas: sembradas[f.id] || 0,
          hectareas: has[f.id] || 0,
          hectareasSembradas: hasSembradas[f.id] || 0,
          libras,
          sacos: Number(r.sacos_semana || 0),
          costo: Number(r.costo_semana || 0),
          diasCerrados: cerrados[f.id] || 0,
          semanaCerrada: semCerrada.has(f.id),
        }
      }))
    } catch (err) {
      setAviso('No se pudo cargar. ' + (err.message || ''))
    } finally {
      setCargando(false)
    }
  }, [fincas, idsFincas, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  const activas = filas.filter(f => f.libras > 0 || f.sembradas > 0)
  const t = {
    libras: filas.reduce((s, f) => s + f.libras, 0),
    sacos: filas.reduce((s, f) => s + f.sacos, 0),
    costo: filas.reduce((s, f) => s + f.costo, 0),
    sembradas: filas.reduce((s, f) => s + f.sembradas, 0),
    hectareas: filas.reduce((s, f) => s + f.hectareasSembradas, 0),
  }

  const semanaEnCurso = lunesDe(hoy) === lunes
  const COLS = '190px 92px 110px 116px 96px 116px 108px 132px'

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Resumen</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana {semanaISO(lunes).semana} · del {corta(lunes)} al {corta(fechas[6])}
            {semanaEnCurso && ' · en curso'}
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
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px',
                      fontSize: '13px', background: '#FCEBEB', color: '#A32D2D' }}>{aviso}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '11px', marginBottom: '12px' }}>
        <Kpi k="Balanceado de la semana" v={miles(t.libras) + ' lb'} s={`${miles(t.sacos)} sacos`} />
        <Kpi k="Costo de la semana" v={dinero(t.costo)}
             s={t.libras ? dinero(t.costo / t.libras) + ' por libra' : null} />
        <Kpi k="Piscinas sembradas" v={t.sembradas} s={`${t.hectareas.toFixed(2)} ha`} />
        <Kpi k="Fincas con movimiento" v={`${activas.length} de ${filas.length}`} />
      </div>

      {cargando ? (
        <Vacio>Cargando...</Vacio>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '1000px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Finca</Th>
                <Th>Piscinas</Th>
                <Th>Hectáreas</Th>
                <Th>Libras semana</Th>
                <Th>Sacos</Th>
                <Th>Costo</Th>
                <Th>Costo por libra</Th>
                <Th>Estado</Th>
              </div>

              {filas.map(f => (
                <div key={f.id}
                     onClick={() => onIrAFinca && onIrAFinca(f.id)}
                     style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center',
                              borderBottom: '0.5px solid #f1f6f9',
                              cursor: onIrAFinca ? 'pointer' : 'default' }}>
                  <Td pegado alineado="left">
                    <span style={{ fontWeight: 500, fontSize: '14px', letterSpacing: '0.04em' }}>
                      {String(f.nombre).toUpperCase()}
                    </span>
                  </Td>
                  <Td>
                    <span style={{ fontWeight: 500 }}>{f.sembradas}</span>
                    <span style={{ color: GRIS }}> de {f.piscinas}</span>
                  </Td>
                  <Td><span style={{ color: GRIS }}>
                    {f.hectareasSembradas ? f.hectareasSembradas.toFixed(2) : '—'}
                  </span></Td>
                  <Td><span style={{ fontWeight: 500, fontSize: '15px' }}>
                    {f.libras ? miles(f.libras) : <Guion />}
                  </span></Td>
                  <Td><span style={{ color: GRIS }}>{f.sacos ? miles(f.sacos) : <Guion />}</span></Td>
                  <Td><span style={{ fontWeight: 500 }}>{f.costo ? dinero(f.costo) : <Guion />}</span></Td>
                  <Td><span style={{ color: GRIS }}>
                    {f.libras ? dinero(f.costo / f.libras) : <Guion />}
                  </span></Td>
                  <Td><Estado fila={f} semanaEnCurso={semanaEnCurso} /></Td>
                </div>
              ))}

              <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center',
                            background: '#fafcfd', borderTop: '0.5px solid ' + BORDE }}>
                <Td pegado alineado="left" fondo="#fafcfd">
                  <span style={{ fontWeight: 500, fontSize: '14px' }}>Total del grupo</span>
                </Td>
                <Td fondo="#fafcfd"><span style={{ fontWeight: 500 }}>{t.sembradas}</span></Td>
                <Td fondo="#fafcfd"><span style={{ color: GRIS }}>{t.hectareas.toFixed(2)}</span></Td>
                <Td fondo="#fafcfd"><span style={{ fontWeight: 500, fontSize: '16px' }}>{miles(t.libras)}</span></Td>
                <Td fondo="#fafcfd"><span style={{ color: GRIS }}>{miles(t.sacos)}</span></Td>
                <Td fondo="#fafcfd"><span style={{ fontWeight: 500, fontSize: '15px' }}>{dinero(t.costo)}</span></Td>
                <Td fondo="#fafcfd"><span style={{ color: GRIS }}>
                  {t.libras ? dinero(t.costo / t.libras) : ''}
                </span></Td>
                <Td fondo="#fafcfd" />
              </div>
            </div>
          </div>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE,
                        background: '#fafcfd', fontSize: '13px', color: GRIS }}>
            Cada número sale de sumar los registros diarios de esa semana.
            Haz clic en una finca para abrirla.
          </div>
        </div>
      )}

      {!cargando && filas.some(f => !f.semanaCerrada && f.diasCerrados < 7 && !semanaEnCurso) && (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '16px 18px', marginTop: '12px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>Lo que necesita atención</h3>
          {filas.filter(f => !f.semanaCerrada && f.diasCerrados < 7 && f.sembradas > 0).map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '11px',
                    padding: '9px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
              <span style={{ width: '19px', height: '19px', borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', color: 'white', background: '#E24B4A' }}>!</span>
              <span style={{ fontWeight: 500, minWidth: '150px' }}>{String(f.nombre).toUpperCase()}</span>
              <span style={{ color: GRIS }}>
                {f.diasCerrados === 0
                  ? 'Sin ningún día cerrado en esta semana'
                  : `Solo ${f.diasCerrados} de 7 días cerrados`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Estado({ fila, semanaEnCurso }) {
  if (fila.semanaCerrada) return <Badge fondo="#EAF3DE" color="#3B6D11">Cerrada</Badge>
  if (!fila.sembradas) return <Badge fondo="#eef3f7" color="#7d8fa0">Sin sembrar</Badge>
  if (fila.diasCerrados === 7) return <Badge fondo="#E6F1FB" color="#185FA5">Lista para cerrar</Badge>
  if (semanaEnCurso) return <Badge fondo="#E6F1FB" color="#185FA5">{fila.diasCerrados} de 7 días</Badge>
  return <Badge fondo="#FAEEDA" color="#854F0B">{fila.diasCerrados} de 7 días</Badge>
}

function Badge({ children, fondo, color }) {
  return (
    <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px',
                   borderRadius: '20px', background: fondo, color }}>{children}</span>
  )
}

const Guion = () => <span style={{ color: '#c3d0db' }}>—</span>

function Kpi({ k, v, s }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>{k}</div>
      <div style={{ fontSize: '23px', fontWeight: 500 }}>{v}</div>
      {s && <div style={{ fontSize: '12px', color: GRIS, marginTop: '2px' }}>{s}</div>}
    </div>
  )
}

function Th({ children, pegado }) {
  return (
    <div style={{
      padding: '10px 9px', fontSize: '11px', color: GRIS, fontWeight: 500, textAlign: 'center',
      background: '#fafcfd',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 3, textAlign: 'left',
                     paddingLeft: '16px', borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Td({ children, pegado, fondo, alineado }) {
  return (
    <div style={{
      padding: '11px 9px', textAlign: alineado || 'center', fontSize: '13px',
      fontVariantNumeric: 'tabular-nums', background: fondo || 'white',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 2, paddingLeft: '16px',
                     borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Btn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: 'white', color: NAVY, border: '0.5px solid ' + BORDE, borderRadius: '9px',
      padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px',
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
