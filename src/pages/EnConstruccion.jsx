const NAVY = '#022847'
const GRIS = '#7d8fa0'
const BORDE = '#dce6ef'

const NOTAS = {
  resumen: 'Las nueve fincas con su consumo, costo y estado de la semana, más lo que necesita atención.',
  gramaje: 'El peso del camarón de miércoles y domingo. Solo se escribe el peso; el incremento y el crecimiento diario se calculan.',
  inventario: 'Saldo inicial, entradas recibidas, consumo calculado, ajustes y saldo final. El pedido no suma al saldo.',
  costos: 'Costo por producto y por piscina, con el costo por libra aplicada y el acumulado del ciclo.',
  historial: 'La bitácora de todo cambio sobre un día cerrado. No se puede editar ni borrar.',
}

export default function EnConstruccion({ modulo }) {
  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY,
                  maxWidth: '620px', margin: '0 auto', padding: '4rem 1.5rem' }}>
      <div style={{ border: '0.5px dashed ' + BORDE, borderRadius: '14px',
                    padding: '2.5rem 2rem', textAlign: 'center', background: 'white' }}>
        <div style={{ fontSize: '19px', fontWeight: 500, marginBottom: '8px' }}>{modulo.nombre}</div>
        <div style={{ fontSize: '14px', color: GRIS, lineHeight: 1.6 }}>
          {NOTAS[modulo.id]}
        </div>
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '1.5rem',
                      background: '#f7fafc', borderRadius: '8px', padding: '10px 14px', display: 'inline-block' }}>
          En construcción
        </div>
      </div>
    </div>
  )
}
