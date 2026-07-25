---
title: 'Infraestructura mutable vs. inmutable, y lifecycle en Terraform'
description: 'Qué diferencia a un despliegue mutable de uno inmutable, por qué Terraform reemplaza recursos por defecto en vez de modificarlos, y cómo cambiar ese comportamiento con create_before_destroy, prevent_destroy e ignore_changes.'
pubDate: 2026-07-25T12:00:00
tags: ['terraform', 'iac', 'lifecycle', 'buenas-practicas']
---

En el [post anterior](/blog/terraform-commands/) vimos los comandos de la CLI. Este vuelve a los bloques de configuración, y explica algo que ha aparecido en cada lab sin que lo detalláramos: por qué Terraform, casi siempre, destruye un recurso y crea uno nuevo en vez de actualizarlo sin recrearlo.

## Infraestructura mutable

Un servidor con PostgreSQL 14 al que un día actualizas a la 15, y más adelante a la 16, sin sustituir la máquina, es infraestructura mutable: el mismo servidor va cambiando de estado con el tiempo. La actualización puede hacerse a mano en una ventana de mantenimiento o con una herramienta de gestión de configuración como Ansible, pero en ambos casos el servidor sigue siendo el mismo antes y después.

Si tienes varios servidores detrás de un balanceador y actualizas cada uno por separado, el riesgo habitual es que alguno se quede a medias: un problema de red, de espacio en disco, o una dependencia que no está donde el script espera. Ese servidor se queda en la versión anterior mientras los demás se actualizan. Con el tiempo, y tras varias rondas de actualizaciones, acabas con un grupo de servidores que deberían ser idénticos pero no lo son. A eso se le llama **configuration drift**, y cuanto más tarda en detectarse, más cuesta averiguar qué servidor tiene qué versión de qué.

## Infraestructura inmutable

La alternativa es no tocar nunca un servidor ya desplegado. Para pasar de PostgreSQL 14 a 15 se crean servidores nuevos con la 15, se comprueba que funcionan, y solo entonces se retiran los antiguos. Si algo sale mal, los servidores viejos siguen ahí sin haber sido tocados.

Esto no elimina el drift, lo hace más difícil de producir: no hay ventana en la que un servidor a medio actualizar conviva con el resto. O el servidor nuevo se creó bien, con la versión que tocaba, o no se creó y el viejo sigue sirviendo tráfico. También hace más simple volver atrás: si la 15 da problemas, vuelves a apuntar el tráfico a los servidores con la 14 en vez de intentar deshacer una actualización a medias.

## Terraform reemplaza por defecto

Terraform sigue el modelo inmutable salvo que el proveedor pueda actualizar el recurso sin recrearlo. El lab de este post parte de un `random_pet` y un `local_file` cuyo contenido referencia el nombre generado por el primero (la misma dependencia implícita del [post de atributos y outputs](/blog/terraform-resource-attributes-outputs/)):

```hcl
resource "random_pet" "office" {
  length    = 2
  separator = "_"
}

resource "local_file" "notice" {
  filename = "${path.module}/notice.txt"
  content  = "Office pet of the month: ${random_pet.office.id}"
}
```

`separator` no se puede cambiar en un `random_pet` ya creado, así que un cambio ahí fuerza un reemplazo. Y como `local_file.notice` depende del nombre del pet, el reemplazo se propaga:

```console
$ terraform apply
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # local_file.notice must be replaced
-/+ resource "local_file" "notice" {
      ~ content              = "Office pet of the month: optimum_colt" -> (known after apply) # forces replacement
      ~ id                   = "8b716eaf9955c51228fcc9acecce0f57b50c3c0c" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

  # random_pet.office must be replaced
-/+ resource "random_pet" "office" {
      ~ id        = "optimum_colt" -> (known after apply)
      ~ separator = "_" -> "-" # forces replacement
        # (1 unchanged attribute hidden)
    }

Plan: 2 to add, 0 to change, 2 to destroy.
local_file.notice: Destroying... [id=8b716eaf9955c51228fcc9acecce0f57b50c3c0c]
local_file.notice: Destruction complete after 0s
random_pet.office: Destroying... [id=optimum_colt]
random_pet.office: Destruction complete after 0s
random_pet.office: Creating...
random_pet.office: Creation complete after 0s [id=pet-tomcat]
local_file.notice: Creating...
local_file.notice: Creation complete after 0s [id=38cb0f5caf4afdec009e54b9e05902601e10aa87]

Apply complete! Resources: 2 added, 0 changed, 2 destroyed.
```

El plan marca `# forces replacement` junto a cada atributo responsable. No todos los cambios fuerzan un reemplazo: la mayoría de atributos se actualizan sin recrear el recurso (`~` sin `-/+`), y cuáles concretamente dependen de qué soporte el proveedor, no de una regla general de Terraform. Eso se documenta atributo por atributo en cada proveedor.

## Cuando el comportamiento por defecto no vale

Reemplazar por defecto está bien la mayoría de las veces, pero hay recursos donde eso es justo lo que no quieres: una base de datos que no puede desaparecer aunque sea un instante, o un recurso que no debería poder borrarse por accidente. El bloque `lifecycle` cambia ese comportamiento por defecto para un recurso concreto.

### `create_before_destroy`

Con el orden por defecto (destruir, luego crear) hay una ventana sin el recurso. `create_before_destroy` invierte el orden: primero crea el reemplazo, y solo cuando existe destruye el original.

