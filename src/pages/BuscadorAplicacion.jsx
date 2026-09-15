// Filtro del Registro diario: deja en la MISMA cuadrícula solo las
// piscinas (y resalta los días) donde se aplicó el producto elegido, para
// corregir ahí mismo. No arma otra tabla.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export default function FiltroProducto({ ambito, opciones, valor, onCambio, nPisc }) {
  const label = ambito === 'balanceado' ? 'balanceado' : 'insumo'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '13px', color: GRIS }}>Ver solo piscinas que aplicaron un {label}:</span>
      <select value={valor} onChange={e => onCambio(e.target.value)}
        style={{ padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
                 borderRadius: '9px', background: 'white', color: NAVY, minWidth: '220px' }}>
        <option value="">Todas las piscinas</option>
        {opciones.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
      </select>
      {valor && (
        <>
          <span style={{ fontSize: '12px', color: GRIS }}>
            {nPisc === 0 ? 'Ninguna esta semana' : `${nPisc} piscina${nPisc === 1 ? '' : 's'} esta semana`}
          </span>
          <button onClick={() => onCambio('')} style={{ border: 'none', background: 'none', color: AZUL,
            fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', padding: 0 }}>Quitar filtro</button>
        </>
      )}
    </div>
  )
}
