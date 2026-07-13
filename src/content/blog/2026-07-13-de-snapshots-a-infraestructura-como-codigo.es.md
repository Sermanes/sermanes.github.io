---
title: 'De snapshots a infraestructura como código'
description: 'Snapshots, Terminator con broadcast y clics en la consola de GCP. Un breve repaso de cómo aprovisionábamos servidores antes, y por qué terminamos declarando la infraestructura como código.'
pubDate: 2026-07-13
tags: ['terraform', 'iac', 'infraestructura', 'gcp']
---

Hubo una época en la que pedir tres máquinas era un trámite administrativo.

No exagero. Negocio decía que quería una aplicación nueva. Un analista recogía los requisitos y se los pasaba a un arquitecto, que dibujaba el despliegue: dos frontales, dos de backend, una base de datos, un balanceador. Ese diseño se convertía en una lista de hardware, y esa lista se convertía en un pedido a un proveedor. Y entonces empezaba la parte lenta: esperar.

Semanas. A veces meses. Y cuando por fin llegaban las cajas, el proceso seguía: se montaba el hardware en el rack, se instalaba el sistema operativo, se configuraba la red, se asignaba el almacenamiento, se aplicaban las políticas de backup. Cada paso, además, esperando a que terminara el anterior. Solo al final de todo eso —y hablamos de un trimestre después de aquella primera reunión— se podía desplegar la aplicación.

Y aquí toca ser honesto: esa parte yo casi no la viví. Cuando entré, la nube ya estaba aquí. Del ciclo completo —el pedido al proveedor, las cajas, el racking— me llegaron sobre todo las historias de los que sí lo sufrieron, y algún resto arqueológico en el CPD que todavía había que mantener. Tuve suerte.

Lo que sí me tocó fue lo de después: máquinas virtuales, snapshots y mucha configuración a mano.

## Lo que de verdad dolía

El problema serio era que **nadie sabía cómo estaban configurados los servidores**. Y no por dejadez: por construcción.

Piensa en cómo se clonaba una máquina. Levantabas una a mano, la dejabas fina —paquetes, usuarios, límites del kernel, el agente de monitorización, las rutas de los logs—, y cuando funcionaba, sacabas un snapshot. Esa era la imagen buena, la definitiva, de la que saldrían las once siguientes.

En teoría. Porque luego mirabas la lista de snapshots y te encontrabas con `base-web-v1`, `base-web-v2`, `base-web-definitiva`, `base-web-definitiva-OK`, `base-web-definitiva-BUENA-usar-esta`. Y ninguno de los cinco tenía una nota explicando en qué se diferenciaba del anterior. La imagen definitiva nunca era la última; era la que el compañero del turno anterior te dijo de palabra que usaras.

Y aun así funcionaba. El día 1.

El día 30 salía un CVE. Y entonces descubrías la trampa: el snapshot ya era una mentira. Aquellas doce máquinas llevaban un mes encendidas en producción, y cada una había derivado por su cuenta. En una se instaló un paquete de debug para investigar una incidencia y nadie lo quitó. En otra se tocó un `sysctl` a mano un viernes por la tarde. Una tercera se reinició antes de que terminara un `apt upgrade`. El snapshot describía cómo *nacieron*, no cómo *estaban*.

Así que hacías lo único que se podía hacer: SSH a las doce. Y para no perder la cabeza, abrías **Terminator**, partías la ventana en doce paneles, activabas el broadcast y escribías una vez para que la misma tecla cayera en las doce sesiones a la vez.

Aquello no era automatización: era teclear más rápido. Bastaba un `sudo` en el panel equivocado, o una máquina que no estuviera exactamente en el mismo estado que las otras once, y el broadcast te aplicaba el error en las doce a la vez.

