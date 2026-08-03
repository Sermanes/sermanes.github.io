---
title: 'Provisioners en Terraform'
description: 'Qué hacen los provisioners de creación y de destrucción, qué pasa cuando fallan, y por qué HashiCorp los trata como último recurso frente a alternativas nativas de cada proveedor.'
pubDate: 2026-07-30T12:00:00
tags: ['terraform', 'iac', 'provisioners']
---

En el [post anterior](/blog/terraform-count-for-each/) vimos `count` y `for_each`. Este es distinto: en vez de un mecanismo para gestionar recursos, un provisioner ejecuta un comando cuando un recurso se crea o se destruye. HashiCorp recomienda usarlos solo cuando no queda otra opción, y merece la pena entender por qué antes de usarlos.

## Provisioner de creación

`provisioner "local-exec"` corre un comando en la máquina donde ejecutas Terraform (no en el recurso), justo después de crearlo:

```hcl
resource "null_resource" "bootstrap" {
  provisioner "local-exec" {
    command = "echo 'bootstrap started' > ${path.module}/bootstrap.log"
  }
}
```

```console
$ terraform apply
null_resource.bootstrap: Creating...
null_resource.bootstrap: Provisioning with 'local-exec'...
null_resource.bootstrap (local-exec): Executing: ["/bin/sh" "-c" "echo 'bootstrap started' > ./bootstrap.log"]
null_resource.bootstrap: Creation complete after 0s [id=8614855501740043963]

$ cat bootstrap.log
bootstrap started
```

`null_resource` no representa nada real, solo existe como sitio donde colgar el provisioner. En un caso real sería el `provisioner` dentro de un recurso de verdad, por ejemplo una instancia.

## Provisioner de destrucción

Con `when = destroy`, el comando corre justo antes de que Terraform destruya el recurso, no después de crearlo:

```hcl
resource "null_resource" "bootstrap" {
  provisioner "local-exec" {
    command = "echo 'bootstrap started' > ${path.module}/bootstrap.log"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "echo 'bootstrap torn down' > ${path.module}/bootstrap.log"
  }
}
```

```console
$ terraform destroy
null_resource.bootstrap: Destroying... [id=8614855501740043963]
null_resource.bootstrap: Provisioning with 'local-exec'...
null_resource.bootstrap (local-exec): Executing: ["/bin/sh" "-c" "echo 'bootstrap torn down' > ./bootstrap.log"]
null_resource.bootstrap: Destruction complete after 0s

$ cat bootstrap.log
bootstrap torn down
```

Tiene sentido para des-registrar algo de un sistema externo antes de que el recurso deje de existir, por ejemplo sacar una instancia de un balanceador antes de borrarla. El provisioner de destrucción solo se ejecuta con el recurso todavía presente en el state; si lo borras a mano del `.tf` y aplicas sin pasar por `destroy`, o el recurso ya está tainted por otra razón, no llega a correr.

## Qué pasa cuando falla

Por defecto, si el comando de un provisioner falla, Terraform marca el recurso como tainted y el `apply` termina en error:

```hcl
resource "null_resource" "flaky" {
  provisioner "local-exec" {
    command = "echo 'flaky ran' > ${path.module}/does-not-exist/flaky.log"
  }
}
```

```console
$ terraform apply
null_resource.flaky: Provisioning with 'local-exec'...
null_resource.flaky (local-exec): /bin/sh: can't create ./does-not-exist/flaky.log: nonexistent directory

Error: local-exec provisioner error

  with null_resource.flaky,
  on main.tf line 13, in resource "null_resource" "flaky":
  13:   provisioner "local-exec" {

Error running command 'echo 'flaky ran' > ./does-not-exist/flaky.log': exit
status 1. Output: /bin/sh: can't create ./does-not-exist/flaky.log:
nonexistent directory
```

El recurso en sí se creó bien, pero al quedar tainted el siguiente `plan` lo marca para reemplazo:

