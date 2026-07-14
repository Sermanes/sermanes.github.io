---
title: 'Instalar Terraform: binario, apt y Docker (con Makefile)'
description: 'Tres formas de instalar Terraform en Linux —el binario oficial, el repositorio apt de HashiCorp y Docker— y un Makefile que reduce el comando de Docker a un simple make plan.'
pubDate: 2026-07-14
tags: ['terraform', 'iac', 'docker', 'linux']
---

En el [post anterior](/blog/de-snapshots-a-infraestructura-como-codigo/) conté por qué acabamos declarando la infraestructura como código. Hoy toca la parte práctica: instalar Terraform y dejarlo listo para trabajar.

La buena noticia es que Terraform es un único binario escrito en Go. No hay runtime que instalar, ni dependencias, ni un demonio corriendo de fondo. Descargas un ejecutable, lo pones en el `PATH` y ya está. Se puede instalar de tres maneras distintas, y cada una encaja mejor en un caso de uso.

La versión de referencia en este post es la última, la 1.15. Si usas otra, tenlo en cuenta al hacer las pruebas: puede que algo cambie entre versiones.

## Opción 1: el binario, a mano

La forma más directa: bajas el zip de la página oficial de releases, lo descomprimes y mueves el ejecutable a un directorio del `PATH`.

```bash
wget https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_linux_amd64.zip
unzip terraform_1.15.8_linux_amd64.zip
sudo mv terraform /usr/local/bin/
terraform version
```

Si todo ha ido bien, la última línea responde con la versión:

```console
Terraform v1.15.8
```

Y ya está instalado. Sin instalador, sin postinstall, sin servicios. Un fichero.

Hay un paso que conviene añadir al proceso: comprobar que el zip que has descargado es realmente el que publicó HashiCorp. Para eso están los checksums. La idea es sencilla: a cada fichero se le puede calcular un hash SHA-256, un valor que cambia por completo si el fichero cambia aunque sea un byte. HashiCorp publica el hash de cada zip junto a la release; si el del tuyo coincide, la descarga es correcta. Si no coincide, puede que la descarga esté comprometida y que lo que tienes en disco no sea la versión oficial, así que mejor no ejecutarlo.

```bash
wget https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_SHA256SUMS
sha256sum -c terraform_1.15.8_SHA256SUMS --ignore-missing
```

La primera línea descarga la lista de checksums oficiales de la release, y la segunda calcula el hash del zip que tienes en disco y lo compara contra esa lista (`--ignore-missing` evita quejas por los ficheros de la lista que no has descargado). Si responde `OK`, puedes seguir tranquilo.

La pega de este método es la que te imaginas: las actualizaciones también van a mano. Cuando salga la 1.16, nadie va a avisarte; te tocará repetir el proceso. Para probar la herramienta o para un servidor concreto va perfecto, pero para tu máquina del día a día hay una opción más cómoda.

## Opción 2: el repositorio apt oficial

HashiCorp mantiene un repositorio apt para Debian y Ubuntu. Se añade una vez y a partir de ahí Terraform se actualiza con el resto del sistema:

```bash
wget -O - https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform
```

Tres líneas: importar la clave GPG con la que HashiCorp firma los paquetes, dar de alta el repositorio e instalar. Un `apt upgrade` normal te trae las versiones nuevas, como con cualquier otro paquete.

Esta es la opción que uso en mi portátil. El problema llega cuando trabajas en varios proyectos y cada uno necesita una versión distinta de Terraform: con apt solo puedes tener una instalada. Para eso existen gestores de versiones como `tfenv`, aunque yo prefiero otra solución que además no instala nada en la máquina.

## Opción 3: Docker

HashiCorp publica una imagen oficial con el binario dentro. Si ya tienes Docker en la máquina —y si trabajas en esto, lo tienes—, no necesitas instalar Terraform en absoluto:

```bash
docker run --rm -it -v "$PWD":/workspace -w /workspace hashicorp/terraform:1.15 version
```

El `entrypoint` de la imagen ya es `terraform`, así que lo que pasas al final es directamente el subcomando: `version`, `init`, `plan`. El `-v` monta tu directorio actual dentro del contenedor y el `-w` hace que Terraform trabaje ahí, de modo que lee tus ficheros `.tf` y deja el estado en tu disco, igual que si lo hubieras ejecutado en local.

Lo que me convence de este método no es ahorrarme una instalación, es otra cosa: **la versión queda escrita**. El `1.15` del tag deja declarado qué Terraform necesita el proyecto. Cualquier compañero que clone el repositorio ejecuta exactamente la misma versión que tú, sin pasos de instalación en el README y sin el clásico "pues a mí me funciona". Y en CI es la misma imagen, así que la pipeline y tu máquina dejan de ser entornos distintos.

