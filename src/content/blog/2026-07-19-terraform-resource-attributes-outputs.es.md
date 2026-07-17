---
title: 'Conectar recursos en Terraform con atributos y outputs'
description: 'Cómo referenciar el atributo de un recurso desde otro, cómo funciona el grafo de dependencias implícito que esto genera, y cómo exponer esos valores al terminar con bloques output.'
pubDate: 2026-07-19T12:00:00
tags: ['terraform', 'iac', 'gcp', 'buenas-practicas']
---

En el [post de variables](/blog/terraform-variables/) parametrizamos el proyecto y el prefijo de los buckets, pero los dos recursos del lab (`primary` y `backup`) siguen sin saber nada el uno del otro. En el día a día esto casi nunca pasa: una regla de firewall necesita el ID de la red, una instancia necesita el nombre del disco que acabas de crear, un registro DNS necesita la IP de un balanceador. Terraform resuelve esto con los **atributos que tiene un recurso**: cada recurso, una vez creado, expone un conjunto de valores (un ID, una URL, una IP...) que cualquier otro recurso puede leer.

## Conectar dos recursos por atributo

La sintaxis es `tipo_de_recurso.nombre.atributo`. Vamos a añadir un tercer recurso al lab, un objeto dentro del bucket `primary` cuyo contenido apunta al bucket `backup`:

```hcl
resource "google_storage_bucket_object" "readme" {
  name    = "README.txt"
  bucket  = google_storage_bucket.primary.name
  content = "Backup copy of this bucket lives at ${google_storage_bucket.backup.self_link}"
}
```

Dos referencias en este bloque: `google_storage_bucket.primary.name` para decir en qué bucket vive el objeto, y `google_storage_bucket.backup.self_link` para meter en el contenido la URL de la API del bucket de backup. `self_link` no lo escribes tú, a diferencia de `bucket_prefix`: lo calcula GCP al crear el recurso y Terraform lo guarda en el state después del `apply`.

Qué atributos expone un recurso se ve en la documentación del provider, en la sección "Attributes Reference" de cada recurso ([registry.terraform.io](https://registry.terraform.io)). Todo recurso tiene como mínimo un `id`; la mayoría añaden atributos propios del servicio (`self_link` y `url` en un bucket de GCS, `arn` en un recurso de AWS...).

## El grafo de dependencias que esto genera

En el momento en que escribes `google_storage_bucket.backup.self_link` dentro del recurso `readme`, Terraform entiende que `readme` depende de `backup`, sin que tengas que decírselo. Esto se llama **dependencia implícita**, y es la forma normal de encadenar recursos en Terraform: se deduce de las referencias que ya hay en el código, sin necesidad de mantenerlo aparte.

Al ejecutar verás el orden de creación ya ordenado para cumplir esas dependencias:

```console
$ cd labs/05-resource-attributes-outputs
$ make apply
...
google_storage_bucket.backup: Creating...
google_storage_bucket.primary: Creating...
google_storage_bucket.backup: Creation complete after 1s [id=mycompany-lab05-backup]
google_storage_bucket_object.readme: Creating...
google_storage_bucket.primary: Creation complete after 1s [id=mycompany-lab05-primary]
google_storage_bucket_object.readme: Creation complete after 0s [id=mycompany-lab05-primary/README.txt]
...
Apply complete! Resources: 3 added, 0 changed, 0 destroyed.
```

`backup` y `primary` no dependen entre sí, así que Terraform los crea en paralelo; `readme` sí depende de los dos (de `primary` por el argumento `bucket`, de `backup` por el `content`), así que espera a que ambos terminen. Nadie ha escrito ese orden en ningún sitio: sale solo de las referencias.

Existe también `depends_on`, para los casos en que la dependencia es real pero no hay ningún atributo que la refleje. Por ejemplo, una función que lee de un bucket necesita que el permiso IAM sobre ese bucket ya exista, pero ese permiso no tiene ningún atributo que la función pueda referenciar en su código: la relación es real, pero invisible para Terraform si no se declara con `depends_on`. Úsalo solo cuando de verdad lo necesites: bloquea el recurso entero hasta que el otro termine, mientras que una dependencia implícita solo espera a los atributos concretos que se usan, así que Terraform puede paralelizar más y planificar con más precisión. Si hay forma de expresar el orden con una referencia, esa es siempre la opción preferible.

## Exponer valores con `output`

Un `apply` que crea un bucket es útil, pero normalmente necesitas algún dato del resultado: la URL del bucket para pegarla en otro sitio, el nombre exacto que se generó... Para eso están los **outputs**:

```hcl
output "primary_bucket_url" {
  description = "URL gs:// del bucket primario, para usarla en gsutil o en otro proceso."
  value       = google_storage_bucket.primary.url
}

output "backup_bucket_self_link" {
  description = "URL de la API del bucket de backup."
  value       = google_storage_bucket.backup.self_link
}

output "readme_object_id" {
  description = "ID completo del objeto README.txt (bucket/nombre)."
  value       = google_storage_bucket_object.readme.id
}
```

Un bloque `output` lleva `value` (obligatorio, el valor o expresión que se quiere exponer) y `description` (opcional pero recomendado, igual que en las variables: el nombre del output no siempre deja claro qué contiene). Ojo con un detalle si vienes de documentación antigua o generada por IA: el argumento se llama `description`, no `desc`; con `desc` Terraform no da error pero tampoco hace nada, el output se queda sin documentar.

Al terminar el `apply`, Terraform imprime todos los outputs:

```console
Outputs:

backup_bucket_self_link = "https://www.googleapis.com/storage/v1/b/mycompany-lab05-backup"
primary_bucket_url = "gs://mycompany-lab05-primary"
readme_object_id = "mycompany-lab05-primary/README.txt"
```

Después se pueden consultar otra vez, sin tocar nada, todos a la vez o uno a uno:

```bash
terraform output
terraform output primary_bucket_url
```

## Outputs con datos sensibles

Si un output expone una contraseña, una clave privada o cualquier atributo marcado como sensible por el propio provider, hay que declararlo:

```hcl
output "db_password" {
  description = "Contraseña generada para el usuario de la base de datos."
  value       = google_sql_user.app.password
  sensitive   = true
}
```

Con `sensitive = true`, Terraform oculta el valor en la salida de `plan`, `apply` y `terraform output` (se ve como `<sensitive>`). Si el output referencia un atributo que el provider ya marca como sensible, Terraform obliga a poner `sensitive = true`: da error si lo omites. Una cosa importante que no cambia: el valor sigue quedando en texto plano dentro del state. `sensitive` solo oculta la salida en terminal, no protege el state; la protección real del state (backend cifrado, permisos de acceso) es la que ya vimos en el [post de remote state](/blog/terraform-state-remoto/).

## En resumen

- Un recurso, tras crearse, expone **atributos** (`id`, y otros propios del recurso como `self_link` o `url`), consultables con `tipo.nombre.atributo`.
- Referenciar un atributo crea una **dependencia implícita**: Terraform ordena la creación solo, sin necesidad de `depends_on`. Úsalo siempre que puedas: da a Terraform más información para paralelizar y planificar bien.
- `depends_on` es la excepción, para dependencias que no se pueden expresar con una referencia.
- Un bloque **`output`** expone un valor al terminar el `apply` y se consulta después con `terraform output`. Lleva `value` y, como buena práctica, `description` (el argumento correcto es `description`, no `desc`).
- Los outputs que expongan datos sensibles necesitan `sensitive = true`; esto oculta el valor en la terminal, pero no lo cifra en el state.

El ejemplo completo está en el repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), en la carpeta `labs/05-resource-attributes-outputs`.
