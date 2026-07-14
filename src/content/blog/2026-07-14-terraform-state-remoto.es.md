---
title: 'State remoto en Terraform: un bucket, un lock y adiós a pisarse el trabajo'
description: 'Qué es el fichero de estado de Terraform, por qué guardarlo en local no escala en un equipo, y cómo moverlo a un bucket de Google Cloud Storage con locking para que dos personas no puedan aplicar cambios a la vez.'
pubDate: 2026-07-14
tags: ['terraform', 'iac', 'gcp', 'equipos']
---

En el [post anterior](/blog/instalar-terraform/) dejamos Terraform instalado y funcionando. Si hiciste las pruebas, te habrás fijado en que después del `apply` apareció un fichero nuevo en el directorio: `terraform.tfstate`. Hoy toca hablar de él, porque ese fichero es la razón por la que Terraform funciona de maravilla en tu portátil y se convierte en un problema el día que sois dos.

## Qué es el state y por qué importa

Cuando ejecutas `terraform apply`, Terraform no solo crea recursos: apunta en el state qué ha creado y con qué atributos. Ese fichero es el mapa que conecta tu código con tu infraestructura real. Cuando luego ejecutas `terraform plan`, Terraform compara tres cosas: lo que declara tu código, lo que dice el state y lo que existe de verdad en el proveedor. De esa comparación sale el "2 to add, 1 to change".

Sin el state, Terraform no sabe qué recursos son suyos. No podría distinguir la instancia que creó él de otra que alguien levantó a mano, ni sabría qué destruir con un `terraform destroy`. Por eso perder el state es de las peores cosas que le pueden pasar a un proyecto de Terraform: la infraestructura sigue ahí, pero Terraform ya no sabe que es suya.

Y hay un detalle más que conviene saber desde el principio: **el state guarda valores en claro**. Contraseñas de bases de datos, tokens, claves privadas... si un recurso tiene un atributo sensible, en el state aparece sin cifrar. Esto tiene dos consecuencias inmediatas: el `terraform.tfstate` no se commitea jamás (va directo al `.gitignore`), y donde sea que lo guardes, tiene que estar cifrado y con acceso restringido.

## El problema del state local

Mientras trabajas solo, el state en local funciona. El problema llega el día que un compañero clona el repositorio: el código lo tiene, pero el state no, porque está en tu disco. Si ejecuta `terraform apply`, Terraform no encuentra state, asume que no existe nada y intenta crear toda la infraestructura otra vez. En el mejor de los casos falla por nombres duplicados; en el peor, acabas con recursos por duplicado pagándose dos veces.

Y aunque os paséis el fichero, queda el segundo problema: **la concurrencia**. Si tú y tu compañero ejecutáis `apply` a la vez, los dos leéis el mismo state, los dos hacéis cambios sobre la infraestructura y los dos escribís vuestro resultado. El último en escribir machaca lo que escribió el otro, y el state deja de reflejar la realidad. Es exactamente la misma condición de carrera que en cualquier sistema con un recurso compartido sin lock.

La solución tiene dos partes, y las dos vienen de serie en Terraform: guardar el state en un sitio compartido (un **backend remoto**) y bloquearlo mientras alguien lo está usando (**state locking**).

## Qué opciones hay

Terraform llama **backend** al sitio donde guarda el state, y soporta unos cuantos. Los que te vas a encontrar en la práctica:

- **Un bucket**: S3 en AWS, Cloud Storage en GCP (`gcs`) o un Storage Account en Azure (`azurerm`). Es la opción más común con diferencia: almacenamiento barato y duradero, con versionado y cifrado, y los tres soportan locking automático.
- **HCP Terraform** (el antiguo Terraform Cloud): el state vive en la plataforma de HashiCorp, que además añade ejecución remota, historial de runs y aprobaciones. Tiene capa gratuita y es una opción muy razonable si no quieres gestionar ni el bucket.
- **GitLab**: si tu código ya vive ahí, GitLab ofrece state gestionado a través del backend genérico `http`, con locking incluido. El state queda junto al repositorio, sin infraestructura extra.
- **PostgreSQL** (`pg`): el state en una tabla, con locking mediante advisory locks. Tiene sentido si no estáis en ninguna nube pública pero ya tenéis un Postgres.
- **Kubernetes** (en un Secret) y **Consul** (en su KV store): opciones más nicho, para equipos cuya plataforma ya gira alrededor de esas herramientas.