Y por debajo de todo esto había una verdad incómoda: **el estado real de tu infraestructura solo existía dentro de las máquinas**. No existía en ningún documento, ni en ningún repositorio, ni en ningún sitio que pudieras leer, revisar o comparar. Existía en doce discos, y para consultarlo tenías que entrar a preguntarle a cada uno.

A eso hay que sumarle el otro pecado del modelo: como pedir hardware tardaba meses, dimensionabas para el pico. Comprabas para el Black Friday y pagabas electricidad para el Black Friday los otros 364 días del año. Recursos parados por si acaso.

## La nube no arregló el problema. Lo movió de sitio.

Llegaron AWS, Azure y GCP y aquello cambió de verdad. Nada de esperar al proveedor: una VM en minutos. Nada de racks, ni de discos, ni de cableado. Y —esto es lo importante— **una API detrás de todo**.

Pero mira lo que hicimos con esa API el primer día: abrir la consola web y darle a los botones.

Y ahí está la contradicción. La nube te vende elasticidad: crea y destruye cuando quieras, escala con la demanda. Pero si cada creación es un humano haciendo clic en un formulario —lo que se acabó llamando **ClickOps**—, has recreado el problema anterior con mejor latencia: nadie sabe por qué la instancia de staging tiene un disco de 200 GB y la de producción de 100, no puedes revisar un cambio antes de que ocurra, y las doce máquinas siguen sin poder describirse sin entrar a mirarlas. Lo único que ha mejorado es la velocidad a la que te equivocas.

## El siguiente intento: scripts

La reacción natural fue obvia: si hay una API, hagamos scripts que la llamen. Bash con `gcloud`. Python con el SDK. Y funcionaba, hasta cierto punto.

Hasta que ejecutabas el script dos veces.

Porque un script es imperativo: describe **pasos**, no **estado**. Le dices "crea una instancia" y la crea. Que ya existiera una le da igual: o revienta con un error, o te acabas encontrando dos. Así que empiezas a defenderte: comprobar si existe antes de crear, comparar la configuración actual con la deseada, decidir si toca modificar o recrear, gestionar el orden de las dependencias... y de repente tu script de aprovisionamiento tiene 400 líneas y el 80% son comprobaciones.

En ese punto ya no estás escribiendo un script. Estás escribiendo, mal, un motor de reconciliación.

## Declarar en vez de ordenar

La idea que lo cambia todo es dejar de dar órdenes y empezar a describir el resultado.

En lugar de decir *"crea una instancia"*, dices *"quiero que exista esta instancia, así"*. Y dejas que la herramienta averigüe qué hay que hacer para llegar hasta ahí: crearla si no existe, modificarla si difiere, no tocar nada si ya está bien.

Eso es infraestructura como código, y eso es lo que hace Terraform. Se instala como un binario y habla con las plataformas a través de **providers**, que son plugins que traducen a la API de cada una. Y no hablamos solo de nubes: hay providers para GCP, AWS y Azure, claro, pero también para DNS, Cloudflare, Datadog, GitHub, PostgreSQL o Auth0. Si tiene API, se puede declarar.

Una instancia en GCP se describe así:

```hcl
resource "google_compute_instance" "web" {
  name         = "web-01"
  machine_type = "e2-medium"
  zone         = "europe-southwest1-a"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    network = "default"
  }
}
```

Eso es HCL, el lenguaje de configuración de Terraform, y no describe una secuencia de llamadas. Describe un hecho: esta instancia existe, se llama así, es de este tamaño, arranca de esta imagen.

Ahora vuelve al escenario de antes. Quieres subir la máquina a `e2-standard-2`. Cambias una línea. No clonas un snapshot, no montas una imagen nueva, no abres Terminator. Y si necesitas doce máquinas iguales, no abres doce pestañas: es un `count` o un `for_each`, y las doce salen exactamente de la misma definición. Ya no hay "la máquina rara que alguien tocó un viernes", porque no hay una vía manual para tocarla.

## Init, plan, apply (y por qué `plan` es la parte importante)

El flujo de Terraform son tres fases:

