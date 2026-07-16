---
title: 'Qué son los providers en Terraform y cómo usarlos'
description: 'Qué es exactamente un provider de Terraform, por qué hay que fijar su versión con required_providers, qué pinta el fichero .terraform.lock.hcl, y cómo configurar el provider de Google Cloud sin meter credenciales en el código.'
pubDate: 2026-07-16T12:00:00
tags: ['terraform', 'iac', 'gcp', 'buenas-practicas']
---

Si has seguido los posts anteriores, ya has ejecutado `terraform init` unas cuantas veces. Y si te fijaste en la salida la primera vez, puede que vieras un aviso como este:

```console
The following providers do not have any version constraints in configuration,
so the latest version was installed.

To prevent automatic upgrades to new major versions that may contain breaking
changes, we recommend adding version constraints in a required_providers block
in your configuration, with the constraint strings suggested below.

* hashicorp/local: version = "~> 2.5"
```

Terraform nos está avisando de algo importante: estamos usando un provider sin decir qué versión queremos, así que nos ha instalado la última que había. Hoy funciona. El día que el provider publique una versión nueva con cambios incompatibles, el mismo código que hoy pasa el `plan` limpio puede empezar a fallar sin que hayamos tocado nada. Este post va de evitarlo, y de paso de entender qué es exactamente eso que `terraform init` descarga.

## Qué es un provider

El binario de Terraform, por sí solo, no sabe hablar con ninguna nube. Sabe leer ficheros `.tf`, encontrar diferencias y gestionar el state, pero no tiene ni idea de cómo se crea un bucket en Google Cloud o una instancia en AWS. Ese trabajo lo hacen los **providers**: plugins que Terraform descarga y que traducen los recursos declarados a llamadas contra la API de cada plataforma.

Es una arquitectura de plugins: cada provider es un ejecutable aparte que Terraform descarga en `.terraform/providers/` cuando ejecutas `init`. Por eso el binario de Terraform pesa poco y por eso hay providers para cientos de plataformas: las tres grandes nubes, pero también GitHub, Cloudflare, Kubernetes, Datadog... e incluso cosas tan mundanas como el provider `local` que usamos para crear ficheros en disco en el [post de instalación](/blog/instalar-terraform/).

