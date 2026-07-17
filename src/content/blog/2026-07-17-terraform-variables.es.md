---
title: 'Cómo se declaran variables en Terraform'
description: 'Cómo declarar variables en Terraform con type y description, las cuatro formas de asignarles valor (default, -var, TF_VAR_, ficheros tfvars) y el orden de precedencia cuando varias compiten por la misma variable.'
pubDate: 2026-07-17T12:00:00
tags: ['terraform', 'iac', 'gcp', 'buenas-practicas']
---

En el [post de providers](/blog/terraform-providers/) dejamos fijadas las versiones, pero el código sigue teniendo otro problema: el nombre del proyecto de GCP y el de los buckets están escritos a fuego en `main.tf` y `provider.tf`. Si otra persona quiere probar el lab, tiene que ir fichero por fichero cambiando cadenas de texto, o pedírselo a una IA. Si tú quieres desplegar la misma infraestructura en un proyecto de pruebas y otro de producción, tienes que mantener dos copias del código. Las variables resuelven esto: sacan esos valores del código y los convierten en parámetros que se pasan al ejecutar.

## Declarar una variable

Una variable se declara con un bloque `variable`, normalmente en un fichero aparte llamado `variables.tf`:

```hcl
variable "bucket_prefix" {
  description = "Prefijo usado para construir el nombre de los buckets."
  type        = string
  default     = "mycompany-lab04"
}
```

Tres campos, ninguno obligatorio para Terraform, pero es buena práctica escribir siempre los tres:

- **`description`**: qué representa la variable. Terraform no la necesita para funcionar, pero dentro de tres meses tú tampoco te vas a acordar de qué era `region_2`.
- **`type`**: qué forma de dato acepta (`string`, `number`, `bool`, `list(string)`, `map(string)`, `object({...})`...). Sin `type`, Terraform intenta adivinarlo del valor que le llegue, y si alguien pasa un tipo equivocado el fallo puede aparecer más tarde, a veces en mitad de un `apply`. Con `type` declarado, el fallo sale en el momento en que asignas el valor.
- **`default`**: el valor que se usa si nadie dice lo contrario. Si lo omites, hay que pasarle un valor desde fuera; si no, Terraform lo pide.

El nombre de la variable sigue la misma convención que el resto de Terraform: minúsculas y guion bajo (`bucket_prefix`, no `bucketPrefix` ni `bucket-prefix`).

Para usar la variable en un recurso, se referencia con el prefijo `var.`:

```hcl
resource "google_storage_bucket" "primary" {
  name     = "${var.bucket_prefix}-primary"
  location = var.primary_location
}
```

## Variables obligatorias

Si un dato no tiene un valor por defecto (el proyecto de GCP es el caso típico: no hay un proyecto "por defecto" que valga para nadie más que para ti), la variable se declara sin `default`:

```hcl
variable "project" {
  description = "Proyecto de GCP donde se crean los buckets."
  type        = string
}
```

Si llegas a `terraform plan` o `terraform apply` sin haber dado un valor a `project` por ninguna de las vías disponibles, Terraform se detiene y te lo pide de forma interactiva. En cualquier entorno automatizado (CI, un script) ese prompt bloquea la ejecución indefinidamente, así que en la práctica el valor siempre hay que pasarlo por alguna de las siguientes formas.

## Las cuatro formas de asignar un valor

Aparte del `default` del propio bloque, hay tres formas más de darle valor a una variable desde fuera del código.

**El flag `-var` en la línea de comandos**, uno por cada variable que quieras fijar:

```bash
terraform apply -var "project=my-project" -var "bucket_prefix=lab04"
```

**Variables de entorno**, con el prefijo `TF_VAR_` seguido del nombre exacto de la variable:

```bash
export TF_VAR_project="my-project"
export TF_VAR_bucket_prefix="lab04"
terraform apply
```

**Ficheros de variables**, con extensión `.tfvars`. Terraform carga automáticamente un fichero llamado `terraform.tfvars`, y también cualquier fichero que termine en `.auto.tfvars`:

```hcl
# terraform.tfvars
project       = "my-project"
bucket_prefix = "lab04"
```

Si el fichero tiene otro nombre, hay que indicarlo explícitamente con `-var-file`:

```bash
terraform apply -var-file="produccion.tfvars"
```

## Precedencia: qué valor gana si usamos varias al mismo tiempo

