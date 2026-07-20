---
title: 'Comandos útiles de Terraform: validate, fmt, show, providers, output, refresh y graph'
description: 'Qué hace cada uno de estos comandos, cómo se usan en la práctica y cuáles de ellos tienen sentido en una pipeline de CI (y cuáles no).'
pubDate: 2026-07-21T12:00:00
tags: ['terraform', 'iac', 'ci', 'buenas-practicas']
---

Hasta ahora en la serie hemos ido viendo bloques de configuración: providers, variables, atributos, outputs. Este post es distinto, va sobre la propia CLI de Terraform: comandos que no cambian infraestructura, pero que acabas usando todos los días para depurar, formatear e inspeccionar lo que tienes escrito.

## `terraform validate`

Comprueba que la sintaxis HCL y los argumentos de cada bloque son correctos, sin llegar a planificar nada. No necesita credenciales ni conectividad con el backend, solo los providers ya descargados (`terraform init` antes).

```console
$ terraform validate
Success! The configuration is valid.
```

Si metes un argumento que no existe, por ejemplo `file_permissions` en vez de `file_permission`, el error señala la línea exacta y sugiere el nombre correcto:

```console
$ terraform validate
Error: Unsupported argument

  on main.tf line 9, in resource "local_file" "notice":
   9:   file_permissions = "0700"

An argument named "file_permissions" is not expected here. Did you mean "file_permission"?
```

`validate` no detecta todo: si el argumento existe pero el valor es inválido para la API del proveedor (un tipo de máquina que no existe en GCP, por ejemplo), eso no lo pilla `validate`, lo pilla `plan` al hablar con la API.

## `terraform fmt`

Reescribe los ficheros `.tf` del directorio actual con el formato estándar de Terraform: indentación, alineación de `=`, espacios. No cambia lógica, solo estilo.

```console
$ terraform fmt -recursive
main.tf
```

La salida lista los ficheros que ha tocado. Con `-check` no reescribe nada, solo dice si algo estaría mal formateado y devuelve un código de salida distinto de cero si es así, que es la forma de usarlo en CI (más abajo).

## `terraform show`

Muestra el state actual: todos los recursos que Terraform gestiona con sus atributos calculados.

```console
$ terraform show
# local_file.notice:
resource "local_file" "notice" {
    content              = "Office pet of the month: clever-lynx"
    directory_permission = "0777"
    file_permission      = "0777"
    filename             = "./notice.txt"
    id                   = "a1b2c3..."
}

# random_pet.office:
resource "random_pet" "office" {
    id        = "clever-lynx"
    keepers   = null
    length    = 2
    separator = "_"
}
```

Con `-json` la misma información sale en JSON, pensada para que la consuma otra herramienta en vez de un humano:

```console
$ terraform show -json | jq '.values.root_module.resources[0].values.filename'
"./notice.txt"
```

Esta forma JSON es la que consumen herramientas como Sentinel, OPA, Checkov o tfsec para revisar el plan antes del `apply`: en vez de parsear texto, parsean una estructura estable.

## `terraform providers`

Lista qué providers necesita la configuración y cuáles hay ya en el state, sin tener que abrir `versions.tf` a mano.

```console
$ terraform providers
Providers required by configuration:
.
├── provider[registry.terraform.io/hashicorp/local]
└── provider[registry.terraform.io/hashicorp/random]
```

Tiene un subcomando útil para entornos sin salida a internet: `providers mirror` descarga los binarios de los providers a un directorio local, para que otra máquina (o el runner de CI) pueda hacer `init` apuntando ahí en vez de a `registry.terraform.io`.

```console
$ terraform providers mirror ./mirror
- Mirroring hashicorp/local...
- Mirroring hashicorp/random...
```

Esto conecta con lo que vimos en el [post de providers](/blog/terraform-providers/): el `.terraform.lock.hcl` fija versiones y hashes, `providers mirror` es para cuando esos binarios no se pueden descargar directamente del registry.

## `terraform output`

Ya lo vimos en el [post de atributos y outputs](/blog/terraform-resource-attributes-outputs/).

```console
$ terraform output
office-pet = "clever-lynx"

$ terraform output office-pet
"clever-lynx"

$ terraform output -json office-pet
"clever-lynx"
```

## `terraform refresh` (y `-refresh-only`)

Sincroniza el state con lo que hay realmente desplegado, sin cambiar ningún recurso. Por defecto no hace falta llamarlo aparte: `plan` y `apply` ya refrescan el state en memoria antes de calcular el diff.

```console
$ terraform plan
random_pet.office: Refreshing state... [id=clever-lynx]
local_file.notice: Refreshing state... [id=a1b2c3...]

No changes. Your infrastructure matches the configuration.
```

El comando `terraform refresh` suelto está deprecado desde Terraform 1.x a favor de `terraform apply -refresh-only`, que hace lo mismo pero mostrando primero un plan de los cambios que va a persistir en el state y pidiendo confirmación, en vez de escribir directamente:

```console
$ terraform apply -refresh-only
random_pet.office: Refreshing state... [id=clever-lynx]

Terraform will perform the following actions:
  ...
Would you like to update the Terraform state to reflect these detected changes?
```

