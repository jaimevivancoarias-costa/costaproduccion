import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, dinero } from '../lib/fechas'

// Precios de insumos · modulo Produccion
//
// Por ahora el precio es UNO para las nueve fincas (finca_id nulo).
// Cambiarlo rige desde la fecha que se elija hacia adelante: se cierra
// la vigencia del precio anterior y se abre uno nuevo. Las semanas ya
// registradas conservan el precio con el que se guardaron, porque el
// consumo congela su precio al momento de registrarse.
//
// Solo jefes cambian precios.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const UNIDAD = {
  sacos: 'sacos', litros: 'litros', gramos: 'gramos',
  libras: 'libras', kg: 'kilos', unidad: 'unidades',
}

export default function PreciosInsumos({ esJefe }) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [editando, setEditando] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: ins }, { data: pr }] = await Promise.all([
      supabase.schema('produccion').from('insumo')
        .select('id, nombre, unidad').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('precio_insumo')
        .select('id, insumo_id, precio_unitario, vigente_desde')
        .is('finca_id', null).is('vigente_hasta', null),
    ])
    const precioDe = {}
    ;(pr || []).forEach(x => { precioDe[x.insumo_id] = x })
    setFilas((ins || []).map(i => ({ ...i, precio: precioDe[i.id] || null })))
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  async function guardarPrecio({ insumoId, nuevo, desde }) {
    // Cierra el precio general vigente el dia antes de que arranque el
    // nuevo, y abre el nuevo. Si no habia precio, solo abre.
    await supabase.schema('produccion').from('precio_insumo')
      .update({ vigente_hasta: sumarDias(desde, -1) })
      .eq('insumo_id', insumoId).is('finca_id', null).is('vigente_hasta', null)

    const { error } = await supabase.schema('produccion').from('precio_insumo')
      .insert({ insumo_id: insumoId, finca_id: null, precio_unitario: nuevo, vigente_desde: desde })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditando(null)
    setAviso({ tipo: 'ok', texto: 'Precio actualizado.' })
    await cargar()
  }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Precios de insumos</h3>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0, maxWidth: '560px' }}>
            Un precio para todas las fincas.
            {esJefe
              ? ' Al cambiarlo, rige desde la fecha que elijas hacia adelante; lo ya registrado no se mueve.'
              : ' Solo un jefe puede cambiarlos.'}
          </p>
        </div>
        <button onClick={() => exportar(filas)} disabled={!filas.length}
          style={{ padding: '8px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                   border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white',
                   color: NAVY, cursor: filas.length ? 'pointer' : 'default',
                   opacity: filas.length ? 1 : 0.5 }}>
          Exportar
        </button>
      </div>

      {aviso && (
        <div style={{ borderRadius: '9px', padding: '10px 13px', fontSize: '13px', marginBottom: '11px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? '#8A2F2E' : '#0F6E56' }}>{aviso.texto}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1fr) 120px 140px 130px',
                    gap: '12px', padding: '0 0 8px', fontSize: '11px', color: GRIS }}>
        <div>Insumo</div>
        <div style={{ textAlign: 'right' }}>Precio</div>
        <div>Vigente desde</div>
        <div />
      </div>

      {cargando ? (
        <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div>
      ) : filas.map(f => (
        <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '9px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1fr) 120px 140px 130px',
                        gap: '12px', alignItems: 'center' }}>
            <span style={{ fontWeight: 500, fontSize: '14px' }}>
              {f.nombre}
              <span style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}> · por {UNIDAD[f.unidad] || f.unidad}</span>
            </span>
            <span style={{ fontSize: '16px', fontWeight: 500, textAlign: 'right',
                           fontVariantNumeric: 'tabular-nums' }}>
              {f.precio ? dinero(f.precio.precio_unitario) : <span style={{ fontSize: '13px', color: '#BA7517' }}>sin precio</span>}
            </span>
            <span style={{ fontSize: '13px', color: GRIS }}>
              {f.precio ? corta(f.precio.vigente_desde) : '—'}
            </span>
            {esJefe ? (
              <button onClick={() => setEditando(editando === f.id ? null : f.id)}
                style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px',
                         padding: '7px 13px', fontFamily: 'inherit', fontSize: '13px',
                         color: NAVY, cursor: 'pointer' }}>
                {editando === f.id ? 'Cancelar' : 'Cambiar'}
              </button>
            ) : <span />}
          </div>
          {editando === f.id && (
            <Forma actual={f} onGuardar={guardarPrecio} />
          )}
        </div>
      ))}
    </div>
  )
}

function Forma({ actual, onGuardar }) {
  const [nuevo, setNuevo] = useState(actual.precio ? String(actual.precio.precio_unitario) : '')
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const v = num(nuevo)
  const anterior = actual.precio ? Number(actual.precio.precio_unitario) : null
  const cambio = v && v !== anterior

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>
            Precio nuevo por {UNIDAD[actual.unidad] || actual.unidad}
          </div>
          <input inputMode="decimal" value={nuevo} onChange={e => setNuevo(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '15px', fontFamily: 'inherit', width: '140px',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right',
                     fontVariantNumeric: 'tabular-nums' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Rige desde</div>
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px' }} />
        </div>
        <button disabled={!cambio || enviando}
          onClick={async () => { setEnviando(true)
            await onGuardar({ insumoId: actual.id, nuevo: v, desde }); setEnviando(false) }}
          style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px',
                   padding: '10px 20px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                   cursor: (!cambio || enviando) ? 'default' : 'pointer',
                   opacity: (!cambio || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Guardando...' : 'Aplicar'}
        </button>
      </div>
      {cambio && anterior !== null && (
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '11px' }}>
          {v > anterior ? 'Sube' : 'Baja'}{' '}
          <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(Math.abs(v - anterior))}</b>.
          Lo registrado antes del {corta(desde)} no cambia.
        </div>
      )}
    </div>
  )
}

function exportar(filas) {
  const cab = ['Insumo', 'Unidad', 'Precio', 'Vigente desde']
  const rows = filas.map(f => [
    f.nombre, UNIDAD[f.unidad] || f.unidad,
    f.precio ? f.precio.precio_unitario : '',
    f.precio ? f.precio.vigente_desde : '',
  ])
  const csv = [cab, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'precios_insumos.csv'; a.click()
  URL.revokeObjectURL(url)
}

function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
