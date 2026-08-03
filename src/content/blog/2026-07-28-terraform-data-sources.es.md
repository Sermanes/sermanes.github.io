---
title: 'Data sources en Terraform'
description: 'Qué es un data source en Terraform, cómo funciona internamente su lectura (plan o apply) y por qué a veces hace falta un depends_on explícito.'
pubDate: 2026-07-28T12:00:00
tags: ['terraform', 'iac', 'data-sources']
---

En el [post anterior](/blog/infraestructura-mutable-vs-inmutable/) vimos el bloque `lifecycle` y por qué Terraform reemplaza recursos en vez de modificarlos. Este post va sobre algo distinto: cómo leer, con el bloque `data`, información que Terraform no gestiona.

## Qué es un data source

Todos los labs anteriores parten de recursos que Terraform crea y controla de principio a fin: los declaras, aparecen en el state, y si los borras del `.tf` Terraform los destruye. Pero no todo lo que necesitas en una configuración lo ha creado Terraform. Puede ser un fichero que escribió otra persona a mano, un bucket que provisionó otro equipo, o el resultado de un script que corre fuera del `apply`.

Un `data` block lee ese tipo de información sin pretender gestionarla. Se parece a un `resource` en la sintaxis, pero no crea ni destruye nada: solo consulta y expone los atributos que devuelve, para poder usarlos en el resto de la configuración.

```hcl
data "local_file" "manual_note" {
  filename = "${path.module}/external/office-notice.txt"
}
```

`external/office-notice.txt` no lo crea Terraform, es un fichero que ya existe en el repo antes de ejecutar nada. `data.local_file.manual_note.content` expone su contenido para usarlo donde haga falta, por ejemplo en un `local_file` normal:

```hcl
resource "random_pet" "office" {
  length    = 2
  separator = "-"
}

resource "local_file" "notice" {
  filename = "${path.module}/notice.txt"
  content  = "${data.local_file.manual_note.content}\nOffice pet of the month: ${random_pet.office.id}"
}
```

## Cómo funciona la lectura: plan o apply

`data.local_file.manual_note` no depende de ningún recurso, así que Terraform puede leerlo en cuanto arranca el `plan`, antes incluso de refrescar el resto del state:

```console
$ terraform plan
data.local_file.manual_note: Reading...
data.local_file.manual_note: Read complete after 0s [id=851aa948bd3298e2b35bb52de6520c2c5994b02c]
random_pet.office: Refreshing state... [id=workable-serval]
local_file.notice: Refreshing state... [id=3c1ff6d0c2cbb035871b37f6fbc7c14b8c3323ec]
null_resource.audit_log: Refreshing state... [id=4088150487710460202]
data.local_file.audit_entry: Reading...
data.local_file.audit_entry: Read complete after 0s [id=9f6eef55d5ecd61d632c2751227184d337ca97f7]

No changes. Your infrastructure matches the configuration.
```

Eso solo funciona si todos los argumentos del `data` block son valores que Terraform ya conoce sin necesidad de crear nada. Si alguno depende de un atributo que solo existe tras un `apply` (un id generado, una IP asignada al crear una instancia), Terraform no puede resolver el data source en el plan y aplaza la lectura hasta el apply. El lab tiene un segundo data source que fuerza justo ese caso, porque su ruta incluye el id que genera `random_pet`:

```hcl
data "local_file" "audit_entry" {
  filename   = "${path.module}/audit/audit-${random_pet.office.id}.log"
  depends_on = [null_resource.audit_log]
}
```

En un `plan` sobre infraestructura nueva, Terraform lo marca así:

```console
  # data.local_file.audit_entry will be read during apply
  # (config refers to values not yet known)
 <= data "local_file" "audit_entry" {
      + content  = (known after apply)
      + filename = (known after apply)
      + id       = (known after apply)
        # (6 unchanged attributes hidden)
    }
```

El comentario `(config refers to values not yet known)` es literal: la ruta no se puede calcular hasta que `random_pet.office` tenga un id, así que la lectura se pospone al apply, en el mismo punto en que Terraform resolvería cualquier otro valor pendiente.

## Cuándo hace falta `depends_on` en un data source

`null_resource.audit_log` simula algo que pasa fuera del grafo de dependencias de Terraform: un `local-exec` que escribe un fichero de auditoría cuando se crea el pet.