```hcl
resource "local_file" "notice" {
  filename        = "${path.module}/notice.txt"
  content         = "Office pet of the month: ${random_pet.office.id}"
  file_permission = "0600"

  lifecycle {
    create_before_destroy = true
  }
}
```

Con esta regla activa, un cambio de permiso da un plan distinto: `+/- create replacement and then destroy`, en vez de `-/+`. El orden de las acciones en el output también cambia, primero `Creating...`, luego `Destroying...` del objeto antiguo, que en este punto Terraform llama deposed porque ya no es el recurso activo, es la copia vieja pendiente de eliminar:

```console
$ terraform apply
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
+/- create replacement and then destroy

Terraform will perform the following actions:

  # local_file.notice must be replaced
+/- resource "local_file" "notice" {
      ~ file_permission      = "0644" -> "0600" # forces replacement
      ~ id                   = "38cb0f5caf4afdec009e54b9e05902601e10aa87" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
local_file.notice: Creating...
local_file.notice: Creation complete after 0s [id=38cb0f5caf4afdec009e54b9e05902601e10aa87]
local_file.notice (deposed object e81c538f): Destroying... [id=38cb0f5caf4afdec009e54b9e05902601e10aa87]
local_file.notice: Destruction complete after 0s

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

En este lab funciona sin más porque un fichero local se puede sobrescribir en la misma ruta. En muchos recursos de la nube el problema es otro: si el nombre tiene que ser único (un bucket de GCS, por ejemplo), no puedes crear el nuevo con el mismo nombre mientras el viejo sigue vivo. La solución habitual es que el nombre incluya algo que cambie en cada reemplazo, un sufijo aleatorio o un hash del contenido, para que ambos puedan coexistir el tiempo que dura el `apply`.

### `prevent_destroy`

Bloquea cualquier plan que implique destruir el recurso, tanto si viene de un `terraform destroy` como si viene de un cambio que fuerza reemplazo.

```hcl
resource "random_pet" "office" {
  length    = 2
  separator = "-"

  lifecycle {
    prevent_destroy = true
  }
}
```

```console
$ terraform destroy
random_pet.office: Refreshing state... [id=pet-tomcat]

Terraform planned the following actions, but then encountered a problem:

  # random_pet.office will be destroyed
  - resource "random_pet" "office" {
      - id        = "pet-tomcat" -> null
      - length    = 2 -> null
      - separator = "-" -> null
    }

Plan: 0 to add, 0 to change, 1 to destroy.

Error: Instance cannot be destroyed

  on main.tf line 1:
   1: resource "random_pet" "office" {

Resource random_pet.office has lifecycle.prevent_destroy set, but the plan
calls for this resource to be destroyed. To avoid this error and continue
with the plan, either disable lifecycle.prevent_destroy or reduce the scope
of the plan using the -target option.
```

La protección es de Terraform, no del proveedor: es Terraform negándose a generar el plan. Si alguien borra el recurso a mano desde la consola o la API del proveedor, `prevent_destroy` no lo evita ni se entera hasta el siguiente `plan`. Para quitarla de verdad hay que editar el `.tf` y quitar el bloque, y eso queda en el historial de git: quien borra algo protegido deja rastro de haberlo hecho.

### `ignore_changes`

Le dice a Terraform que ignore cambios en ciertos atributos al comparar el plan con la realidad. Es para atributos que otra cosa gestiona fuera de Terraform y que no quieres que Terraform intente revertir en cada `apply`; el caso típico es un grupo de autoescalado cuyo número de instancias sube y baja según la carga, mientras Terraform sigue gestionando el resto de la configuración:

```hcl
resource "google_compute_instance_group_manager" "app" {
  # ...
  target_size = 3

  lifecycle {
    ignore_changes = [target_size]
  }
}
```

Sin esta regla, cada `apply` volvería a fijar `target_size` a 3 y pelearía con el autoescalado. Con `ignore_changes = [target_size]`, Terraform sigue viendo y aplicando el resto de cambios del recurso, pero deja ese atributo tal y como esté en la infraestructura real.

## Otras piezas del bloque `lifecycle`

`create_before_destroy`, `prevent_destroy` e `ignore_changes` cubren la mayoría de casos, pero el bloque tiene más argumentos: `replace_triggered_by` fuerza el reemplazo de un recurso cuando cambia otro recurso o atributo del que depende, aunque su propia configuración no haya cambiado; `precondition` y `postcondition` comprueban condiciones antes y después de crear el recurso y hacen fallar el `apply` con un mensaje propio si no se cumplen. Quedan fuera de este post; están documentados en [la referencia oficial del bloque lifecycle](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle).

## En resumen

- Infraestructura mutable: el mismo servidor cambia de versión con el tiempo, con riesgo de drift si alguna actualización falla a medias.
- Infraestructura inmutable: nunca se modifica un recurso desplegado, se sustituye por uno nuevo y se retira el viejo solo cuando el nuevo ya funciona.
- Terraform reemplaza por defecto cuando el proveedor no puede actualizar el recurso sin recrearlo; el plan marca el atributo responsable con `# forces replacement`.
- `create_before_destroy` invierte el orden a crear-luego-destruir, para no pasar por una ventana sin el recurso; con nombres únicos hace falta que el nombre cambie en cada reemplazo.
- `prevent_destroy` hace fallar cualquier plan que destruya el recurso; no protege de cambios hechos fuera de Terraform.
- `ignore_changes` excluye atributos concretos de la comparación entre plan y realidad, para convivir con algo que los gestiona por fuera.

El lab completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/07-immutable-infra`.