Los providers se distribuyen a través del [Terraform Registry](https://registry.terraform.io), y allí están organizados en tres niveles según quién los mantiene:

- **Official**: los mantiene HashiCorp. Aquí están AWS, Azure o el provider `local`. El de Google es un caso curioso: lo mantienen ambos, Google y HashiCorp.
- **Partner**: los mantiene la empresa propietaria de la plataforma, tras pasar un proceso de verificación de HashiCorp. Datadog, Cloudflare o DigitalOcean, por ejemplo.
- **Community**: los mantiene gente de la comunidad, sin verificación. Algunos son excelentes, pero antes de usar uno conviene mirar si el repositorio sigue activo.

Cada provider se identifica con una dirección siguiendo este formato: `namespace/nombre`: `hashicorp/google`, `hashicorp/local`, `datadog/datadog`. La dirección completa incluye el hostname del registry (`registry.terraform.io/hashicorp/google`), pero como el registry público es el valor por defecto, casi nunca se escribe.

## Fijar la versión: required_providers

Volvamos al aviso del principio. La solución que propone el propio Terraform es declarar los providers que usa el proyecto, con su versión, en un bloque `required_providers` dentro del bloque `terraform`:

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
```

Cada provider lleva dos campos:

- **`source`**: la dirección del provider en el registry. Hasta ahora no la habíamos declarado y funcionaba igual, porque cuando falta, Terraform asume `hashicorp/<nombre>`. Para providers de HashiCorp da lo mismo; para cualquier otro (un `datadog/datadog`, por ejemplo) el `source` es obligatorio, porque Terraform no tiene forma de adivinar el namespace.
- **`version`**: qué versiones del provider acepta este proyecto. No es una versión exacta, es una restricción.

La restricción admite los operadores de comparación habituales (`= 7.40.0`, `>= 7.0`, `< 8.0`, combinables separándolos por comas), pero en la práctica casi todo el mundo usa uno: `~>`, el operador pesimista. Significa "esta versión o superior, sin cambiar el último número que he escrito":

- `~> 7.0` acepta cualquier `7.x` (7.1, 7.40...), pero no la 8.0.
- `~> 7.40.0` acepta cualquier `7.40.x` (solo parches), pero no la 7.41.

¿Por qué es este el operador habitual? Porque los providers siguen versionado semántico, y los cambios incompatibles solo llegan en versiones major. Con `~> 7.0` te llevas mejoras y correcciones de toda la serie 7 sin riesgo de que un `init` te cuele el salto a la 8, que es donde pueden romperse cosas. El salto de major lo das tú, cuando quieras, leyendo antes el changelog.

La recomendación general es simple: **todo proyecto declara `required_providers` con restricción de versión para cada provider que usa**. Sin excepciones.

## Y ya que estamos: la versión de Terraform

El mismo bloque `terraform` admite otra restricción que conviene dejar escrita, la de la versión de Terraform en sí:

```hcl
terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
```

Si alguien ejecuta el proyecto con un Terraform más viejo de lo declarado, el comando falla al instante.

Si usas el Makefile con Docker de los posts anteriores esto puede parecer redundante, porque el `TF_VERSION` del Makefile ya fija qué binario se ejecuta. Pero cumplen papeles distintos: el Makefile decide qué versión usas tú; `required_version` protege el proyecto de cualquiera que lo ejecute por otra vía. Es redundante a propósito: `required_version` viaja con el código a cualquier sitio donde el Makefile no llegue.

## El lock file: de "qué acepto" a "qué uso"

Con `version = "~> 7.0"` hemos acotado el rango, pero dentro del rango sigue habiendo margen: hoy `init` instalaría la 7.40, dentro de un mes la 7.43. Sigue habiendo el mismo problema, solo que más pequeño, y aquí entra en juego un fichero que quizá ya te haya aparecido en el directorio: `.terraform.lock.hcl`. Terraform lo crea (o actualiza) en cada `init`, y dentro apunta la versión **exacta** de cada provider que instaló, junto con sus checksums:

```hcl
provider "registry.terraform.io/hashicorp/google" {
  version     = "7.40.0"
  constraints = "~> 7.0"
  hashes = [
    "h1:mV0Y0BLevn5QIYuKpxHkTNhTpKgCjbBLdmqrqTLtNXk=",
    ...
  ]
}
```

A partir de ese momento, cualquier `terraform init` (el tuyo, el de tu compañero, el de la CI) instala exactamente esa versión, aunque exista una más nueva que también cumpla la restricción. Cada fichero cumple un papel distinto:

- La restricción del `required_providers` dice **qué versiones estás dispuesto a aceptar**.
- El lock file dice **cuál estás usando exactamente ahora mismo**.

Para que esto funcione en equipo hay una regla: **el `.terraform.lock.hcl` se commitea al repositorio**. Es el equivalente al `package-lock.json` de npm o al `poetry.lock` de Python, y la razón es la misma: sin él, cada máquina resuelve la versión por su cuenta y "a mí me funciona" vuelve a la conversación. Ojo, porque es fácil meterlo en el `.gitignore` sin querer: la carpeta `.terraform/` sí se ignora (son binarios descargados), pero el fichero `.terraform.lock.hcl` no.

Los checksums son la otra mitad del fichero: en cada `init`, Terraform comprueba que el binario descargado coincide con el hash apuntado, la misma idea que el `sha256sum` que hicimos a mano al [instalar Terraform](/blog/instalar-terraform/), pero automática. Si el registry devolviera un binario distinto del que el equipo validó, el `init` falla.

¿Y cómo se actualiza un provider entonces? Usando este comando:

```bash
terraform init -upgrade
```

Ese comando busca la versión más nueva que cumpla las restricciones, la instala y actualiza el lock file. Después, un `terraform plan` para comprobar que no hay sorpresas, y si todo está bien, se commitea el lock file actualizado. La subida de versión queda registrada en un commit, se revisa como cualquier otro cambio, y si algo va mal se revierte con un `git revert`. En proyectos grandes este trabajo se suele delegar en herramientas como Renovate o Dependabot, que abren la pull request de subida de versión por ti; pero el flujo de fondo es el mismo.

Un detalle que ahorra un disgusto en CI: el lock file guarda por defecto los checksums de la plataforma donde se ejecutó el `init`. Si tú trabajas en un Mac con Apple Silicon y la CI corre en Linux, a la CI le pueden faltar los hashes de su plataforma y el `init` falla. Se arregla registrando todas las plataformas del equipo:

```bash
terraform providers lock \
  -platform=linux_amd64 \
  -platform=darwin_arm64
```

Con el Makefile de la serie no hay problema, porque todo (tu máquina y la CI) ejecuta el mismo contenedor Linux. Pero si en tu equipo conviven sistemas distintos, este comando te evita el error de checksums.

## Configurar el provider de Google

Hasta ahora hemos hablado de qué provider y qué versión. Falta la configuración del provider en sí: el bloque `provider`, donde se le dan los valores por defecto con los que va a trabajar:

```hcl
provider "google" {
  project = "mi-proyecto"
  region  = "europe-west1"
}
```

Con esto, cualquier recurso del proyecto que no diga lo contrario se crea en ese proyecto de GCP y en esa región, y no hace falta repetirlo recurso a recurso. Cada provider tiene sus propios argumentos (el de AWS pide `region`, el de Datadog pide su API key...), y todos están documentados en la página del provider en el registry.

Y aquí llega el punto donde más daño se puede hacer: **las credenciales**. El bloque `provider` de Google acepta un argumento `credentials` apuntando a una clave de service account. No lo uses así:

```hcl
# NO: la ruta delata que hay una clave suelta, y el siguiente
# paso suele ser commitearla "solo para probar"
provider "google" {
  project     = "mi-proyecto"
  credentials = file("mi-clave.json")
}
```

Las credenciales en el código acaban en el repositorio, y un secreto commiteado se considera comprometido aunque lo borres en el commit siguiente (queda en el historial). La regla es que **el código declara infraestructura; las credenciales las pone el entorno**. Con Google, en la práctica:

- **En local**: Application Default Credentials, las mismas que configuramos en el [post del state remoto](/blog/terraform-state-remoto/) con `gcloud auth application-default login`. El provider las encuentra sin que haya que declarar nada en el bloque.
- **En CI**: Workload Identity Federation, que permite a la pipeline autenticarse contra GCP con tokens de corta duración, sin ninguna clave guardada. Si tu CI aún no lo soporta, el plan B es una clave de service account guardada en el gestor de secretos de la CI, nunca en el repositorio.

Fíjate en que el bloque `provider` de arriba, el bueno, no tiene ni un solo dato sensible: proyecto y región son información pública para cualquiera que tenga acceso al repositorio. Así es como debe quedar.

## Un mismo provider, varias configuraciones: alias

Queda un último escenario: ¿y si necesitas el mismo provider con dos configuraciones distintas? El caso típico es desplegar en dos regiones (por ejemplo, la infraestructura principal en `europe-west1` y una copia de respaldo en otra región), o tocar dos proyectos de GCP desde el mismo código. No puedes declarar dos bloques `provider "google"` sin más, porque Terraform no sabría cuál usar. Para eso están los **alias**:

```hcl
provider "google" {
  project = "mi-proyecto"
  region  = "europe-west1"
}

provider "google" {
  alias   = "backup"
  project = "mi-proyecto"
  region  = "europe-southwest1"
}
```

El primer bloque, sin alias, es la configuración por defecto: todos los recursos la usan salvo que digan lo contrario. Y para crear un recurso con la segunda, se pide explícitamente con `provider =`:

```hcl
resource "google_storage_bucket" "backups" {
  provider = google.backup

  name     = "miempresa-backups"
  location = "EUROPE-SOUTHWEST1"
}
```

Conviene que el nombre del alias diga algo (`backup`, `madrid`, `proyecto_red`) en lugar de genéricos tipo `google2`, porque ese nombre es lo único que verá quien lea el recurso. Y usar alias no es lo habitual: la mayoría de proyectos viven perfectamente con un solo bloque `provider` sin alias.

## En resumen

- Un **provider** es un plugin que traduce los recursos declarados a llamadas a la API de cada plataforma. Se descargan del registry con `terraform init`.
- Todo proyecto declara sus providers en **`required_providers`**, con `source` y una restricción de versión. El operador `~>` es el habitual: acepta mejoras dentro de la misma serie y bloquea el salto de major, que es donde rompen las cosas.
- **`required_version`** hace lo mismo con la versión de Terraform.
- El **`.terraform.lock.hcl`** fija la versión exacta en uso y sus checksums, y se commitea siempre. Las subidas de versión se hacen a propósito con `terraform init -upgrade`, se revisan con un `plan`, y la buena práctica es subirlas en un commit propio.
- El bloque **`provider`** lleva proyecto y región, y **nunca credenciales**: en local, Application Default Credentials; en CI, Workload Identity o el gestor de secretos.
- Los **alias** permiten usar un mismo provider con varias configuraciones (dos regiones, dos proyectos). Útiles en casos específicos, no en la mayoría de proyectos.

El ejemplo completo está, como siempre, en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/03-providers`.
