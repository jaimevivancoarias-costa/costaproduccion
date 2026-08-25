import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, dinero } from '../lib/fechas'

// Inventario de insumos · modulo Produccion
//
// Contar la bodega no suma ni resta: FIJA el saldo. Y la diferencia
// contra lo que el sistema tenia calculado no se esconde: se muestra
// antes de guardar y queda en la bitacora. Si el sistema decia 40 sacos
// de cal y hay 33, el dato util no es "ahora hay 33", es que faltan 7.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#8A2F2E'
const VERDE = '#0F6E56'
const AMBAR = '#854F0B'

// Sin abreviaturas: el bodeguero no tiene por que descifrar "lt".
const UNIDAD = {
  sacos: 'sacos', litros: 'litros', gramos: 'gramos',
  libras: 'libras', kg: 'kilos', unidad: 'unidades',
}

export default function Inventario({ finca }) {
  const [saldos, setSaldos] = useState([])
  const [precios, setPrecios] = useState({})
  const [conteos, setConteos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const [contando, setContando] = useState(false)
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: s, error: eS }, { data: p }, { data: t }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_saldo_insumo',
          { p_finca: finca.id, p_hasta: hoyISO() }),
        supabase.schema('produccion').from('precio_insumo')
          .select('insumo_id, finca_id, precio_unitario')
          .is('vigente_hasta', null)
          .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
        supabase.schema('produccion').from('toma_inventario')
          .select('id, fecha, observacion')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
      ])
      if (eS) throw eS

      // El precio de la finca le gana al general.
      const pr = {}
      ;(p || []).forEach(x => {
        if (pr[x.insumo_id] && !x.finca_id) return
        pr[x.insumo_id] = Number(x.precio_unitario)
      })

      setSaldos(s || []); setPrecios(pr); setConteos(t || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = conteos.length === 0
  const ultimo = conteos[0]

  const valorBodega = useMemo(
    () => saldos.reduce((t, s) => t + Number(s.saldo) * (precios[s.insumo_id] || 0), 0),
    [saldos, precios])
  const conSaldo = saldos.filter(s => Number(s.saldo) > 0).length
  const negativos = saldos.filter(s => Number(s.saldo) < 0).length
  const sinPrecio = saldos.filter(s => !precios[s.insumo_id]).length

  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.insumo_id]
    const hay = txt !== undefined && txt !== ''
    const c = hay ? Number(txt) : null
    return { ...s, precio: precios[s.insumo_id] || 0,
             contado: c, diferencia: hay ? c - Number(s.saldo) : null }
  }), [saldos, precios, contado])

  const descuadres = filas.filter(f => f.diferencia !== null && Math.abs(f.diferencia) > 0.0001)
  const llenadas = filas.filter(f => f.contado !== null).length

  async function guardar() {
    if (!llenadas) {
      setAviso({ tipo: 'error', texto: 'No has contado ningún insumo todavía.' })
      return
    }

    const texto = primeraVez
      ? `Vas a cargar el inventario inicial con ${llenadas} insumos contados.\n\n` +
        `De aquí en adelante el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra a bodega.\n\n¿Guardar?`
      : descuadres.length
        ? `${descuadres.length} insumos no cuadran con lo que el sistema tenía calculado.\n\n` +
          descuadres.slice(0, 5).map(d =>
            `${d.insumo}: el sistema decía ${limpio(d.saldo)}, contaste ${limpio(d.contado)} (${d.diferencia > 0 ? 'sobran ' : 'faltan '}${limpio(Math.abs(d.diferencia))})`
          ).join('\n') +
          (descuadres.length > 5 ? `\n...y ${descuadres.length - 5} más` : '') +
          `\n\nLas diferencias quedan registradas con tu nombre y la fecha. ¿Guardar?`
        : `Todo cuadra con lo que el sistema tenía calculado. ¿Guardar el conteo?`

    if (!window.confirm(texto)) return

    setGuardando(true); setAviso(null)
    try {
      const { data: toma, error } = await supabase.schema('produccion')
        .from('toma_inventario')
        .insert({ finca_id: finca.id, fecha, observacion: obs || null })
        .select('id').single()
      if (error) throw error

      const lineas = filas.filter(f => f.contado !== null).map(f => ({
        toma_id: toma.id, insumo_id: f.insumo_id,
        cantidad_contada: f.contado,
        cantidad_sistema: Number(f.saldo),
        diferencia: f.diferencia,
      }))
      const { error: e2 } = await supabase.schema('produccion')
        .from('toma_inventario_linea').insert(lineas)
      if (e2) throw e2

      setAviso({ tipo: 'ok',
        texto: primeraVez ? 'Inventario inicial cargado.' : `Conteo guardado. ${lineas.length} insumos.` })
      setContando(false); setContado({}); setObs('')
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>Inventario de insumos</h2>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            Bodega de {String(finca.nombre).toUpperCase()}.
          </p>
        </div>
        {!contando && !cargando && (
          <Btn primario onClick={() => setContando(true)}>
            {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
          </Btn>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>
          {aviso.texto}
        </div>
      )}

      {!contando && !cargando && (
        <>
          {/* Resumen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                        gap: '11px', marginBottom: '14px' }}>
            <Kpi titulo="Valor de la bodega" valor={dinero(valorBodega)} />
            <Kpi titulo="Insumos con saldo" valor={`${conSaldo} de ${saldos.length}`} />
            <Kpi titulo="Último conteo"
                 valor={ultimo ? corta(ultimo.fecha) : 'Nunca'}
                 nota={ultimo ? null : 'todo arranca en cero'}
                 alerta={!ultimo} />
            <Kpi titulo="Con problema"
                 valor={negativos + sinPrecio === 0 ? 'Ninguno' : String(negativos + sinPrecio)}
                 nota={negativos ? `${negativos} en negativo` : sinPrecio ? `${sinPrecio} sin precio` : null}
                 alerta={negativos + sinPrecio > 0} />
          </div>

          {primeraVez && (
            <Nota color={AMBAR} fondo="#FAEEDA">
              Todavía no se ha contado la bodega de esta finca, así que todo está en cero.
              Cuenta lo que hay y guárdalo con <b>Cargar inventario inicial</b>. De ahí en adelante
              el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra.
            </Nota>
          )}

          {negativos > 0 && (
            <Nota color={ROJO} fondo="#FBEAEA">
              Hay {negativos} {negativos === 1 ? 'insumo' : 'insumos'} con saldo negativo. Eso significa
              que se registró más consumo del que entró a bodega: falta cargar un ingreso, o hay que
              volver a contar.
            </Nota>
          )}
        </>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '34px', textAlign: 'center', fontSize: '13px', color: GRIS }}>
          Cargando...
        </div></Caja>

      ) : contando ? (
        <Caja>
          <div style={{ padding: '15px 16px', borderBottom: '0.5px solid ' + BORDE,
                        display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <Etiqueta>Fecha del conteo</Etiqueta>
              <input type="date" value={fecha} max={hoyISO()}
                     onChange={e => setFecha(e.target.value)} style={entrada} />
            </div>
            <div style={{ flex: 1, minWidth: '240px' }}>
              <Etiqueta>Observación</Etiqueta>
              <input value={obs} placeholder="Quién contó, qué se encontró"
                     onChange={e => setObs(e.target.value)} style={{ ...entrada, width: '100%' }} />
            </div>
          </div>

          <Tabla
            columnas={['Insumo', 'Unidad', 'El sistema dice', 'Contado', 'Diferencia']}
            anchos="1fr 110px 130px 130px 150px"
          >
            {filas.map(f => (
              <Fila key={f.insumo_id} anchos="1fr 110px 130px 130px 150px">
                <Celda>{f.insumo}</Celda>
                <Celda gris>{UNIDAD[f.unidad] || f.unidad}</Celda>
                <Celda derecha gris>{limpio(f.saldo)}</Celda>
                <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f1f6f9' }}>
                  <input
                    inputMode="decimal" value={contado[f.insumo_id] ?? ''} placeholder="—"
                    onChange={e => setContado(c => ({ ...c, [f.insumo_id]: e.target.value }))}
                    style={{ ...entrada, width: '100%', textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}
                  />
                </div>
                <Celda derecha color={
                  f.diferencia === null ? '#c3d0db'
                  : f.diferencia < 0 ? ROJO
                  : f.diferencia > 0 ? AMBAR : VERDE
                }>
                  {f.diferencia === null ? '—'
                    : f.diferencia === 0 ? 'cuadra'
                    : (f.diferencia < 0 ? 'faltan ' : 'sobran ') + limpio(Math.abs(f.diferencia))}
                </Celda>
              </Fila>
            ))}
          </Tabla>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: GRIS, marginRight: 'auto' }}>
              {llenadas} de {saldos.length} contados
              {!primeraVez && descuadres.length > 0 && ` · ${descuadres.length} no cuadran`}
            </span>
            <Btn onClick={() => { setContando(false); setContado({}) }}>Cancelar</Btn>
            <Btn primario onClick={guardar} disabled={guardando || !llenadas}>
              {guardando ? 'Guardando...' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
            </Btn>
          </div>
        </Caja>

      ) : (
        <>
          <Tabla
            caja
            columnas={['Insumo', 'Unidad', 'Saldo', 'Precio unitario', 'Valor en bodega']}
            anchos="1fr 110px 120px 140px 150px"
          >
            {filas.map(f => (
              <Fila key={f.insumo_id} anchos="1fr 110px 120px 140px 150px">
                <Celda>{f.insumo}</Celda>
                <Celda gris>{UNIDAD[f.unidad] || f.unidad}</Celda>
                <Celda derecha fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>
                  {limpio(f.saldo)}
                </Celda>
                <Celda derecha gris>{f.precio ? dinero(f.precio) : 'sin precio'}</Celda>
                <Celda derecha>{dinero(Number(f.saldo) * f.precio)}</Celda>
              </Fila>
            ))}
            <Fila anchos="1fr 110px 120px 140px 150px" total>
              <Celda fuerte>Total</Celda>
              <Celda /><Celda /><Celda />
              <Celda derecha fuerte>{dinero(valorBodega)}</Celda>
            </Fila>
          </Tabla>

          {conteos.length > 0 && (
            <div style={{ marginTop: '18px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Conteos anteriores</h3>
              <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 11px' }}>
                El saldo de arriba se calcula desde el más reciente.
              </p>
              <Tabla caja columnas={['Fecha', 'Observación']} anchos="150px 1fr">
                {conteos.map(c => (
                  <Fila key={c.id} anchos="150px 1fr">
                    <Celda fuerte>{corta(c.fecha)}</Celda>
                    <Celda gris>{c.observacion || 'Sin observación'}</Celda>
                  </Fila>
                ))}
              </Tabla>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Piezas de tabla
// ---------------------------------------------------------------------
function Tabla({ columnas, anchos, children, caja }) {
  const cuerpo = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: anchos,
                    background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
        {columnas.map((c, i) => (
          <div key={c} style={{ padding: '10px 12px', fontSize: '11px', fontWeight: 500,
                  color: GRIS, letterSpacing: '0.03em', textTransform: 'uppercase',
                  textAlign: i >= 2 ? 'right' : 'left',
                  borderLeft: i === 0 ? 'none' : '0.5px solid ' + BORDE }}>
            {c}
          </div>
        ))}
      </div>
      {children}
    </>
  )
  if (!caja) return cuerpo
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>
      {cuerpo}
    </div>
  )
}

function Fila({ anchos, children, total }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: anchos, alignItems: 'center',
                  borderBottom: total ? 'none' : '0.5px solid #f1f6f9',
                  borderTop: total ? '0.5px solid ' + BORDE : 'none',
                  background: total ? '#fafcfd' : 'white' }}>
      {children}
    </div>
  )
}

function Celda({ children, derecha, gris, fuerte, color }) {
  return (
    <div style={{ padding: '10px 12px', fontSize: '13px',
                  textAlign: derecha ? 'right' : 'left',
                  color: color || (gris ? GRIS : NAVY),
                  fontWeight: fuerte ? 500 : 400,
                  fontVariantNumeric: derecha ? 'tabular-nums' : 'normal',
                  borderLeft: '0.5px solid #f6f9fb' }}>
      {children}
    </div>
  )
}

function Kpi({ titulo, valor, nota, alerta }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + (alerta ? '#e8d5b0' : BORDE),
                  borderRadius: '12px', padding: '13px 15px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px',
                    letterSpacing: '0.03em', textTransform: 'uppercase' }}>{titulo}</div>
      <div style={{ fontSize: '20px', fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                    color: alerta ? AMBAR : NAVY }}>{valor}</div>
      {nota && <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px' }}>{nota}</div>}
    </div>
  )
}

function Nota({ children, color, fondo }) {
  return (
    <div style={{ background: fondo, color, borderRadius: '10px', padding: '13px 15px',
                  fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>{children}</div>
  )
}

function Etiqueta({ children }) {
  return <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{children}</div>
}

function Btn({ children, primario, ...props }) {
  return (
    <button {...props} style={{
      padding: '9px 17px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      borderRadius: '9px', cursor: props.disabled ? 'default' : 'pointer',
      border: '0.5px solid ' + (primario ? AZUL : BORDE),
      background: primario ? AZUL : 'white',
      color: primario ? 'white' : NAVY,
      opacity: props.disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}

// Los insumos vienen en unidades muy distintas: 40 sacos y 0,0265
// gramos. Mostrar siempre cuatro decimales llenaria la tabla de ceros.
function limpio(n) {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const s = v.toFixed(4).replace(/\.?0+$/, '')
  return s === '' || s === '-' ? '0' : s
}

const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
