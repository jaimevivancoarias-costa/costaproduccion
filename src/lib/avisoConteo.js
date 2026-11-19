import { supabase } from './supabase'
import { corta } from './fechas'

// Aviso al registrar algo con fecha ANTERIOR a un conteo ya hecho (decisión Melany
// 19-nov, opción A: "el conteo es la foto real"). Caso TERMINATE Oceanmarket: el 11/11
// se cargó un consumo del 16/10 después del conteo del 10/11 que había cuadrado →
// el cierre mostró un sobrante (+$20). No se bloquea (a veces es una corrección
// válida); se pregunta antes de guardar.
//   tipo: 'bal' (alimentación / guías de balanceado) | 'ins' (consumos / guías de insumos)
//   mismoDia: true para guías (una guía del mismo día del conteo también lo descuadra)
// Devuelve true si se puede guardar.
export async function confirmarAntesDeConteo({ fincaId, tipo, fechas, mismoDia = false }) {
  const fs = [...new Set((fechas || []).filter(Boolean))].sort()
  if (!fincaId || !fs.length) return true
  const min = fs[0]
  const tabla = tipo === 'bal' ? 'toma_balanceado' : 'toma_inventario'
  let q = supabase.schema('produccion').from(tabla).select('fecha').eq('finca_id', fincaId).eq('es_inicial', false)
  q = mismoDia ? q.gte('fecha', min) : q.gt('fecha', min)
  const { data, error } = await q.order('fecha', { ascending: false }).limit(1)
  if (error || !data?.length) return true
  return window.confirm(
    `Ojo: estás registrando con fecha ${corta(min)}, ${mismoDia ? 'igual o ' : ''}anterior al conteo del ${corta(data[0].fecha)}.\n\n` +
    'Ese conteo ya se hizo con lo que había en la bodega. Si guardas, el sistema va a mostrar ' +
    'la diferencia como sobrante o faltante en el cierre del mes.\n\n¿Guardar igual?')
}