- **`init`** descarga los providers que necesita tu configuración.
- **`plan`** compara lo que has declarado con lo que existe de verdad, y te dice qué va a hacer.
- **`apply`** lo ejecuta.

De las tres, la que cambió mi forma de trabajar es la de en medio.

`terraform plan` te dice qué va a pasar antes de que pase: voy a crear esto, voy a modificar aquello, y voy a destruir esta otra cosa. Y ese tercer verbo es la razón de leer el plan entero, siempre, aunque el cambio parezca de una línea.

Vamos con un ejemplo. Subir la máquina de `e2-medium` a `e2-standard-2` es un cambio en caliente: Terraform la para, le cambia el tipo y la arranca. Un `1 to change`. Ahora imagina que lo que tocas es la imagen del disco de arranque, de `debian-12` a `debian-13`. Es una línea, y en el diff se parecen muchísimo. Pero el plan responde con otra cosa:

```text
  # google_compute_instance.web must be replaced
-/+ resource "google_compute_instance" "web" {
      ~ boot_disk {
          ~ initialize_params {
              ~ image = "debian-cloud/debian-12" -> "debian-cloud/debian-13"
                # forces replacement
            }
        }
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

**`forces replacement`.** Ese campo no se puede modificar en una máquina existente, así que Terraform solo tiene un camino: destruir la instancia y crear otra nueva. Y eso, en producción, significa cosas muy concretas: se pierde todo lo que hubiera en el disco, la IP interna puede cambiar, y hay una caída entre que muere una y arranca la siguiente.

Es exactamente el mismo tipo de daño que causabas antes por accidente, cuando reconstruías una máquina "porque el snapshot estaba desfasado" y te llevabas por delante algo que solo existía en ese disco. La diferencia es *cuándo* te enteras.

Antes te enterabas después. Ahora `plan` te lo enseña antes de tocar nada, mientras producción sigue en pie, y decides tú: o aceptas el reemplazo con una ventana de mantenimiento, o cambias de estrategia.

Y esto es lo que me parece bonito del `plan`: no te pide que sepas de memoria qué campos de una instancia de GCP son inmutables y cuáles no. Te lo dice él, en tu caso concreto, con tu configuración delante y sin haber tocado nada todavía. El `forces replacement` y el `1 to destroy` de la última línea son la herramienta contándote las consecuencias de tu cambio en un idioma que se entiende, cuando aún puedes cambiar de opinión.

Ninguna de las formas anteriores de trabajar tenía eso. Ni la consola, ni los scripts, ni desde luego el broadcast de Terminator.

## En resumen

Tres ideas que me llevo de todo esto:

- **El problema nunca fue la lentitud del hardware.** Era que el estado real de la infraestructura solo existía dentro de las máquinas, y no había forma de leerlo, revisarlo ni compararlo sin entrar a mirar una por una.
- **La nube no lo arregló sola.** Aprovisionar a golpe de clic en la consola resuelve la espera, pero mantiene intactos el trabajo manual, la inconsistencia y el no saber qué hay montado. Más rápido, sí, pero igual de opaco.
- **Lo que cambia el juego es declarar en vez de ordenar.** Describes el estado que quieres, y la herramienta calcula cómo llegar. El código pasa a ser la fuente de verdad, y `plan` te enseña las consecuencias antes de aplicarlas.

Terraform no es magia: es un binario, unos providers y un ciclo de `init`, `plan` y `apply`. Tampoco es la única opción: OpenTofu, Pulumi, CloudFormation o Crossplane juegan en la misma liga, cada una con sus matices. He tirado de Terraform simplemente porque es la más extendida, pero la idea de fondo —declarar en vez de ordenar— es la misma en todas.

Y esa idea es la que importa. Después de años tirando de snapshots y de paneles de Terminator, poder abrir un fichero y *leer* lo que hay montado sigue pareciéndome un cambio enorme.
