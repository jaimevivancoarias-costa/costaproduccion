import { useState } from 'react'
import { corta, dinero } from '../lib/fechas'

// Tarjeta "Dado de baja": lista las bajas (robo/merma/rotura/daño) de la
// bodega — fecha, ítem, cuánto, motivo, quién la registró y cuándo, el $
// perdido (FIFO) y con cuánto queda el ítem. Colapsable, nace cerrada.
// Se usa en balanceado, insumos y diesel, en "Cuánto hay" y "Qué se movió".
const NAVY = '#022847', GRIS = '#7d8fa0', BORDE = '#dce6ef'
const COL_MOTIVO = { Robo: '#B3261E', Merma: '#854F0B', Rotura: '#0D6CB0', 'Daño': '#3f8fce', Otro: '#7d8fa0' }
const colMotivo = m => COL_MOTIVO[m] || '#9fb0bf'

// rows: [{ id, fecha, item, cantTxt, motivo, autor, registrada, perdido, quedaTxt }]
export default function TarjetaBajas({ rows, esJefe }) {
  const [abierto, setAbierto] = useState(false)
  if (!rows || !rows.length) return null
  const GRID = esJefe
    ? '92px 1.4fr 120px 88px 1.1fr 110px 120px'
    : '92px 1.4fr 120px 88px 1.1fr 120px'
  const cab = { fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em' }
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', marginBottom: '16px', overflow: 'hidden' }}>
      <button onClick={() => setAbierto(a => !a)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none',
                 cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', padding: '13px 16px' }}>
        <span style={{ color: GRIS, fontSize: '12px' }}>{abierto ? '▾' : '▸'}</span>
        <span style={{ fontSize: '14px', fontWeight: 600, color: NAVY }}>Dado de baja</span>
        <span style={{ fontSize: '11px', fontWeight: 700, borderRadius: '20px', padding: '2px 9px',
                       background: '#FBEAEA', color: '#B3261E' }}>{rows.length}</span>
      </button>
      {abierto && (
        <div style={{ borderTop: '0.5px solid ' + BORDE }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '10px 16px',
                        background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
            <span style={cab}>Fecha</span>
            <span style={cab}>Ítem</span>
            <span style={{ ...cab, textAlign: 'right' }}>Cantidad</span>
            <span style={cab}>Motivo</span>
            <span style={cab}>Registró</span>
            {esJefe && <span style={{ ...cab, textAlign: 'right' }}>Perdido</span>}
            <span style={{ ...cab, textAlign: 'right' }}>Queda</span>
          </div>
          {rows.map(r => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: '12px', padding: '11px 16px',
                    alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
              <span style={{ color: GRIS }}>{corta(r.fecha)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.item}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{r.cantTxt}</span>
              <span>
                <span style={{ fontSize: '11.5px', fontWeight: 500, color: colMotivo(r.motivo),
                      background: colMotivo(r.motivo) + '18', padding: '2px 8px', borderRadius: '20px' }}>{r.motivo}</span>
              </span>
              <span style={{ fontSize: '12px', color: GRIS, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.autor || '—'}{r.registrada ? <span style={{ color: '#a7b4c1' }}> · {corta(String(r.registrada).slice(0, 10))}</span> : null}
              </span>
              {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{dinero(r.perdido)}</span>}
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{r.quedaTxt}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
