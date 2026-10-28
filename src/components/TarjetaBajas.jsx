import { useState } from 'react'
import { corta, dinero, miles } from '../lib/fechas'

// Tarjeta "Dado de baja": lista las bajas (robo/merma/rotura/daño) de la
// bodega — fecha, ítem, cuánto, motivo, quién la registró, el $ perdido y
// con cuánto queda el ítem. La flechita del $ despliega el desglose FIFO
// por lote (respaldo de a qué precio costó cada lote). Colapsable, nace
// cerrada. Se usa en balanceado, insumos y diesel, en ambas vistas.
const NAVY = '#022847', GRIS = '#7d8fa0', BORDE = '#dce6ef', AZUL = '#0D6CB0'
const COL_MOTIVO = { Robo: '#B3261E', Merma: '#854F0B', Rotura: '#0D6CB0', 'Daño': '#3f8fce', Otro: '#7d8fa0' }
const colMotivo = m => COL_MOTIVO[m] || '#9fb0bf'

// rows: [{ id, fecha, item, cantTxt, unidad, motivo, autor, perdido, quedaTxt, lotes? }]
//   lotes: [{ fecha, precio, qty }] desglose FIFO por lote (opcional)
export default function TarjetaBajas({ rows, esJefe }) {
  const [abierto, setAbierto] = useState(false)
  const [filaAb, setFilaAb] = useState({})
  if (!rows || !rows.length) return null
  const GRID = esJefe
    ? '96px 1.5fr 115px 130px 1fr 125px 115px'
    : '96px 1.5fr 115px 130px 1fr 115px'
  const cab = { fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em' }
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', marginBottom: '16px', overflow: 'hidden' }}>
      <button onClick={() => setAbierto(a => !a)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none',
                 cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', padding: '13px 16px' }}>
        <span style={{ color: GRIS, fontSize: '12px' }}>{abierto ? '▾' : '▸'}</span>
        <span style={{ fontSize: '14px', fontWeight: 600, color: NAVY }}>Dado de baja</span>
      </button>
      {abierto && (
        <div style={{ borderTop: '0.5px solid ' + BORDE }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '16px', padding: '10px 16px',
                        background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
            <span style={cab}>Fecha</span>
            <span style={cab}>Ítem</span>
            <span style={{ ...cab, textAlign: 'right' }}>Cantidad</span>
            <span style={cab}>Motivo</span>
            <span style={cab}>Registró</span>
            {esJefe && <span style={{ ...cab, textAlign: 'right' }}>Perdido</span>}
            <span style={{ ...cab, textAlign: 'right' }}>Queda</span>
          </div>
          {rows.map(r => {
            const hayLotes = esJefe && r.lotes && r.lotes.length > 0
            const ab = !!filaAb[r.id]
            const totQty = hayLotes ? r.lotes.reduce((t, l) => t + l.qty, 0) : 0
            return [
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: '16px', padding: '11px 16px',
                      alignItems: 'center', fontSize: '13px', borderBottom: ab ? 'none' : '0.5px solid #f1f6f9' }}>
                <span style={{ color: GRIS }}>{corta(r.fecha)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.item}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{r.cantTxt}</span>
                <span>
                  <span style={{ fontSize: '11.5px', fontWeight: 500, color: colMotivo(r.motivo),
                        background: colMotivo(r.motivo) + '18', padding: '2px 8px', borderRadius: '20px' }}>{r.motivo}</span>
                </span>
                <span style={{ fontSize: '12.5px', color: GRIS, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.autor || '—'}</span>
                {esJefe && (
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                    {hayLotes && (
                      <button onClick={() => setFilaAb(a => ({ ...a, [r.id]: !a[r.id] }))}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, fontSize: '9px', padding: 0, marginRight: '6px' }}>
                        {ab ? '▾' : '▸'}</button>
                    )}
                    {dinero(r.perdido)}
                  </span>
                )}
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{r.quedaTxt}</span>
              </div>,
              hayLotes && ab && (
                <div key={r.id + '-d'} style={{ background: '#f8fafc', borderBottom: '0.5px solid #f1f6f9', padding: '12px 16px 14px 42px' }}>
                  <div style={{ fontSize: '10.5px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '8px' }}>Desglose FIFO por lote</div>
                  {r.lotes.map((l, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '12px', alignItems: 'center',
                          fontSize: '12.5px', padding: '7px 0', borderBottom: '0.5px solid #eef3f7', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ color: NAVY }}>{l.fecha ? 'Lote del ' + corta(l.fecha) : 'Inventario inicial'}</span>
                      <span style={{ textAlign: 'right', color: GRIS }}>{miles(l.qty)}{r.unidad ? ' ' + r.unidad : ''} &times; {dinero(l.precio)}</span>
                      <span style={{ textAlign: 'right', fontWeight: 500, minWidth: '90px' }}>{dinero(l.precio * l.qty)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '12px', alignItems: 'center',
                        fontSize: '13px', padding: '9px 0 0', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: NAVY, fontWeight: 500 }}>Total</span>
                    <span style={{ textAlign: 'right', color: GRIS }}>{miles(totQty)}{r.unidad ? ' ' + r.unidad : ''}</span>
                    <span style={{ textAlign: 'right', fontWeight: 500, color: NAVY, minWidth: '90px' }}>{dinero(r.perdido)}</span>
                  </div>
                </div>
              ),
            ]
          })}
        </div>
      )}
    </div>
  )
}