Tiene sentido cuando alguien ha tocado algo fuera de Terraform (un clic en la consola, un script suelto) y quieres que el state refleje la realidad sin tocar la infraestructura. Si lo que quieres es lo contrario, que `plan`/`apply` no pierdan tiempo comprobando el estado real, está `-refresh=false`; útil para acelerar un `plan` cuando sabes que nada ha cambiado por fuera, pero con el riesgo de que el state ya no refleje la realidad y el plan salga mal.

## `terraform graph`

Genera el grafo de dependencias en formato DOT.

```console
$ terraform graph
digraph {
  compound = "true"
  newrank = "true"
  subgraph "root" {
    "[root] local_file.notice (expand)" [label = "local_file.notice", shape = "box"]
    "[root] random_pet.office (expand)" [label = "random_pet.office", shape = "box"]
    "[root] local_file.notice (expand)" -> "[root] random_pet.office (expand)"
    ...
  }
}
```

El DOT en crudo no dice mucho a simple vista. Con Graphviz instalado (`apt install graphviz`) se convierte en una imagen:

```console
$ terraform graph | dot -Tsvg > graph.svg
```

Para dos recursos como este lab el grafo es trivial, pero en un módulo con decenas de recursos es la forma más rápida de ver qué depende de qué sin leer todo el código.

## Cuáles de estos comandos tienen sentido en CI

No todos. Una pipeline de CI típica para un repo de Terraform hace esto, en este orden:

```console
terraform fmt -check -recursive
terraform init -input=false -lockfile=readonly
terraform validate
terraform plan -input=false -out=plan.tfplan
terraform show -json plan.tfplan > plan.json   # opcional, para políticas
terraform apply -input=false plan.tfplan       # solo tras aprobación, en otro job
```

- **`fmt -check -recursive`**: `-check` no reescribe nada, solo comprueba y devuelve error si algo no está formateado; `-recursive` mira también los subdirectorios (módulos locales, por ejemplo), no solo el directorio actual. No necesita `init` ni credenciales, así que es el primer paso de la pipeline.
- **`init -lockfile=readonly`**: usa el `.terraform.lock.hcl` del repo tal cual, sin tocarlo. Si alguien necesita una versión de provider distinta, lo cambia en local y lo commitea; el CI no debe reescribir el lock file por su cuenta.
- **`validate`**: rápido, sin backend real ni credenciales de más, buen filtro antes de gastar tiempo en un `plan`.
- **`plan -out=plan.tfplan`**: el plan se guarda como artefacto. El `apply` posterior usa ese fichero exacto (`apply plan.tfplan`), no vuelve a planificar. Así lo que se aprueba en la revisión es exactamente lo que se aplica, sin volver a preguntarle a la API por si algo cambió mientras tanto.
- **`show -json`**: si usas OPA, Checkov, tfsec o Sentinel para revisar cambios, el punto de entrada es el plan en JSON, no el `.tf`. Evalúa el cambio real, no solo el código estático.
- **`-input=false`** en todos los comandos: en CI no hay terminal interactiva para responder un prompt; si falta una variable sin default, mejor que el comando falle explícito que se quede colgado esperando input.
- La variable de entorno `TF_IN_AUTOMATION=true` avisa a Terraform de que se está ejecutando en una pipeline: ajusta algunos mensajes (por ejemplo, deja de sugerir comandos interactivos en los errores) pero no cambia el comportamiento real de ningún comando.

Lo que normalmente **no** entra en la pipeline:

- **`refresh` / `apply -refresh-only`** sueltos: si el state y la realidad se han desincronizado, es una señal de que algo cambió fuera de Terraform, y eso se investiga a mano, no se corrige automáticamente en cada ejecución de la pipeline.
- **`graph`**: sirve para que una persona depure un módulo a ojo, no aporta nada dentro de una pipeline automatizada.
- **`providers mirror`**: solo hace falta si el runner de CI no tiene salida a `registry.terraform.io`; en ese caso el `init` apunta al mirror local en vez de a `registry.terraform.io`.

## En resumen

- `validate` comprueba sintaxis y argumentos sin planificar; `fmt` normaliza el estilo; ambos son baratos y van primero en cualquier pipeline.
- `show` (con `-json`) inspecciona el state o un plan guardado; es el formato que consumen OPA, Checkov, tfsec o Sentinel.
- `providers` lista qué providers usa la configuración; `providers mirror` resuelve el caso sin acceso directo al registry.
- `output` consulta valores expuestos sin volver a aplicar nada.
- `refresh` está deprecado a favor de `apply -refresh-only`; ninguno de los dos va en una pipeline, son para sincronizar el state a mano cuando algo cambió por fuera.
- `graph` visualiza dependencias, útil para depurar un módulo grande, no para CI.
- Una pipeline de CI razonable: `fmt -check` → `init -lockfile=readonly` → `validate` → `plan -out=` → (aprobación) → `apply` del plan guardado, todo con `-input=false`.

El ejemplo completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/06-terraform-commands`.
