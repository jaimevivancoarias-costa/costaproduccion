// Controles compartidos del rediseño de inventario: pestañas con subrayado,
// control segmentado, botón discreto y estilo de select. Una sola fuente para
// que los ajustes se propaguen a Balanceado, Insumos, Diesel e Ingresos.
const NAVY = '#022847', BORDE = '#dce6ef', GRIS = '#7d8fa0', AZUL = '#0D6CB0'

// Pestaña con subrayado (Bodega / Ingresos).
export function TabU({ children, on, onClick }) {
  return <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: '14px', background: 'none', cursor: 'pointer',
    color: on ? NAVY : GRIS, padding: '0 0 9px', border: 'none', borderBottom: '2px solid ' + (on ? AZUL : 'transparent'),
    fontWeight: on ? 600 : 400 }}>{children}</button>
}

// Control segmentado (p. ej. Cuánto hay | Qué se movió). opciones = [[valor, texto], ...]
export function Seg({ opciones, valor, onCambio }) {
  return <div style={{ display: 'inline-flex', background: '#f1f5f9', border: '1px solid ' + BORDE, borderRadius: '11px', padding: '3px' }}>
    {opciones.map(([val, txt]) => {
      const on = valor === val
      return <button key={val} onClick={() => onCambio(val)} style={{ fontFamily: 'inherit', fontSize: '13.5px',
        color: on ? NAVY : GRIS, padding: '7px 15px', borderRadius: '8px', border: 'none', cursor: 'pointer',
        background: on ? '#fff' : 'transparent', fontWeight: on ? 600 : 400,
        boxShadow: on ? '0 1px 2px rgba(12,39,66,.08)' : 'none' }}>{txt}</button>
    })}
  </div>
}

// Botón discreto (sin caja), para toggles como "Sin inventario (N)".
export function GhostBtn({ children, on, onClick }) {
  return <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: '13px', color: on ? AZUL : GRIS,
    background: 'none', border: 'none', cursor: 'pointer', padding: '6px 4px', fontWeight: on ? 600 : 400 }}>{children}</button>
}

// Estilo de select/filtro del toolbar.
export const selChip = { padding: '9px 13px', fontSize: '13.5px', fontFamily: 'inherit', border: '1px solid ' + BORDE,
  borderRadius: '10px', boxSizing: 'border-box', background: 'white', color: NAVY }