```hcl
resource "null_resource" "audit_log" {
  triggers = {
    pet = random_pet.office.id
  }

  provisioner "local-exec" {
    command = "mkdir -p ${path.module}/audit && printf 'audit entry for %s\\n' '${random_pet.office.id}' > ${path.module}/audit/audit-${random_pet.office.id}.log"
  }
}
```

La ruta del `data.local_file.audit_entry` ya incluye `random_pet.office.id`, así que Terraform sabe que tiene que esperar a que exista el pet. Lo que no puede deducir es que el fichero en sí lo escribe `null_resource.audit_log`: no hay ningún atributo de ese recurso en el `data` block, así que no hay dependencia implícita con él. Sin `depends_on`, Terraform empieza a leer el data source en paralelo con la creación del `null_resource`, y el fichero puede no existir todavía:

```console
$ terraform apply
random_pet.office: Creating...
random_pet.office: Creation complete after 0s [id=fancy-beetle]
data.local_file.audit_entry: Reading...
null_resource.audit_log: Creating...
null_resource.audit_log: Provisioning with 'local-exec'...
null_resource.audit_log (local-exec): Executing: ["/bin/sh" "-c" "mkdir -p ./audit && printf 'audit entry for %s\n' 'fancy-beetle' > ./audit/audit-fancy-beetle.log"]
local_file.notice: Creating...
null_resource.audit_log: Creation complete after 0s [id=6557584006655975306]
local_file.notice: Creation complete after 0s [id=c81deaa15b5acebe4672f1b3d9e587da0b781d41]

Error: Read local file data source error

  with data.local_file.audit_entry,
  on main.tf line 33, in data "local_file" "audit_entry":
  33: data "local_file" "audit_entry" {

The file at given path cannot be read.

Original Error: open ./audit/audit-fancy-beetle.log: no such file or
directory
```

`data.local_file.audit_entry: Reading...` arranca antes de que `null_resource.audit_log` termine de escribir el fichero. Añadiendo `depends_on = [null_resource.audit_log]` al data source, Terraform espera a que el `null_resource` esté completo antes de intentar la lectura:

```console
$ terraform apply
random_pet.office: Creating...
random_pet.office: Creation complete after 0s [id=workable-serval]
null_resource.audit_log: Creating...
null_resource.audit_log: Provisioning with 'local-exec'...
null_resource.audit_log (local-exec): Executing: ["/bin/sh" "-c" "mkdir -p ./audit && printf 'audit entry for %s\n' 'workable-serval' > ./audit/audit-workable-serval.log"]
local_file.notice: Creating...
null_resource.audit_log: Creation complete after 0s [id=4088150487710460202]
local_file.notice: Creation complete after 0s [id=3c1ff6d0c2cbb035871b37f6fbc7c14b8c3323ec]
data.local_file.audit_entry: Reading...
data.local_file.audit_entry: Read complete after 0s [id=9f6eef55d5ecd61d632c2751227184d337ca97f7]

Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
```

`depends_on` en un data source solo garantiza orden: que Terraform no intente la lectura hasta que el recurso del que depende haya terminado. No garantiza que lo que encuentre sea lo que esperas. Si el script del `null_resource` hubiera fallado en silencio o hubiera escrito el fichero vacío, `depends_on` no lo habría detectado; solo evita la carrera entre la escritura y la lectura. Úsalo solo en ese caso concreto: cuando el fichero o recurso que lee el data source lo crea otra cosa (un script, un `local-exec`) que no deja rastro en ningún atributo. Añadirlo sin necesidad esconde dependencias reales y hace el grafo más difícil de leer.

## En resumen

- `data` lee información que Terraform no gestiona; no crea ni destruye nada, solo expone atributos.
- Si todos los argumentos del data source son conocidos sin crear nada, Terraform lo lee en el plan, antes de refrescar el resto del state.
- Si algún argumento depende de un atributo que solo existe tras un apply, la lectura se pospone al apply.
- Referenciar un atributo en el data source basta para que Terraform infiera el orden; para depender de un efecto secundario sin atributo (un script, un `local-exec`) hace falta `depends_on` explícito.
- `depends_on` en un data source solo asegura orden, no que el resultado sea correcto.

El lab completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/08-data-sources`.
