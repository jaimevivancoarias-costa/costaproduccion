# CostaProducción — Plan de correcciones (auditoría 360)

> **Para el agente (Claude Code):** este archivo es el TODO priorizado tras una
> auditoría de la app en vivo (https://costaproduccion.vercel.app). Trabájalo de
> arriba hacia abajo. No saltes a P1 hasta cerrar P0. Antes de tocar código de un
> módulo, ubícalo en el repo (busca por el texto visible de la pantalla) y confirma
> la fuente de datos real.

---

## Contexto de la app
- App de **operación + bodega** de camaroneras. 11 fincas (~110–160 piscinas), 2 zonas (Jambelí / Puná).
- Stack asumido: **Next.js + Supabase**. Confirmar en el repo.
- Menú (10 ítems): Presupuesto · Resumen · Registro diario · Diesel · Gramaje · Inventario · Catálogo · Costos · Reportes · Historial.
- Ya existen **roles + aprobaciones** (bandeja "Correcciones por aprobar") y usuarios (gerencia, contadoras, bodegueros). No reconstruir eso: reutilizarlo.

## Suposiciones a confirmar antes de empezar (bloqueantes ligeros)
- [ ] Stack real (Next.js + Supabase) y si el repo es solo de CostaProducción o el monorepo del Hub.
- [ ] La BD ya guarda: área, fecha siembra, días, gramaje real, consumo semanal/acumulado, **larva sembrada**, densidad. Confirmar si guarda **peso de PL al sembrar** (lo necesita el motor de la Fase 2).
- [ ] Unidad real de los insumos tipo PERCARBONATO (ver P0-2).

## Convenciones globales (aplican a TODA la app)
- [ ] **Semáforo único de color:** definir tokens `ok / alerta / critico` (verde/ámbar/rojo) y usarlos igual en todas las pantallas. Rojo = fuera de rango / sobre presupuesto, SIEMPRE lo mismo.
- [ ] **Diseño por excepción:** lo que está bien se ve tranquilo; solo resalta lo que se sale de lo normal.
- [ ] **Sin promedios ciegos:** todo promedio (finca) debe poder abrirse a piscina.

---

## P0 · Bugs de dato — PRIMERO (matan la confianza en el número)

- [ ] **P0-1 · Ceros ambiguos en Resumen.** Fincas en `$0,00 / 0 sacos` no distinguen "no consumió" de "nadie registró".
  - Fix: diferenciar visualmente *sin registro* vs *0 real*; mostrar días sin llenar.
  - Hecho cuando: una finca sin datos se ve distinta a una en cero real, y no se lee como "verde/ok".

- [ ] **P0-2 · Densidad imposible en Gramaje.** Ej.: Piscina 4 = `835.821/ha` (resto ~200–244 mil).
  - Fix: validar rango de densidad al calcular/mostrar; marcar en rojo lo imposible.
  - Hecho cuando: valores fuera de rango salen marcados y no contaminan promedios.

- [ ] **P0-3 · PERCARBONATO 400.000 kg** (Presupuesto/Insumos). Unidad o dato sospechoso.
  - Fix: confirmar unidad correcta; agregar validación de magnitud por insumo.
  - Hecho cuando: la cantidad refleja la unidad real y hay guardas contra magnitudes absurdas.

- [ ] **P0-4 · Bug cosecha/reabrir en Historial.** Evento de cosecha DUPLICADO (Piscina 5, 17:05 y 16:47) + ciclo "abierto el **?**" (fecha nula) tras cerrarse.
  - Fix: revisar el flujo de cosecha + reapertura de ciclo; evitar evento duplicado y fecha nula.
  - Hecho cuando: cerrar y reabrir un ciclo no duplica eventos ni deja fechas nulas.

- [x] **P0-5 · Orden del Historial no cronológico** (21:19 aparece bajo 06:08).
  - Fix: ordenar estrictamente por timestamp desc.
  - Hecho cuando: la bitácora queda en orden real de tiempo.

- [ ] **P0-6 · Finca `PRUEBA` en producción.** Aparece en el selector de Jambelí.
  - Fix: excluirla del selector y de todo reporte (flag oculto / sandbox), sin borrar histórico.

- [ ] **P0-7 · Nombre inconsistente `MAREXSPORT` vs `Marexport`.**
  - Fix: unificar a un nombre canónico (una sola fuente) en BD y UI.

---

## P1 · Resumen → auditor de verdad
> Regla de oro: la vista de arriba responde "¿a qué finca entro hoy?" sin pensar;
> el doble clic responde "¿por qué y qué hago?".

- [ ] **P1-1 · Costo/lb por finca** en la tabla, comparado vs presupuesto/ideal (LIMONVER como piso). No solo $ gastado.
- [ ] **P1-2 · Semáforo** por finca (usar tokens globales). Verde tranquilo, rojo arriba.
- [ ] **P1-3 · Ordenar por severidad**, no alfabético (la finca que arde, primero).
- [ ] **P1-4 · Jerarquía:** una sola cosa que grita (la finca del día) + KPIs de apoyo. Colapsar las fincas en verde.
- [ ] **P1-5 · Doble clic a piscina:** las filas deben bajar al detalle por piscina (hoy no hacen nada).
- [ ] **P1-6 · Señales operativas mínimas** además de plata: crecimiento bajo, sobrevivencia, días de cultivo.
- [ ] **P1-7 · Alerta de balanceado por agotarse** (días de inventario) + **% de presupuesto de insumos** por finca.
- [ ] **P1-8 · Vista "Hoy"** (la regla de oro es sobre HOY; hoy la granularidad mínima es semana).

---

## P2 · Costos (detalle que esconde el promedio)
- [ ] **P2-1 · Columna `$/lb` por piscina** en la tabla de Costos (hoy muestra $ total). Ordenar por $/lb, no por gasto.
  - Hecho cuando: se puede ver la piscina cara aunque la finca tenga buen promedio.

---

## P3 · Optimizaciones por módulo
- [ ] **P3-1 · Presupuesto:** alerta de proyección "vas a pasarte antes de fin de mes" (no solo % actual).
- [ ] **P3-2 · Registro diario:** marcar en la grilla piscinas **sin registrar hoy** (excepción), no solo contar "completadas". Verificar "Piscinas activas 28" en Austromar (¿incluye precrías?).
- [ ] **P3-3 · Gramaje:** semáforo de crecimiento bajo por piscina.
- [ ] **P3-4 · Inventario:** agregar **saldo de balanceado** (sacos por tipo) + días restantes / alerta de agotamiento. Hoy solo cubre insumos.
- [ ] **P3-5 · Catálogo:** arreglar panel de detalle que se queda en "Cargando…". Depurar balanceados vigentes (dejar agregar nuevos).
- [ ] **P3-6 · Reportes:** revisar/avisar **ciclos "(abierto)" viejos** (>1 mes) que nunca se cerraron.
- [ ] **P3-7 · Diesel:** cuadrar saldo/presupuesto finca (10.000/14.000 gal) vs grupo (70.900 gal).

---

## P4 · Transversales (UX / plomería)
- [ ] **P4-1 · Badges de tipo pegados al nombre** ("insumo", "diesel") en Presupuesto/Diesel/Inventario → fix global (separación o quitar).
- [ ] **P4-2 · Routing por URL:** cada vista con su ruta; hoy recargar en `/resumen` tira 404 crudo de Vercel. Agregar 404 con marca de la app.
- [ ] **P4-3 · Nav responde al primer clic** (hoy tarda un tick / a veces no cambia).
- [ ] **P4-4 · Copy:** arreglar "del [x] **a** [y]" (la "a" suelta) y textos sueltos.
- [ ] **P4-5 · Móvil / responsive:** contadoras y bodegueros llenan desde el teléfono → pasada responsive a Registro diario, Inventario y Gramaje.
- [ ] **P4-6 · Consistencia de hectáreas** entre módulos (una sola fuente de verdad).

---

## Fase 2 · Motor de estimación (DESPUÉS de estabilizar lo de arriba)
> Reimplementar la lógica del Excel `Estimacion_costamarket` contra la BD (NO arrastrar el Excel,
> que trae ~1.500 errores #REF!/#DIV/0!). Construir modular para poder graduarlo a tile propia del Hub.
- [ ] Definir "un cerebro, tres puertas" (gerencia = tablero+calculadora; jefes de finca = plan de su finca; bodegueros = pedido) reutilizando roles/aprobaciones existentes.
- [ ] Motor: biomasa (promedio 2 semanas) → días a meta → escenario BAJO/MEDIO/ALTO → sacos/día, FCR, lb/ha, utilidad.
- [ ] **PEDIDO** semanal de sacos por finca (output más accionable; jubila el Excel más rápido).
- [ ] **Calculadora** por piscina (utilidad si llega a la meta) como el "doble clic" de P1-5.
- [ ] Parámetros editables por finca (costo ha/día, larva/millar, gramaje meta, meta lb/ha, semanas a promediar).
- [ ] Precio de camarón entero/cola: entrada manual (banda por dispersión).
- [ ] Calibrar el "crédito de PL" con 2–3 ciclos (hoy marca de más "muy atrasadas").

---

## Preguntas abiertas para Mel
- [ ] ¿Confirmamos 110 vs ~160 piscinas? (cuadrar conteo)
- [ ] ¿La BD guarda peso de PL al sembrar? (necesario para el crédito de PL)
- [ ] ¿El motor va como sección con rol (dentro) o tile propia del Hub? (definir antes de Fase 2)
