import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { corta } from '../lib/fechas'

// Historial · bitacora de cambios (regla 8)
//
// Solo jefes. La bitacora no se edita ni se borra: la tabla no tiene
// politicas de update ni de delete, ni para un jefe. Esta pantalla solo
// lee.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

// Cada tipo de cambio con su color, para poder barrer la lista con la
// vista sin leerla entera.
const TIPOS = {
  precio_producto: { nombre: 'Precio',   color: '#854F0B', fondo: '#FAEEDA' },
  alimentacion:    { nombre: 'Consumo',  color: '#0C447C', fondo: '#E6F1FB' },
  ciclo:           { nombre: 'Ciclo',    color: '#0F6E56', fondo: '#E1F5EE' },
  evento:          { nombre: 'Evento',   color: '#3C3489', fondo: '#EEEDFE' },
  semana_cerrada:  { nombre: 'Semana',   color: '#5B4A6B', fondo: '#F1EDF5' },
  dia_registro:    { nombre: 'Día',      color: '#8A2F2E', fondo: '#FBEAEA' },
}

const FILTROS = [
  ['', 'Todo'],
  ['precio_producto', 'Precios'],
  ['alimentacion', 'Consumo'],
  ['ciclo', 'Ciclos'],
  ['evento', 'Eventos'],
  ['semana_cerrada', 'Cierres'],
]

export default function Historial({ finca, esJefe, todasLasFincas }) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('')
  const [soloEstaFinca, setSoloEstaFinca] = useState(true)
  const [abierta, setAbierta] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true); setError(null)
    const { data, error } = await supabase
      .schema('produccion')
      .rpc('fn_bitacora', {
        p_finca: soloEstaFinca ? finca.id : null,
        p_desde: null, p_hasta: null, p_limite: 300,
      })
    if (error) setError(error.message)
    setFilas(data || [])
    setCargando(false)
  }, [finca.id, soloEstaFinca])

  useEffect(() => { if (esJefe) cargar() }, [cargar, esJefe])

  if (!esJefe) {
    return (
      <Marco>
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      padding: '32px', textAlign: 'center' }}>
          <div style={{ fontSize: '15px', marginBottom: '6px' }}>Esta pantalla es para los jefes</div>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Registra quién cambió qué y cuándo. Si necesitas revisar algo de tu finca, pídeselo a Jaime o a Fredy.
          </div>
        </div>
      </Marco>
    )
  }

  const visibles = (filtro ? filas.filter(f => f.tabla === filtro) : filas)
    .slice()
    .sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en))

  return (
    <Marco>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>Historial de cambios</h2>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            Quién cambió qué y cuándo. No se puede editar ni borrar, ni por un jefe.
          </p>
        </div>
        <button onClick={cargar} disabled={cargando} style={boton}>
          {cargando ? 'Cargando...' : 'Actualizar'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap',
                    marginBottom: '14px' }}>
        {FILTROS.map(([v, t]) => {
          const on = filtro === v
          return (
            <button key={v || 'todo'} onClick={() => setFiltro(v)}
              style={{ ...chip, border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
                       background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY,
                       fontWeight: on ? 500 : 400 }}>
              {t}
            </button>
          )
        })}
        {todasLasFincas > 1 && (
          <button onClick={() => setSoloEstaFinca(x => !x)}
            style={{ ...chip, marginLeft: 'auto',
                     border: '0.5px solid ' + (soloEstaFinca ? BORDE : '#9cc4e8'),
                     background: soloEstaFinca ? 'white' : '#E6F1FB',
                     color: soloEstaFinca ? NAVY : AZUL }}>
            {soloEstaFinca ? String(finca.nombre).toUpperCase() : 'TODAS LAS FINCAS'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#FBEAEA', color: '#8A2F2E', borderRadius: '10px',
                      padding: '12px 14px', fontSize: '13px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                    overflow: 'hidden' }}>
        {cargando ? (
          <Vacio>Cargando...</Vacio>
        ) : !visibles.length ? (
          <Vacio>
            {filtro
              ? 'No hay cambios de este tipo todavía.'
              : 'Todavía no hay nada registrado. La bitácora se llena sola: guarda un cambio en un día ya cerrado o modifica un precio y aparecerá aquí.'}
          </Vacio>
        ) : visibles.map(f => {
          const t = TIPOS[f.tabla] || { nombre: f.tabla, color: GRIS, fondo: '#f1f6f9' }
          const abierto = abierta === f.id
          return (
            <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9' }}>
              <div
                onClick={() => setAbierta(abierto ? null : f.id)}
                style={{ display: 'grid', gridTemplateColumns: '146px 104px 1fr 150px',
                         gap: '12px', alignItems: 'center', padding: '12px 16px',
                         cursor: 'pointer', fontSize: '13px' }}
              >
                <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                  {momento(f.creado_en)}
                </span>
                <span>
                  <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 9px',
                                 borderRadius: '20px', background: t.fondo, color: t.color }}>
                    {t.nombre}
                  </span>
                </span>
                <span>{f.resumen}</span>
                <span style={{ color: GRIS, textAlign: 'right' }}>
                  {f.usuario}
                  {!soloEstaFinca && (
                    <div style={{ fontSize: '11px' }}>{f.finca}</div>
                  )}
                </span>
              </div>

              {abierto && (
                <div style={{ background: '#fbfcfd', padding: '4px 16px 16px',
                              display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                  <Json titulo="Antes" valor={f.valor_anterior} />
                  <Json titulo="Después" valor={f.valor_nuevo} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!cargando && visibles.length >= 300 && (
        <div style={{ fontSize: '12px', color: GRIS, marginTop: '10px' }}>
          Se muestran los 300 cambios más recientes.
        </div>
      )}
    </Marco>
  )
}

// El detalle crudo. No es bonito a proposito: es la prueba, y tiene que
// verse tal como quedo guardado.
function Json({ titulo, valor }) {
  if (!valor) return null
  return (
    <div style={{ flex: '1 1 280px', minWidth: 0 }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px' }}>{titulo}</div>
      <pre style={{ margin: 0, fontSize: '11px', lineHeight: 1.5, color: NAVY,
                    background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px',
                    padding: '10px 12px', overflowX: 'auto', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word' }}>
        {JSON.stringify(valor, null, 2)}
      </pre>
    </div>
  )
}

// Hoy y ayer se dicen con palabras; mas atras, con la fecha.
function momento(iso) {
  const d = new Date(iso)
  const hora = d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })
  const dia = d.toISOString().slice(0, 10)
  const hoy = new Date().toISOString().slice(0, 10)
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (dia === hoy) return 'Hoy ' + hora
  if (dia === ayer) return 'Ayer ' + hora
  return corta(dia) + ' ' + hora
}

function Marco({ children }) {
  return <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>{children}</div>
}

function Vacio({ children }) {
  return (
    <div style={{ padding: '34px 24px', textAlign: 'center', fontSize: '13px',
                  color: GRIS, maxWidth: '520px', margin: '0 auto', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

const chip = { padding: '7px 14px', borderRadius: '20px', fontFamily: 'inherit',
               fontSize: '13px', cursor: 'pointer' }
const boton = { padding: '9px 16px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', cursor: 'pointer',
                background: 'white', color: NAVY }