```console
$ terraform plan
  # null_resource.flaky is tainted, so must be replaced
-/+ resource "null_resource" "flaky" {
      ~ id = "5499867266902719923" -> (known after apply)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

Con `on_failure = continue`, el mismo fallo no interrumpe el apply, se registra y Terraform sigue:

```hcl
resource "null_resource" "flaky" {
  provisioner "local-exec" {
    on_failure = continue
    command    = "echo 'flaky ran' > ${path.module}/does-not-exist/flaky.log"
  }
}
```

```console
$ terraform apply
null_resource.flaky: Provisioning with 'local-exec'...
null_resource.flaky (local-exec): /bin/sh: can't create ./does-not-exist/flaky.log: nonexistent directory
null_resource.flaky: Creation complete after 0s [id=255365187768406900]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

`continue` tiene sentido para pasos que de verdad son opcionales, notificar a un sistema externo que puede estar caído sin que eso deba bloquear la infraestructura. Para cualquier cosa de la que dependa el resto de la configuración, el valor por defecto (`fail`) es el que evita que sigas adelante con algo a medias.

## Por qué son el último recurso

Terraform planea comparando el estado deseado con los atributos que conoce de cada recurso. Un provisioner puede ejecutar cualquier comando, un script, una llamada a otra herramienta, y eso queda fuera de lo que Terraform puede ver: no aparece en el plan, no queda registrado en el state y no hay forma de saber si el comando fue idempotente o si dejó el sistema en un estado intermedio si falla a medias.

`remote-exec` (el equivalente para ejecutar el comando dentro del propio recurso, no en la máquina que corre Terraform) añade otra capa: necesita un bloque `connection` con las credenciales y el modo de conectar, y ese acceso tiene que estar disponible en el momento exacto del apply. Si el recurso todavía no tiene red lista, o las credenciales solo se generan después, el provisioner falla por algo que no tiene que ver con lo que el script hace.

## La alternativa: funciones nativas del recurso

Casi todos los proveedores tienen ya una forma de pasar configuración inicial al crear el recurso, sin depender de una conexión posterior. En GCP, `google_compute_instance` acepta `metadata_startup_script`: el proveedor lo entrega como metadato de la instancia y el propio arranque de la VM lo ejecuta, sin que Terraform tenga que conectarse a nada.

```hcl
resource "google_compute_instance" "web" {
  name         = "web"
  machine_type = "e2-micro"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    network = "default"
  }

  metadata_startup_script = <<-EOF
    #!/bin/bash
    apt-get update
    apt-get install -y nginx
  EOF
}
```

`metadata_startup_script` es un atributo normal del recurso: Terraform lo ve en el plan como cualquier otro cambio, y si lo modificas, el diff te dice exactamente qué cambió en el script, algo que un `provisioner` nunca te da.

Para arranques que tardan minutos en instalar dependencias, mejor no depender de un script más grande sino no arrancar desde cero: construir una imagen con Packer que ya tenga el software instalado, y que la instancia solo tenga que arrancar desde esa imagen.

```hcl
resource "google_compute_instance" "web" {
  name         = "web"
  machine_type = "e2-micro"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "projects/my-project/global/images/web-nginx-v3"
    }
  }

  network_interface {
    network = "default"
  }
}
```

Ninguno de los dos ejemplos de GCP se aplica en el lab de este post (harían falta proyecto y credenciales), pero es la comparación que importa: `metadata_startup_script` sustituye al `provisioner` de creación para el caso típico, y una imagen ya construida sustituye al script para todo lo que se pueda precocinar de antemano.

## En resumen

- Un provisioner de creación corre tras crear el recurso, uno de destrucción corre justo antes de destruirlo; el de destrucción solo se ejecuta si el recurso sigue en el state en el momento del `destroy`.
- Por defecto un provisioner que falla marca el recurso como tainted y para el apply; `on_failure = continue` deja seguir, útil solo para pasos que de verdad son opcionales.
- Terraform no puede planear ni validar lo que hace un provisioner: puede ejecutar cualquier comando, y eso queda fuera del state.
- `remote-exec` añade la necesidad de un bloque `connection` con acceso disponible en el momento exacto del apply.
- Casi siempre hay una alternativa nativa del proveedor (`metadata_startup_script` en GCP) que Terraform sí puede ver en el plan, y para bootstraps pesados, una imagen ya construida con Packer.

El lab completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/10-provisioners`.
