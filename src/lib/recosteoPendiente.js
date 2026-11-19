import { supabase } from './supabase'

// Cola de recosteos (decisión Melany 19-nov): al cargar, corregir o borrar una guía con
// fecha ANTERIOR a hoy, la base anota qué producto recostear (tabla recosteo_pendiente).
// Aquí se procesa de a uno por llamada (cada recosteo tarda 1–8 s y la API corta a los 8 s),
// sin trabar el guardado. Se llama después de guardar guías y al abrir la app.
let corriendo = false
export async function procesarRecosteos(alTerminar) {
  if (corriendo) return
  corriendo = true
  let hizo = false
  try {
    for (let i = 0; i < 50; i++) {
      const { data, error } = await supabase.schema('produccion').rpc('fn_procesar_recosteo_pendiente')
      if (error) break
      hizo = true
      if (!data) break
    }
  } finally {
    corriendo = false
  }
  if (hizo && alTerminar) alTerminar()
}
