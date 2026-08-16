// Helpers de fecha compartidos por todo el modulo.
// La semana es de lunes a domingo, como en el Excel.

export const DIAS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
export const DIAS_CORTOS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb']
export const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
export const MESES_CORTOS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']

export const LIBRAS_POR_SACO = 55

// Una fecha ISO se convierte a mediodia para que ningun huso horario
// la corra un dia hacia atras.
export const aFecha = iso => new Date(iso + 'T12:00:00')

export const aISO = d =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

export const hoyISO = () => aISO(new Date())

export function lunesDe(iso) {
  const d = aFecha(iso)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return aISO(d)
}

export function sumarDias(iso, n) {
  const d = aFecha(iso)
  d.setDate(d.getDate() + n)
  return aISO(d)
}

// Los siete dias de la semana que contiene esa fecha.
export function semanaDe(iso) {
  const lun = lunesDe(iso)
  return Array.from({ length: 7 }, (_, i) => sumarDias(lun, i))
}

export const corta = iso => {
  const d = aFecha(iso)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}

export const cortita = iso => {
  const d = aFecha(iso)
  return `${d.getDate()} ${MESES_CORTOS[d.getMonth()]}`
}

export const nombreDia = iso => DIAS[aFecha(iso).getDay()]

export const tituloLargo = iso => {
  const d = aFecha(iso)
  return `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]}`
}

// Miercoles y domingo. Regla 6.
export const esDiaDeMuestreo = iso => {
  const d = aFecha(iso).getDay()
  return d === 0 || d === 3
}

export function diasCultivo(fechaSiembra, iso) {
  return Math.floor((aFecha(iso) - aFecha(fechaSiembra)) / 86400000) + 1
}

// Semana ISO, la misma que usa la base para semana_cerrada.
export function semanaISO(iso) {
  const d = aFecha(iso)
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dia = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dia)
  const inicio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return { anio: t.getUTCFullYear(), semana: Math.ceil(((t - inicio) / 86400000 + 1) / 7) }
}

// Regla 2.4: un dia futuro no se evalua nunca.
export function situacionDia(iso, hoy = hoyISO()) {
  if (iso > hoy) return 'futuro'
  if (iso === hoy) return 'hoy'
  return 'pasado'
}

export const num = v => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export const miles = n =>
  (n === null || n === undefined || n === '') ? '' : Math.round(n).toLocaleString('es-EC')

export const dinero = n =>
  (n === null || n === undefined) ? '' :
  '$' + Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
