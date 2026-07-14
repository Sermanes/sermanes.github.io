---
title: 'Installing Terraform: binary, apt and Docker (with a Makefile)'
description: 'Three ways to install Terraform on Linux — the official binary, the HashiCorp apt repository and Docker — plus a Makefile that turns the Docker command into a simple make plan.'
pubDate: 2026-07-14
tags: ['terraform', 'iac', 'docker', 'linux']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/instalar-terraform/).

In the [previous post](/en/blog/de-snapshots-a-infraestructura-como-codigo/) I explained why we ended up declaring infrastructure as code. Today it's the practical part: installing Terraform and getting it ready to work with.

The good news is that Terraform is a single binary written in Go. There's no runtime to install, no dependencies, no daemon running in the background. You download an executable, put it on your `PATH` and that's it. There are three different ways to install it, and each one fits a different use case.

The reference version in this post is the latest one, 1.15. If you use a different one, keep it in mind when you run the examples: things may change between versions.

## Option 1: the binary, by hand

The most direct way: download the zip from the official releases page, unzip it and move the executable to a directory on your `PATH`.

```bash
wget https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_linux_amd64.zip
unzip terraform_1.15.8_linux_amd64.zip
sudo mv terraform /usr/local/bin/
terraform version
```

If everything went well, the last line answers with the version:

```console
Terraform v1.15.8
```

And it's installed. No installer, no post-install, no services. One file.

There's one step worth adding to the process: checking that the zip you downloaded is really the one HashiCorp published. That's what checksums are for. The idea is simple: for any file you can compute a SHA-256 hash, a value that changes completely if the file changes by even one byte. HashiCorp publishes the hash of every zip next to each release; if yours matches, the download is correct. If it doesn't, the download may be compromised and what you have on disk may not be the official version, so better not to run it.

```bash
wget https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_SHA256SUMS
sha256sum -c terraform_1.15.8_SHA256SUMS --ignore-missing
```

The first line downloads the official checksum list for the release, and the second computes the hash of the zip you have on disk and compares it against that list (`--ignore-missing` avoids complaints about files on the list you didn't download). If it answers `OK`, you're good to go.

The downside of this method is the one you'd expect: updates are manual too. When 1.16 comes out, nobody is going to tell you; you'll have to repeat the process. For trying the tool out or for a specific server it works fine, but for your everyday machine there's a more convenient option.

## Option 2: the official apt repository

HashiCorp maintains an apt repository for Debian and Ubuntu. You add it once and from then on Terraform updates along with the rest of the system:

```bash
wget -O - https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform
```

Three lines: import the GPG key HashiCorp signs its packages with, register the repository and install. A regular `apt upgrade` brings in new versions, like any other package.

This is the option I use on my laptop. The problem comes when you work on several projects and each one needs a different Terraform version: with apt you can only have one installed. Version managers like `tfenv` exist for that, although I prefer another solution that also installs nothing on the machine.

## Option 3: Docker

HashiCorp publishes an official image with the binary inside. If you already have Docker on the machine — and if you work in this field, you do — you don't need to install Terraform at all:

```bash
docker run --rm -it -v "$PWD":/workspace -w /workspace hashicorp/terraform:1.15 version
```

The image's `entrypoint` is already `terraform`, so what you pass at the end is the subcommand itself: `version`, `init`, `plan`. The `-v` mounts your current directory inside the container and the `-w` makes Terraform work from there, so it reads your `.tf` files and leaves the state on your disk, just as if you had run it locally.

What sells me on this method isn't skipping an installation, it's something else: **the version is written down**. The `1.15` in the tag declares which Terraform the project needs. Any teammate who clones the repository runs exactly the same version as you, with no install steps in the README and no classic "well, it works on my machine". And in CI it's the same image, so the pipeline and your machine stop being different environments.

Each project can pin its own: an old one can stay on `1.5` while the new one runs `1.15`, both living on the same machine with no version managers and no `PATH` juggling.

The downside is obvious too: nobody wants to type `docker run --rm -it -v "$PWD":/workspace -w /workspace hashicorp/terraform:1.15` forty times a day. And that's what the oldest tool in this whole post is for: `make`.

## Using Make

A Makefile at the root of the project:

```makefile
TF_VERSION ?= 1.15
TF_IMAGE   := hashicorp/terraform:$(TF_VERSION)
TF_RUN     := docker run --rm -it -v "$(PWD)":/workspace -w /workspace $(TF_IMAGE)

.PHONY: init plan apply destroy fmt validate version help

init: ## Download providers and prepare the directory
	$(TF_RUN) init

plan: ## Show what would change, without touching anything
	$(TF_RUN) plan

apply: ## Apply the changes (asks for confirmation)
	$(TF_RUN) apply

destroy: ## Destroy everything declared (asks for confirmation)
	$(TF_RUN) destroy

fmt: ## Format the .tf files
	$(TF_RUN) fmt -recursive

validate: ## Check that the configuration is valid
	$(TF_RUN) validate

version: ## Terraform version inside the container
	$(TF_RUN) version

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "%-10s %s\n", $$1, $$2}'
```

From here on, day-to-day work is `make plan` and `make apply`. The version is defined in a variable with `?=`, so it can be overridden without editing the file — useful for trying a new version before actually switching:

```bash
make plan TF_VERSION=1.16
```

And the `help` target reads the `##` comments on each rule, so `make help` prints the list of available commands without maintaining separate documentation.

## Checking that everything works

To test the installation you don't need a GCP or AWS account. The `local` provider creates files on disk, so it lets you try Terraform without depending on anything external. A `main.tf` next to the Makefile:

```hcl
resource "local_file" "pet" {
  filename = "${path.module}/pets.txt"
  content  = "We love pets!"
}
```

And the full cycle we saw in the previous post:

```bash
make init      # downloads the local provider
make plan      # "1 to add": it will create pets.txt
make apply     # creates it (type "yes" when asked)
cat pets.txt   # We love pets!
```

Since the directory is mounted inside the container, both `pets.txt` and the state file `terraform.tfstate` end up in the project directory — they don't stay inside the container.

### Final step: cleanup

Undoing the test takes one command: it destroys everything declared in the configuration (in this case, the `pets.txt` file) and leaves the directory as it was.

```bash
make destroy
```

I've left this Makefile, along with the example, in my [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, which I'll keep extending with the rest of the posts in this series.

## In summary

- **Binary by hand**: great for understanding what Terraform is (an executable, and that's it) and for one-off machines. Updates are on you.
- **apt repository**: the convenient option for your everyday machine. It updates with the system, but you can only have one version.
- **Docker + Makefile**: the version is pinned in the repository, the whole team and CI run the same thing, and you install nothing. In exchange, you need Docker and a bit of initial setup.

There's no single best option: in my case, apt on the laptop for quick experiments coexists with Docker plus Makefile in the repositories I share with other people. And if your team uses OpenTofu instead of Terraform, everything above applies the same way: it's also a single binary, it also has an official image, and the Makefile only needs a different image name.