Conceptualmente todos hacen lo mismo: state compartido, cifrado y con lock. Elige el que encaje con lo que ya tienes. En este post vamos a montar un bucket de Google Cloud Storage.

## Creando el backend

Primero, el bucket. Se puede crear desde la consola de Google Cloud o con la CLI, pero hay un par de ajustes que no son opcionales:

```bash
gcloud storage buckets create gs://miempresa-terraform-state \
  --project=mi-proyecto \
  --location=europe-west1 \
  --uniform-bucket-level-access \
  --public-access-prevention

# Versionado: cada escritura del state guarda la versión anterior
gcloud storage buckets update gs://miempresa-terraform-state --versioning
```

Argumento a argumento:

- **`gs://miempresa-terraform-state`**: el nombre del bucket. Los nombres de bucket son globales en todo GCS (no puede haber dos iguales en el mundo), así que conviene prefijarlo con el nombre de la empresa.
- **`--project`**: el proyecto de GCP al que pertenece el bucket (y al que se le factura el almacenamiento).
- **`--location`**: dónde viven físicamente los datos. Una región concreta como `europe-west1` es la opción barata; también acepta multi-región (`eu`) si quieres redundancia geográfica.
- **`--uniform-bucket-level-access`**: desactiva las ACLs por objeto, la forma antigua de dar permisos en GCS. Con esto el acceso se controla solo con IAM y a nivel de bucket: una única lista de quién puede leer y escribir, sin excepciones fichero a fichero.
- **`--public-access-prevention`**: hace imposible exponer el bucket o su contenido públicamente, aunque alguien lo intente más adelante. Consecuencia directa de lo que contamos antes: el state lleva secretos dentro.
- **`--versioning`** (en el segundo comando): activa el versionado de objetos. Es la red de seguridad: cada escritura conserva la versión anterior, así que si un apply deja el state mal o alguien lo borra sin querer, recuperas la versión buena desde la consola o con `gcloud storage`.

¿Y el cifrado? En GCS no hay que activarlo: todo lo que se guarda va cifrado en reposo por defecto. Si tu empresa necesita gestionar sus propias claves se puede configurar con Cloud KMS, pero para empezar no hace falta.

Quizá te ha llamado la atención una cosa: acabo de crear infraestructura a mano, justo lo que llevamos dos posts diciendo que no se hace. Es el problema del huevo y la gallina: el bucket que guarda el state no puede gestionarse (todavía) desde el state que va a guardar. La convención habitual es asumirlo: el bucket del state se crea una vez, a mano o con un mini-proyecto de bootstrap aparte, y no se vuelve a tocar.

## Conectar Terraform al backend

Con el bucket listo, decirle a Terraform que use el backend remoto es un bloque más en la configuración del proyecto. Puede ir en cualquier fichero `.tf` del directorio, porque Terraform los lee todos, aunque lo habitual es ponerlo en el `main.tf`, dentro del bloque `terraform`, o en un fichero `backend.tf` aparte para localizarlo rápido:

```hcl
terraform {
  backend "gcs" {
    bucket = "miempresa-terraform-state"
    prefix = "proyectos/web"
  }
}
```

Dos detalles importantes aquí:

- **`prefix`** es la carpeta dentro del bucket donde este proyecto guarda su state. Un mismo bucket puede servir a varios proyectos, pero cada proyecto de Terraform necesita su propio fichero de state (si lo compartieran, se mezclarían sus recursos), y el `prefix` es lo que los separa. Con esta configuración, este proyecto escribe en `proyectos/web/default.tfstate` (el nombre del fichero lo pone Terraform); el de la API, con su propio `prefix`, escribiría en `proyectos/api/default.tfstate`. Como cada proyecto solo lee y escribe en su ruta, un apply en uno no puede tocar los recursos de otro. Cuántos buckets tener es decisión de cada empresa: uno solo con prefixes es lo más simple de gestionar, pero también es habitual separar por equipo o por entorno, con el bucket de producción en un proyecto aparte y permisos más estrictos, de forma que un despiste o un acceso indebido afecte a lo mínimo posible.
- **El locking no aparece en la configuración** porque en GCS viene de serie: no hay nada que activar. (Si trabajas en AWS, el backend `s3` sí lo pide explícito: `use_lockfile = true`, disponible desde Terraform 1.10. Antes hacía falta una tabla de DynamoDB aparte; ese método sigue funcionando, pero está deprecado.)

