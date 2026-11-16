# Guía del módulo de Diésel — CostaProducción

El diésel se maneja en la sección **Diésel** del menú. Tiene dos partes:
**Registro** (ingresos y consumos) y **Bodega** (saldo, conteo, detalle por lote).
Los precios y proveedores se manejan en **Catálogo → Diésel**.

---

## Quién hace qué

- **Bodeguero:** registra los galones que llegan y que se consumen, y cuenta la
  bodega. **No ve precios.**
- **Jefe / contadora:** todo lo anterior, más los **precios**, los
  **proveedores** (catálogo), los **reportes** y las **correcciones**.

---

## Lo que hay que saber (para todos)

- Hay **dos tipos de diésel: B y Premium.** Cada uno es un **tanque aparte**.
- El diésel ahora viene de **varios proveedores.** Cada ingreso se registra
  **con su proveedor**.
- **Se gasta primero el más viejo que entró** (FIFO). Por eso en el consumo no
  se elige proveedor: el sistema toma del lote más antiguo.
- El **precio se congela en cada compra.** Corregir una compra **no cambia** las
  demás.

---

## PARA EL BODEGUERO (el día a día)

### 1) Registrar un ingreso (diésel que llega)
1. Diésel → **Registrar** → **+ Registrar ingreso**.
2. Elegí el **Tipo** (B o Premium).
3. Elegí el **Proveedor** (salen los que venden ese tipo). Si es uno nuevo,
   elegí **“+ Agregar proveedor”** y escribí el nombre.
4. Escribí los **galones**, la **fecha** y el **N° de guía**.
5. **Guardar.** (No ves el precio; lo maneja el jefe.)

### 2) Registrar un consumo (diésel que se gasta)
1. **Registrar consumo**.
2. Elegí el **Tipo**, los **galones** y la **fecha** → **Guardar**.
   *(No se elige proveedor: el sistema gasta el más viejo primero.)*

### 3) Contar la bodega
Bodega → **Contar la bodega** → poné los **galones físicos** de cada tipo →
**Guardar**. El sistema avisa si hay descuadre con lo que tenía registrado.

### 4) Si te equivocaste
En la **flechita** del registro → **Pedir corrección** (el jefe la aprueba) o
**Pedir borrado**.

---

## PARA EL JEFE / CONTADORA

### Catálogo de proveedores (Diésel → Catálogo)
Tiene dos pestañas:
- **Fincas:** qué paga **cada finca** por B y Premium, con el proveedor de cada
  precio. Botones **Editar** e **Historial** por precio.
- **Proveedores:** cada proveedor, **a qué fincas** le vende y **a qué precio**.
  Permite **Agregar**, **Editar** y **Eliminar** proveedor.

### Agregar un proveedor
Proveedores → **+ Agregar proveedor** → escribí el **nombre**, marcá las
**fincas** a las que vende y ponele el **precio** de cada una → **Crear**.

### Fijar precios (el cambio mensual)
Botón **Fijar precios** → elegí **proveedor** y **tipo** → marcá las fincas por
**grupos** (botones **Todas / Jambelí / Puná**, o una por una) y ponele el
**precio** a cada grupo → **rige desde** → **Guardar**.
*(Sirve para subir el precio del mes a muchas fincas de una sola vez.)*

### Corregir un precio que quedó mal
Fincas → **Editar** el precio → modo **“Corregir (estaba mal)”** → poné el
**precio correcto**. Esto **sobrescribe** el precio sin dejar historial y te
**pregunta si recostear** las compras que usaron el precio malo.
*(El otro modo, **“Cambio de precio”**, es para un precio nuevo que rige desde
una fecha y guarda el anterior en el historial.)*

### Eliminar un proveedor
Proveedores → **Editar** → **Eliminar**. Deja de verse, pero **los ingresos
viejos no se tocan**.

### El precio en el ingreso
Al registrar, el **precio sale solo** del catálogo del proveedor para esa finca
y **se congela** en la compra. El jefe lo puede ajustar en el formulario (eso
**no** cambia el catálogo; para cambiarlo a futuro, se edita en el catálogo).

### Bodega y reportes
- **Cuánto hay:** saldo y valor por tipo; el detalle por lote muestra el
  **proveedor** de cada compra.
- **Qué se movió:** dos tablas —
  **“Lo que queda en bodega”** (cantidad, precio y valor de lo que te sobra) y
  **“Entró en el rango”** (lo que entró, se consumió y queda, con su costo).
- **Descargar (PDF/Excel):** resumen por tipo + una tabla de **ingresos por
  proveedor** (fecha, tipo, proveedor, guía, galones, precio, valor).

---

## Preguntas frecuentes

**¿Por qué el “valor de lo que queda” no es igual al “costo consumido”?**
Son dos cosas distintas: una es lo que te **sobra** en bodega (stock), la otra es
lo que **quemaste** (gasto). No tienen que ser iguales.

**¿Qué es “Sin proveedor”?**
Son ingresos viejos que se cargaron sin proveedor. Se **conservan** así. Los
ingresos **nuevos** ya **exigen** proveedor.

**¿Puedo cambiarle el proveedor a un ingreso viejo?**
Sí: en la **flechita** del ingreso → **Editar** → elegí el proveedor.

**¿El consumo descuenta del proveedor correcto?**
El consumo descuenta del **tipo** (B o Premium) y toma el **lote más viejo**
primero. El costo sale del precio congelado de ese lote.