El lab de este post (`labs/04-variables`) trae dos ficheros de variables a propósito, para que se vea la precedencia en ejecución en lugar de en teoría:

```hcl
# terraform.tfvars
project       = "my-project"
bucket_prefix = "mycompany-lab04"
```

```hcl
# prefix.auto.tfvars
bucket_prefix = "mycompany-lab04-auto"
```

Ambos se cargan solos, sin pedirlo con ningún flag. Y aunque `terraform.tfvars` se lee primero, `prefix.auto.tfvars` se lee después y gana, así que un `make plan` en este lab crea buckets con el prefijo `mycompany-lab04-auto`, no `mycompany-lab04`:

```console
$ cd labs/04-variables
$ make plan
...
  + resource "google_storage_bucket" "primary" {
      + name     = "mycompany-lab04-auto-primary"
      ...
```

Si además pasas `-var "bucket_prefix=lab04-manual"` al ejecutar, ese valor gana a los dos ficheros. El orden completo, de menor a mayor prioridad, es este:

| Precedencia | Fuente | Ejemplo |
| --- | --- | --- |
| 1 (más baja) | `default` en el bloque `variable` | `default = "mycompany-lab04"` |
| 2 | Variable de entorno `TF_VAR_` | `export TF_VAR_bucket_prefix=...` |
| 3 | `terraform.tfvars` | `bucket_prefix = "mycompany-lab04"` |
| 4 | Ficheros `*.auto.tfvars` (orden alfabético) | `bucket_prefix = "mycompany-lab04-auto"` |
| 5 (más alta) | `-var` o `-var-file` en el comando | `-var "bucket_prefix=lab04-manual"` |

La regla práctica que se saca de esta tabla: cuanto más cerca del comando que ejecutas, mayor prioridad. Y cada nivel tiene su caso de uso natural:

- **`default`**: el valor de siempre, el que sirve en el caso normal sin que nadie tenga que tocar nada.
- **`TF_VAR_`**: datos del entorno donde corre Terraform (una CI que ya tiene el proyecto en una variable de entorno propia, por ejemplo), sin tocar ningún fichero del repositorio.
- **`terraform.tfvars`**: los valores habituales de quien usa el proyecto en su día a día, guardados junto al código.
- **`*.auto.tfvars`**: overrides que se cargan solos para un caso concreto (una máquina de pruebas, un entorno concreto) sin tocar el `terraform.tfvars` de base.
- **`-var` / `-var-file`**: la excepción puntual, un valor distinto solo para esta ejecución, sin dejar rastro en ningún fichero.

## Buenas prácticas al declarar variables

- **`description` y `type` en todas las variables, sin excepción.** Es la diferencia entre un `terraform plan` que falla con un mensaje claro ("se esperaba string, se recibió number") y uno que falla más adelante, contra la API del proveedor, con un error mucho más difícil de relacionar con la causa real.
- **Nombres en minúscula con guion bajo, y en plural cuando el tipo es una lista o un mapa** (`bucket_names` si fuera `list(string)`, no `bucket_name`).
- **Sin `default` en lo que deba decidirse explícitamente en cada entorno** (el proyecto, la cuenta, cualquier identificador que cambie entre pruebas y producción). Poner un `default` "razonable" en estos casos es la forma más habitual de acabar desplegando por error contra el proyecto equivocado.
- **Nunca un `default` para secretos.** Una variable de tipo contraseña o clave de API no lleva valor por defecto, así se fuerza a que siempre se pase desde fuera del código (variable de entorno o gestor de secretos), nunca escrita en un fichero que pueda acabar commiteado.

## En resumen

- Una **variable** se declara con `variable "nombre" { description, type, default }`, y se usa con `var.nombre`.
- Sin `default`, la variable es **obligatoria**: Terraform la pide de forma interactiva si no se la das por otra vía, lo cual bloquea cualquier ejecución automatizada.
- Hay tres formas de asignar un valor desde fuera del código: el flag **`-var`**, las variables de entorno **`TF_VAR_`**, y los **ficheros `.tfvars`** (`terraform.tfvars` y `*.auto.tfvars` se cargan solos; el resto necesita `-var-file`).
- La **precedencia**, de más débil a más fuerte: `default` → `TF_VAR_` → `terraform.tfvars` → `*.auto.tfvars` → `-var`/`-var-file`.
- Toda variable lleva **`description`** y **`type`**; los datos que cambian entre entornos (proyecto, secretos) van **sin `default`**.

El ejemplo completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/04-variables`.