Para que Terraform pueda hablar con el bucket necesita credenciales de Google Cloud. En local lo habitual son las Application Default Credentials: un `gcloud auth application-default login` una vez y listo.

Después de añadir el bloque, `terraform init` detecta el cambio de backend. Si ya tenías un state local de las pruebas, te pregunta si quieres migrarlo:

```console
$ terraform init -migrate-state

Initializing the backend...
Do you want to copy existing state to the new backend?
  Enter a value: yes

Successfully configured the backend "gcs"!
```

A partir de aquí, el `terraform.tfstate` local desaparece del flujo: cada `plan` y cada `apply` lee y escribe directamente en el bucket. Tu compañero clona el repositorio, ejecuta `terraform init` y trabaja contra el mismo state que tú. Sin pasarse ficheros.

## El locking en acción

La parte del lock no requiere hacer nada más: es automática. Cada vez que una operación va a escribir el state, Terraform crea primero un fichero de lock junto al state en el bucket (`default.tflock`). Si otra persona lanza un `apply` mientras tanto, se encuentra esto:

```console
$ terraform apply

Error: Error acquiring the state lock

Lock Info:
  ID:        b4ee5872-3a67-1c5d-f21e-5a3c2e8b9d10
  Operation: OperationTypeApply
  Who:       ana@portatil-ana
  Created:   2026-07-14 10:32:18 UTC
```

Y esto, que parece un error, es exactamente lo que queríamos: Terraform se niega a ejecutar hasta que la operación de Ana termine y suelte el lock. El mensaje además te dice quién lo tiene y desde cuándo, así que en lugar de machacar su trabajo, le escribes o simplemente esperas. Con `-lock-timeout=2m` puedes decirle a Terraform que reintente durante un rato en vez de fallar a la primera.

Si alguna vez un lock se queda colgado (típicamente porque un apply murió a medias, por un corte de red o un Ctrl+C a destiempo), existe `terraform force-unlock <ID>`. Pero es el último recurso: antes de usarlo, confirma con el equipo que de verdad no hay ninguna operación en marcha. Si liberas el lock mientras el apply de otra persona sigue en marcha, los dos acabaréis escribiendo el state a la vez: justo la condición de carrera que el lock estaba evitando.

## ¿Y con el Makefile de Docker?

Si usas el `terraform.mk` del [post anterior](/blog/instalar-terraform/), solo falta que el contenedor vea las credenciales de Google Cloud. Basta con añadir una línea al `TF_RUN` que monte en solo lectura el directorio donde `gcloud` guarda las Application Default Credentials:

```makefile
TF_RUN := docker run --rm -it \
	-v "$(CURDIR)":/workspace -w /workspace \
	-v "$(HOME)/.config/gcloud":/root/.config/gcloud:ro \
	$(TF_IMAGE)
```

El contenedor usa las credenciales de tu sesión de `gcloud` sin que quede escrito nada en ningún fichero del repositorio.

## En resumen

- El **state** es el mapa entre tu código y los recursos reales. Sin él, Terraform está ciego. Y como contiene secretos en claro, nunca debe subirse al repositorio.
- En equipo, el state local provoca dos problemas: cada uno tiene su propia versión de la realidad, y dos applies simultáneos se machacan entre sí.
- Un **backend remoto** (GCS, S3, Azure Storage) resuelve lo primero; el **locking** resuelve lo segundo. En GCS viene de serie, sin configurar nada; en S3 basta con `use_lockfile = true` desde Terraform 1.10.
- El bucket del state se configura una vez y bien: **versionado, sin acceso público y acuérdate de cifrarlo**.
- Un solo bucket puede servir a toda la empresa usando un `prefix` distinto por proyecto y entorno.

El ejemplo completo de este post irá, como los anteriores, al repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero). En el próximo post de la serie tocará hablar de variables y de cómo estructurar un proyecto para más de un entorno sin copiar y pegar carpetas.
