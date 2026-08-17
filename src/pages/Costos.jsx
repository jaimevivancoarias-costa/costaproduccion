import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, corta, num, miles, dinero,
} from '../lib/fechas'

// Costos · banda 3 del Excel
//
// Todo aqui es calculo. El unico dato almacenado es el precio del saco
// que se congelo al registrar cada dia (regla P3), asi que cambiar un
// precio hoy no mueve estos numeros.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export default function Costos({ finca }) {
  const [lunes, setLunes] = useState(() => lunesDe(hoyISO()))
  const [filas, setFilas] = useState([])
  const [productos, setProductos] = useState([])
  const [acumulado, setAcumulado] = useState({})
  const [anual, setAnual] = useState(0)
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]

      const { data: piscinas } = await supabase
        .schema('produccion').from('piscina')
        .select('id, codigo, nombre, hectareas, tipo')
        .eq('finca_id', finca.id).eq('activa', true)

      const ids = (piscinas || []).map(p => p.id)
      if (!ids.length) { setFilas([]); return }

      // La vista ya trae el costo calculado con el precio congelado.
      const { data: sem, error } = await supabase
        .schema('produccion').from('vw_alimentacion_costeada')
        .select('piscina_id, ciclo_id, producto_id, libras, costo, sacos')
        .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
      if (error) throw error

      const { data: prods } = await supabase
        .schema('produccion').from('producto')
        .select('id, nombre, nombre_corto').order('nombre_corto')

      // Solo los productos que esta finca uso esta semana.
      const usados = new Set((sem || []).map(r => r.producto_id))
      setProductos((prods || []).filter(p => usados.has(p.id)))

      const porPiscina = {}
      ;(sem || []).forEach(r => {
        const f = porPiscina[r.piscina_id] || (porPiscina[r.piscina_id] = { libras: 0, costo: 0, sacos: 0, prod: {} })
        f.libras += Number(r.libras); f.costo += Number(r.costo); f.sacos += Number(r.sacos)
        f.prod[r.producto_id] = (f.prod[r.producto_id] || 0) + Number(r.costo)
      })

      const lista = (piscinas || [])
        .filter(p => porPiscina[p.id])
        .map(p => ({ ...p, ...porPiscina[p.id] }))
        .sort(ordenar)
      setFilas(lista)

      // Acumulado del ciclo de cada piscina.
      const ciclos = [...new Set((sem || []).map(r => r.ciclo_id))]
      const acum = {}
      if (ciclos.length) {
        const { data: hist } = await supabase
          .schema('produccion').from('vw_alimentacion_costeada')
          .select('piscina_id, costo').in('ciclo_id', ciclos).lte('fecha', domingo)
        ;(hist || []).forEach(r => { acum[r.piscina_id] = (acum[r.piscina_id] || 0) + Number(r.costo) })
      }
      setAcumulado(acum)

      const { data: anio } = await supabase
        .schema('produccion').from('vw_alimentacion_costeada')
        .select('costo').in('piscina_id', ids)
        .gte('fecha', lunes.slice(0, 4) + '-01-01').lte('fecha', domingo)
      setAnual((anio || []).reduce((s, r) => s + Number(r.costo), 0))
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  const totalCosto = filas.reduce((s, f) => s + f.costo, 0)
  const totalLibras = filas.reduce((s, f) => s + f.libras, 0)
  const totalSacos = filas.reduce((s, f) => s + f.sacos, 0)
  const porProducto = {}
  filas.forEach(f => Object.entries(f.prod).forEach(([id, c]) => {
    porProducto[id] = (porProducto[id] || 0) + c
  }))
  const masUsado = Object.entries(porProducto).sort((a, b) => b[1] - a[1])[0]

  const COLS = `170px ${productos.map(() => '112px').join(' ')} 116px 104px 124px`

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Costos</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana del {corta(lunes)} al {corta(fechas[6])} · con el precio vigente cada día
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
          background: '#FCEBEB', color: '#A32D2D' }}>{aviso.texto}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '11px', marginBottom: '12px' }}>
        <Kpi k="Costo de la semana" v={dinero(totalCosto)} />
        <Kpi k="Costo por libra aplicada" v={totalLibras ? dinero(totalCosto / totalLibras) : '—'} />
        <Kpi k="Sacos de la semana" v={miles(totalSacos)} s={`${miles(totalLibras)} lb`} />
        <Kpi k="Acumulado del año" v={dinero(anual)} />
      </div>

      {cargando ? (
        <Vacio>Cargando...</Vacio>
      ) : !filas.length ? (
        <Vacio>No hay alimentación registrada en esta semana.</Vacio>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 170 + productos.length * 112 + 344 + 'px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Piscina</Th>
                {productos.map(p => <Th key={p.id}>{p.nombre_corto}</Th>)}
                <Th>Costo semana</Th>
                <Th>Costo por libra</Th>
                <Th>Acumulado del ciclo</Th>
              </div>

              {filas.map(f => (
                <div key={f.id} style={{ display: 'grid', gridTemplateColumns: COLS,
                      borderBottom: '0.5px solid #f1f6f9', alignItems: 'center' }}>
                  <Td pegado alineado="left">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>{f.nombre}</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>
                      {Number(f.hectareas).toFixed(2)} ha{f.tipo === 'precria' && ' · precría'}
                    </div>
                  </Td>
                  {productos.map(p => (
                    <Td key={p.id}>
                      <span style={{ color: f.prod[p.id] ? NAVY : '#c3d0db' }}>
                        {f.prod[p.id] ? dinero(f.prod[p.id]) : '—'}
                      </span>
                    </Td>
                  ))}
                  <Td><span style={{ fontWeight: 500 }}>{dinero(f.costo)}</span></Td>
                  <Td><span style={{ color: GRIS }}>{f.libras ? dinero(f.costo / f.libras) : ''}</span></Td>
                  <Td><span style={{ color: GRIS }}>{dinero(acumulado[f.id] || 0)}</span></Td>
                </div>
              ))}

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderTop: '0.5px solid ' + BORDE, alignItems: 'center' }}>
                <Td pegado alineado="left" fondo="#fafcfd">
                  <span style={{ fontWeight: 500, fontSize: '14px' }}>Total</span>
                  <div style={{ fontSize: '11px', color: GRIS }}>{filas.length} piscinas</div>
                </Td>
                {productos.map(p => (
                  <Td key={p.id} fondo="#fafcfd">
                    <span style={{ fontWeight: 500 }}>{porProducto[p.id] ? dinero(porProducto[p.id]) : '—'}</span>
                  </Td>
                ))}
                <Td fondo="#fafcfd"><span style={{ fontWeight: 500, fontSize: '15px' }}>{dinero(totalCosto)}</span></Td>
                <Td fondo="#fafcfd"><span style={{ color: GRIS }}>
                  {totalLibras ? dinero(totalCosto / totalLibras) : ''}
                </span></Td>
                <Td fondo="#fafcfd" />
              </div>
            </div>
          </div>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE,
                        background: '#fafcfd', fontSize: '13px', color: GRIS }}>
            La suma de los costos por producto tiene que dar el costo total. Es la
            validación V2, la que en el Excel no cuadraba.
            {masUsado && productos.find(p => p.id === masUsado[0]) && (
              <> El producto de mayor peso esta semana es{' '}
                <b style={{ color: NAVY, fontWeight: 500 }}>
                  {productos.find(p => p.id === masUsado[0]).nombre_corto}
                </b>, con {Math.round(masUsado[1] / totalCosto * 100)}% del costo.</>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return (parseInt(a.codigo.replace(/\D/g, ''), 10) || 0) - (parseInt(b.codigo.replace(/\D/g, ''), 10) || 0)
}
