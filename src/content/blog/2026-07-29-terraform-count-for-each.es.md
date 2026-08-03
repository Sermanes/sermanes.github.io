---
title: 'count vs for_each en Terraform'
description: 'Diferencias entre los meta-argumentos count y for_each, cuándo usar cada uno, y el problema de count con listas indexadas.'
pubDate: 2026-07-29T12:00:00
tags: ['terraform', 'iac', 'meta-arguments']
---

En el [post anterior](/blog/terraform-data-sources/) vimos el bloque `data`. Este vuelve a los meta-argumentos que ya usamos sin explicarlos del todo: `count`, que aparece desde el primer lab creando un solo `random_pet`, y `for_each`, su alternativa para cuando la posición de un elemento no debería importar.

## count: recursos por índice

`count` crea N copias de un recurso. Cada copia se identifica por su posición, `count.index`, empezando en 0:

```hcl
variable "environments" {
  type    = list(string)
  default = ["dev", "staging", "prod"]
}

resource "local_file" "count_demo" {
  count = length(var.environments)

  filename = "${path.module}/generated/count-${var.environments[count.index]}.txt"
  content  = "Environment: ${var.environments[count.index]}"
}
```

`terraform apply` crea tres recursos, `count_demo[0]`, `count_demo[1]` y `count_demo[2]`, cada uno con el nombre de fichero que le toca por posición en la lista.

## El problema: quitar un elemento desplaza los índices

Si quitas `"dev"` de la lista, `count_demo[0]` deja de ser dev y pasa a ser staging, `count_demo[1]` deja de ser staging y pasa a ser prod, y `count_demo[2]` ya no tiene elemento correspondiente. Terraform no sabe que quitaste el primero: solo ve que el contenido y el nombre de fichero de los índices 0 y 1 cambiaron, y que el índice 2 sobra.

```console
$ terraform plan
  # local_file.count_demo[0] must be replaced
-/+ resource "local_file" "count_demo" {
      ~ content  = "Environment: dev" -> "Environment: staging" # forces replacement
      ~ filename = "./generated/count-dev.txt" -> "./generated/count-staging.txt" # forces replacement
        # (8 unchanged attributes hidden)
    }

  # local_file.count_demo[1] must be replaced
-/+ resource "local_file" "count_demo" {
      ~ content  = "Environment: staging" -> "Environment: prod" # forces replacement
      ~ filename = "./generated/count-staging.txt" -> "./generated/count-prod.txt" # forces replacement
        # (8 unchanged attributes hidden)
    }

  # local_file.count_demo[2] will be destroyed
  # (because index [2] is out of range for count)
  - resource "local_file" "count_demo" {
      - content  = "Environment: prod" -> null
      - filename = "./generated/count-prod.txt" -> null
        # (8 unchanged attributes hidden)
    }

Plan: 2 to add, 0 to change, 4 to destroy.
```

El único recurso que debería desaparecer es el de dev. En vez de eso, Terraform reemplaza staging y prod (destruye y vuelve a crear el fichero, aunque el contenido final sea el mismo que ya tenían) y además destruye un tercer recurso que ya no tiene índice. Con un `local_file` esto es inofensivo. Con una instancia de base de datos o un disco persistente indexado por `count`, quitar un elemento de en medio de la lista puede destruir infraestructura que no tenía nada que ver con el cambio.

## for_each: recursos por clave

`for_each` identifica cada instancia por una clave, no por una posición. Acepta un mapa o un set de strings, no una lista, así que si partes de una lista hay que convertirla con `toset()`:

```hcl
resource "local_file" "foreach_demo" {
  for_each = toset(var.environments)

  filename = "${path.module}/generated/foreach-${each.value}.txt"
  content  = "Environment: ${each.value}"
}
```

Ahora cada instancia se llama `foreach_demo["dev"]`, `foreach_demo["staging"]`, `foreach_demo["prod"]`. Quitar `"dev"` de la lista da un plan muy distinto:

```console
$ terraform plan
  # local_file.foreach_demo["dev"] will be destroyed
  # (because key ["dev"] is not in for_each map)
  - resource "local_file" "foreach_demo" {
      - content  = "Environment: dev" -> null
      - filename = "./generated/foreach-dev.txt" -> null
        # (8 unchanged attributes hidden)
    }

Plan: 0 to add, 0 to change, 1 to destroy.
```

Solo se destruye `foreach_demo["dev"]`. `staging` y `prod` no aparecen en el plan porque su clave no cambió: seguían siendo `"staging"` y `"prod"` antes y después, y `for_each` no depende de en qué posición estén en la lista original.

`toset()` tiene su propia trampa: si la lista tiene valores duplicados, el set se queda con uno solo sin avisar. Dos elementos iguales que con `count` generarían dos recursos separados, con `for_each` acaban siendo un único recurso. Para datos que puedan repetirse conviene un mapa con claves explícitas en vez de `toset()` sobre una lista.

## count como interruptor

Hay un uso de `count` que no tiene reemplazo tan directo en `for_each`: crear un recurso solo si se cumple una condición, poniendo `count` a 0 o 1.

```hcl
variable "enable_canary" {
  type    = bool
  default = false
}

resource "random_pet" "canary" {
  count  = var.enable_canary ? 1 : 0
  length = 2
}
```

Con `enable_canary = false` el recurso no existe. Con `true`, existe como `random_pet.canary[0]`, y hay que referenciarlo con ese índice (o con `try(random_pet.canary[0].id, null)` en un output, para no romper cuando el recurso no está). Es el patrón habitual para un recurso opcional cuando solo hay dos estados posibles, existe o no existe, y no hace falta identificar varias instancias por clave.

## Diferencias

| Aspecto | `count` | `for_each` |
| --- | --- | --- |
| Tipo de entrada | número | mapa o set de strings |
| Identidad de cada instancia | posición (`count.index`) | clave (`each.key` / `each.value`) |
| Al quitar un elemento del medio | reemplaza los siguientes, destruye el sobrante | destruye solo el que falta |
| Acceso a la instancia | `recurso[0]`, `recurso[1]`... | `recurso["clave"]` |
| Forma del output | lista | mapa |
| Buen caso de uso | copias idénticas, interruptor 0/1 | recursos con nombre propio que pueden cambiar con el tiempo |

## En resumen

- `count` numera por posición; si la lista que lo alimenta cambia de orden o pierde un elemento del medio, los índices se desplazan y Terraform reemplaza recursos que no deberían tocarse.
- `for_each` numera por clave; solo se destruye la instancia cuya clave desaparece, el resto no se entera del cambio.
- `for_each` exige un mapa o un set, no una lista: `toset()` es la conversión rápida, pero descarta duplicados en silencio.
- `count` sigue siendo la opción más simple para copias fungibles o para el patrón "0 o 1 recurso" según una condición.

El lab completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/09-count-for-each`.