Cada proyecto puede fijar la suya: uno viejo puede seguir en `1.5` mientras el nuevo va en `1.15`, conviviendo en la misma máquina sin gestores de versiones ni malabares con el `PATH`.

La pega también es evidente: nadie quiere teclear `docker run --rm -it -v "$PWD":/workspace -w /workspace hashicorp/terraform:1.15` cuarenta veces al día. Y para eso está la herramienta más vieja de todas las que aparecen en este post: `make`.

## Usando Make

Un Makefile en la raíz del proyecto:

```makefile
TF_VERSION ?= 1.15
LAB        ?= labs/01-installing-terraform
TF_IMAGE   := hashicorp/terraform:$(TF_VERSION)
TF_RUN     := docker run --rm -it -v "$(PWD)":/workspace -w /workspace/$(LAB) $(TF_IMAGE)

.PHONY: init plan apply destroy fmt validate version help

init: ## Descarga los providers y prepara el directorio
	$(TF_RUN) init

plan: ## Muestra qué va a cambiar, sin tocar nada
	$(TF_RUN) plan

apply: ## Aplica los cambios (pide confirmación)
	$(TF_RUN) apply

destroy: ## Destruye lo declarado (pide confirmación)
	$(TF_RUN) destroy

fmt: ## Formatea los ficheros .tf
	$(TF_RUN) fmt -recursive

validate: ## Comprueba que la configuración es válida
	$(TF_RUN) validate

version: ## Versión de Terraform dentro del contenedor
	$(TF_RUN) version

help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "%-10s %s\n", $$1, $$2}'
```

A partir de aquí el día a día es `make plan` y `make apply`. Hay dos variables definidas con `?=`, así que se pueden sobreescribir sin editar el fichero. `TF_VERSION` fija la versión de Terraform — útil para probar una nueva antes de cambiarla de verdad — y `LAB` indica en qué directorio se ejecuta, porque cada ejercicio de esta serie va a vivir en su propia carpeta dentro de `labs/`:

```bash
make plan TF_VERSION=1.16
make plan LAB=labs/02-otro-ejercicio
```

Y el target `help` lee los comentarios `##` de cada regla, de forma que `make help` imprime la lista de comandos disponibles sin mantener documentación aparte.

## Comprobar que todo funciona

Para probar la instalación no hace falta una cuenta de GCP ni de AWS. El provider `local` crea ficheros en disco, así que sirve para probar Terraform sin depender de nada externo. Un `main.tf` en `labs/01-installing-terraform/`, el directorio al que apunta el Makefile por defecto:

```hcl
resource "local_file" "pet" {
  filename = "${path.module}/pets.txt"
  content  = "We love pets!"
}
```

Y el ciclo completo que vimos en el post anterior:

```bash
make init    # descarga el provider local
make plan    # "1 to add": va a crear pets.txt
make apply   # lo crea (escribe "yes" cuando pregunte)
cat labs/01-installing-terraform/pets.txt   # We love pets!
```

Como el directorio está montado dentro del contenedor, tanto `pets.txt` como el fichero de estado `terraform.tfstate` aparecen en el directorio del lab, no se quedan dentro del contenedor.

### Paso final: limpieza

Para deshacer las pruebas basta con un comando: destruye todo lo declarado en la configuración (en este caso, el fichero `pets.txt`) y deja el directorio como estaba.

```bash
make destroy
```

He dejado este Makefile, junto al ejemplo, en mi repositorio [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero), que iré ampliando con el resto de posts de la serie.

## En resumen

- **Binario a mano**: perfecto para entender qué es Terraform (un ejecutable y ya) y para máquinas puntuales. Las actualizaciones son cosa tuya.
- **Repositorio apt**: la opción cómoda para tu máquina habitual. Se actualiza con el sistema, pero solo puedes tener una versión.
- **Docker + Makefile**: la versión queda fijada en el repositorio, todo el equipo y el CI ejecutan lo mismo, y no instalas nada. A cambio, necesitas Docker y un pelín de configuración inicial.

No hay una opción mejor que las demás: en mi caso conviven apt en el portátil para trastear rápido y Docker con Makefile en los repositorios que comparto con más gente. Y si en tu equipo usáis OpenTofu en lugar de Terraform, todo lo de arriba aplica igual: también es un binario único, también tiene imagen oficial, y el Makefile solo necesita cambiar de imagen.
