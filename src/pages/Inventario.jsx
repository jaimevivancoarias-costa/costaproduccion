import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, dinero } from '../lib/fechas'

// Inventario de insumos · modulo Produccion
//
// Por ahora dos cosas: ver el saldo de bodega y hacer una toma fisica.
// Los ingresos con guia y los pedidos vienen despues.
//
// Regla de la toma fisica: no suma ni resta, FIJA. Y la diferencia
// contra lo que el sistema calculaba no se esconde: se muestra al
// guardar y queda en la bitacora. Si el sistema decia 40 sacos de cal
// y hay 33, el dato util no es "ahora hay 33", es que faltan 7.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#8A2F2E'
const VERDE = '#0F6E56'

const UNIDAD = {
  sacos: 'sacos', litros: 'lt', gramos: 'g',
  libras: 'lb', kg: 'kg', unidad: 'u',
}

export default function Inventario({ finca, esJefe }) {
  const [saldos, setSaldos] = useState([])
  const [precios, setPrecios] = useState({})
  const [tomas, setTomas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  // Toma en curso
  const [contando, setContando] = useState(false)
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})   // insumoId -> texto
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
          .select('id, fecha, observacion, creado_en')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
      ])
      if (eS) throw eS

      // El precio de la finca le gana al general.
      const pr = {}
      ;(p || []).forEach(x => {
        if (pr[x.insumo_id] && !x.finca_id) return
        pr[x.insumo_id] = Number(x.precio_unitario)
      })

      setSaldos(s || [])
      setPrecios(pr)
      setTomas(t || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id])

  useEffect(() => { cargar() }, [cargar])

  const valorBodega = useMemo(
    () => saldos.reduce((t, s) => t + Number(s.saldo) * (precios[s.insumo_id] || 0), 0),
    [saldos, precios])

  const nuncaContado = saldos.length > 0 && saldos.every(s => !s.desde)

  // Las diferencias de la toma en curso, para poder mostrarlas antes
  // de guardar y no despues.
  const diferencias = useMemo(() => saldos.map(s => {
    const txt = contado[s.insumo_id]
    const hay = txt !== undefined && txt !== ''
    const c = hay ? Number(txt) : null
    return { ...s, contado: c, diferencia: hay ? c - Number(s.saldo) : null }
  }), [saldos, contado])

  const conDiferencia = diferencias.filter(d => d.diferencia !== null && Math.abs(d.diferencia) > 0.0001)
  const llenadas = diferencias.filter(d => d.contado !== null).length

  async function guardarToma() {
    if (!llenadas) {
      setAviso({ tipo: 'error', texto: 'No has contado ningún insumo todavía.' })
      return
    }
    const resumen = conDiferencia.length
      ? `${conDiferencia.length} insumos no cuadran con lo que el sistema tenía calculado.\n\n` +
        conDiferencia.slice(0, 5).map(d =>
          `${d.insumo}: sistema ${d.saldo}, contado ${d.contado} (${d.diferencia > 0 ? '+' : ''}${d.diferencia})`
        ).join('\n') +
        (conDiferencia.length > 5 ? `\n...y ${conDiferencia.length - 5} más` : '') +
        '\n\nLas diferencias quedan registradas en la bitácora. ¿Guardar la toma?'
      : 'Todo cuadra con lo que el sistema tenía calculado. ¿Guardar la toma?'

    if (!window.confirm(resumen)) return

    setGuardando(true); setAviso(null)
    try {
      const { data: toma, error } = await supabase.schema('produccion')
        .from('toma_inventario')
        .insert({ finca_id: finca.id, fecha, observacion: obs || null })
        .select('id').single()
      if (error) throw error

      const lineas = diferencias
        .filter(d => d.contado !== null)
        .map(d => ({
          toma_id: toma.id,
          insumo_id: d.insumo_id,
          cantidad_contada: d.contado,
          cantidad_sistema: Number(d.saldo),
          diferencia: d.diferencia,
        }))

      const { error: e2 } = await supabase.schema('produccion')
        .from('toma_inventario_linea').insert(lineas)
      if (e2) throw e2

      setAviso({ tipo: 'ok', texto: `Toma guardada. ${lineas.length} insumos contados.` })
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
          <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>
            Inventario de insumos
          </h2>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            Bodega de {String(finca.nombre).toUpperCase()}. El saldo se calcula desde la última toma física.
          </p>
        </div>
        {!contando && (
          <Btn primario onClick={() => setContando(true)}>Hacer toma física</Btn>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>
          {aviso.texto}
        </div>
      )}

      {nuncaContado && !contando && (
        <div style={{ background: '#FAEEDA', color: '#854F0B', borderRadius: '10px',
                      padding: '13px 15px', fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
          Todavía no se ha hecho ninguna toma física en esta finca, así que todo arranca en cero.
          Cuenta la bodega y guarda la primera toma: de ahí en adelante el saldo se lleva solo.
        </div>
      )}

      {cargando ? (
        <Caja><Centro>Cargando...</Centro></Caja>
      ) : contando ? (
        <Caja>
          <div style={{ padding: '16px 18px', borderBottom: '0.5px solid ' + BORDE,
                        display: 'flex', gap: '18px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Fecha del conteo</div>
              <input type="date" value={fecha} max={hoyISO()}
                     onChange={e => setFecha(e.target.value)} style={entrada} />
            </div>
            <div style={{ flex: 1, minWidth: '220px' }}>
              <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Observación</div>
              <input value={obs} placeholder="Quién contó, qué se encontró, etc."
                     onChange={e => setObs(e.target.value)} style={{ ...entrada, width: '100%' }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px 130px',
                        gap: '12px', padding: '11px 18px', fontSize: '12px', color: GRIS,
                        borderBottom: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
            <span>Insumo</span>
            <span style={{ textAlign: 'right' }}>El sistema dice</span>
            <span style={{ textAlign: 'right' }}>Contado</span>
            <span style={{ textAlign: 'right' }}>Diferencia</span>
          </div>

          {diferencias.map(d => (
            <div key={d.insumo_id}
                 style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px 130px',
                          gap: '12px', padding: '9px 18px', alignItems: 'center',
                          borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
              <span>
                {d.insumo}
                <span style={{ color: GRIS, fontSize: '11px' }}> · {UNIDAD[d.unidad] || d.unidad}</span>
              </span>
              <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                {limpio(d.saldo)}
              </span>
              <input
                inputMode="decimal" value={contado[d.insumo_id] ?? ''}
                placeholder="—"
                onChange={e => setContado(c => ({ ...c, [d.insumo_id]: e.target.value }))}
                style={{ ...entrada, textAlign: 'right', width: '100%',
                         fontVariantNumeric: 'tabular-nums' }}
              />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                             fontWeight: d.diferencia ? 500 : 400,
                             color: d.diferencia === null ? '#c3d0db'
                                  : d.diferencia < 0 ? ROJO
                                  : d.diferencia > 0 ? '#854F0B' : VERDE }}>
                {d.diferencia === null ? '—'
                  : d.diferencia === 0 ? 'cuadra'
                  : (d.diferencia > 0 ? '+' : '') + limpio(d.diferencia)}
              </span>
            </div>
          ))}

          <div style={{ padding: '14px 18px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: GRIS, marginRight: 'auto' }}>
              {llenadas} de {saldos.length} contados
              {conDiferencia.length > 0 && ` · ${conDiferencia.length} no cuadran`}
            </span>
            <Btn onClick={() => { setContando(false); setContado({}) }}>Cancelar</Btn>
            <Btn primario onClick={guardarToma} disabled={guardando || !llenadas}>
              {guardando ? 'Guardando...' : 'Guardar toma'}
            </Btn>
          </div>
        </Caja>
      ) : (
        <>
          <Caja>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 120px 140px',
                          gap: '12px', padding: '11px 18px', fontSize: '12px', color: GRIS,
                          borderBottom: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
              <span>Insumo</span>
              <span style={{ textAlign: 'right' }}>Saldo</span>
              <span style={{ textAlign: 'right' }}>Precio</span>
              <span style={{ textAlign: 'right' }}>Valor en bodega</span>
            </div>

            {saldos.map(s => {
              const precio = precios[s.insumo_id] || 0
              const saldo = Number(s.saldo)
              return (
                <div key={s.insumo_id}
                     style={{ display: 'grid', gridTemplateColumns: '1fr 130px 120px 140px',
                              gap: '12px', padding: '10px 18px', alignItems: 'center',
                              borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
                  <span>
                    {s.insumo}
                    <span style={{ color: GRIS, fontSize: '11px' }}> · {UNIDAD[s.unidad] || s.unidad}</span>
                  </span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 fontWeight: 500, color: saldo < 0 ? ROJO : NAVY }}>
                    {limpio(saldo)}
                  </span>
                  <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                    {precio ? dinero(precio) : 'sin precio'}
                  </span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {dinero(saldo * precio)}
                  </span>
                </div>
              )
            })}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 120px 140px',
                          gap: '12px', padding: '13px 18px', alignItems: 'center',
                          background: '#fafcfd', fontSize: '14px', fontWeight: 500 }}>
              <span>Valor total de la bodega</span>
              <span /><span />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {dinero(valorBodega)}
              </span>
            </div>
          </Caja>

          {saldos.some(s => s.saldo < 0) && (
            <div style={{ background: '#FBEAEA', color: ROJO, borderRadius: '10px',
                          padding: '13px 15px', fontSize: '13px', marginTop: '12px', lineHeight: 1.6 }}>
              Hay insumos con saldo negativo. Eso significa que se registró más consumo del que entró
              a bodega: falta cargar un ingreso, o hay que hacer una toma física.
            </div>
          )}

          {tomas.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Tomas anteriores</h3>
              <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 12px' }}>
                El saldo de arriba se calcula desde la más reciente.
              </p>
              <Caja>
                {tomas.map(t => (
                  <div key={t.id} style={{ display: 'flex', gap: '14px', alignItems: 'center',
                          padding: '11px 18px', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
                    <span style={{ fontWeight: 500, minWidth: '110px' }}>{corta(t.fecha)}</span>
                    <span style={{ color: GRIS }}>{t.observacion || 'Sin observación'}</span>
                  </div>
                ))}
              </Caja>
            </div>
          )}
        </>
      )}
    </div>
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

function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>
      {children}
    </div>
  )
}

function Centro({ children }) {
  return (
    <div style={{ padding: '34px 24px', textAlign: 'center', fontSize: '13px', color: GRIS }}>
      {children}
    </div>
  )
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

const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
