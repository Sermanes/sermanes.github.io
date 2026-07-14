---
title: 'Remote state in Terraform: a bucket, a lock, and no more stepping on each other'
description: "What Terraform's state file is, why keeping it on your laptop doesn't scale in a team, and how to move it to a Google Cloud Storage bucket with locking so two people can't apply changes at the same time."
pubDate: 2026-07-14T12:00:00
tags: ['terraform', 'iac', 'gcp', 'teams']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-state-remoto/).

In the [previous post](/en/blog/instalar-terraform/) we got Terraform installed and working. If you ran the examples, you probably noticed a new file showed up in the directory after the `apply`: `terraform.tfstate`. Today we talk about it, because that file is the reason Terraform works beautifully on your laptop and becomes a problem the day there are two of you.

## What the state is and why it matters

When you run `terraform apply`, Terraform doesn't just create resources: it records in the state what it created and with which attributes. That file is the map connecting your code to your real infrastructure. When you later run `terraform plan`, Terraform compares three things: what your code declares, what the state says, and what actually exists in the provider. The "2 to add, 1 to change" comes out of that comparison.

Without the state, Terraform doesn't know which resources are its own. It couldn't tell the instance it created apart from one somebody spun up by hand, and it wouldn't know what to tear down on `terraform destroy`. That's why losing the state is one of the worst things that can happen to a Terraform project: the infrastructure is still there, but Terraform no longer knows it owns it.

And there's one more detail worth knowing from day one: **the state stores values in plain text**. Database passwords, tokens, private keys... if a resource has a sensitive attribute, it shows up unencrypted in the state. That has two immediate consequences: `terraform.tfstate` never gets committed (it goes straight into `.gitignore`), and wherever you store it, it must be encrypted and access-restricted.

## The problem with local state

While you work alone, local state is fine. The trouble starts the day a teammate clones the repository: they have the code, but not the state, because it lives on your disk. If they run `terraform apply`, Terraform finds no state, assumes nothing exists, and tries to create the whole infrastructure all over again. In the best case it fails on duplicate names; in the worst, you end up with duplicated resources billing you twice.

And even if you pass the file around, the second problem remains: **concurrency**. If you and your teammate run `apply` at the same time, you both read the same state, both make changes to the infrastructure, and both write your result. The last writer wipes out what the other one wrote, and the state stops reflecting reality. It's exactly the same race condition as in any system with a shared resource and no lock.

The solution has two parts, and both come built into Terraform: store the state somewhere shared (a **remote backend**) and lock it while someone is using it (**state locking**).

## What the options are

Terraform calls the place where it stores the state a **backend**, and it supports quite a few. The ones you'll actually run into in practice:

- **A bucket**: S3 on AWS, Cloud Storage on GCP (`gcs`) or a Storage Account on Azure (`azurerm`). The most common option by far: cheap, durable storage with versioning and encryption, and all three support automatic locking.
- **HCP Terraform** (formerly Terraform Cloud): the state lives in HashiCorp's platform, which also adds remote execution, run history and approvals. It has a free tier and is a very reasonable option if you don't want to manage even the bucket.
- **GitLab**: if your code already lives there, GitLab offers managed state through the generic `http` backend, locking included. The state sits next to the repository, no extra infrastructure.
- **PostgreSQL** (`pg`): the state in a table, with locking via advisory locks. Makes sense if you're not on any public cloud but already have a Postgres.
- **Kubernetes** (in a Secret) and **Consul** (in its KV store): more niche options, for teams whose platform already revolves around those tools.

Conceptually they all do the same thing: shared state, encrypted and locked. Pick the one that fits what you already have. In this post we'll set up a Google Cloud Storage bucket.

## Creating the backend

First, the bucket. You can create it from the Google Cloud console or with the CLI, but a couple of settings are not optional:

```bash
gcloud storage buckets create gs://mycompany-terraform-state \
  --project=my-project \
  --location=europe-west1 \
  --uniform-bucket-level-access \
  --public-access-prevention

# Versioning: every state write keeps the previous version
gcloud storage buckets update gs://mycompany-terraform-state --versioning
```

Argument by argument:

- **`gs://mycompany-terraform-state`**: the bucket name. Bucket names are global across all of GCS (no two can be the same anywhere in the world), so it's a good idea to prefix it with your company name.
- **`--project`**: the GCP project the bucket belongs to (and which gets billed for the storage).
- **`--location`**: where the data physically lives. A specific region like `europe-west1` is the cheap option; it also accepts multi-region (`eu`) if you want geographic redundancy.
- **`--uniform-bucket-level-access`**: disables per-object ACLs, the old way of granting permissions in GCS. With this, access is controlled only through IAM and at the bucket level: a single list of who can read and write, with no file-by-file exceptions.
- **`--public-access-prevention`**: makes it impossible to expose the bucket or its contents publicly, even if someone tries later. A direct consequence of what we said earlier: the state carries secrets inside.
- **`--versioning`** (in the second command): enables object versioning. It's the safety net: every write keeps the previous version, so if an apply leaves the state broken or someone deletes it by accident, you restore the good version from the console or with `gcloud storage`.

What about encryption? On GCS there's nothing to enable: everything is encrypted at rest by default. If your company needs to manage its own keys you can set that up with Cloud KMS, but you don't need it to get started.

You may have noticed something: I just created infrastructure by hand, exactly what we've spent two posts saying you shouldn't do. It's the chicken-and-egg problem: the bucket that stores the state can't (yet) be managed from the state it's going to store. The usual convention is to accept it: the state bucket gets created once, by hand or with a tiny separate bootstrap project, and never touched again.

## Pointing Terraform at the backend

With the bucket ready, telling Terraform to use the remote backend is one more block in the project's configuration. It can go in any `.tf` file in the directory, because Terraform reads them all, though the usual spots are `main.tf`, inside the `terraform` block, or a separate `backend.tf` file so it's easy to find:

```hcl
terraform {
  backend "gcs" {
    bucket = "mycompany-terraform-state"
    prefix = "projects/web"
  }
}
```

Two important details here:

- **`prefix`** is the folder inside the bucket where this project stores its state. A single bucket can serve several projects, but each Terraform project needs its own state file (if they shared one, their resources would get mixed up), and the `prefix` is what keeps them apart. With this configuration, this project writes to `projects/web/default.tfstate` (Terraform picks the file name); the API project, with its own `prefix`, would write to `projects/api/default.tfstate`. Since each project only reads and writes under its own path, an apply in one can't touch another one's resources. How many buckets to have is up to each company: a single one with prefixes is the simplest to manage, but it's also common to split by team or by environment, with the production bucket in a separate project under stricter permissions, to limit the blast radius.
- **Locking doesn't appear in the configuration** because on GCS it comes built in: there's nothing to enable. (If you work on AWS, the `s3` backend does ask for it explicitly: `use_lockfile = true`, available since Terraform 1.10. It used to require a separate DynamoDB table; that method still works, but it's deprecated.)

For Terraform to talk to the bucket it needs Google Cloud credentials. Locally, the usual way is Application Default Credentials: run `gcloud auth application-default login` once and you're set.

After adding the block, `terraform init` detects the backend change. If you already had a local state from your experiments, it asks whether you want to migrate it:

```console
$ terraform init -migrate-state

Initializing the backend...
Do you want to copy existing state to the new backend?
  Enter a value: yes

Successfully configured the backend "gcs"!
```

From here on, the local `terraform.tfstate` disappears from the workflow: every `plan` and every `apply` reads and writes directly to the bucket. Your teammate clones the repository, runs `terraform init`, and works against the same state as you. No file passing.

## Locking in action

The locking part requires nothing extra: it's automatic. Every time an operation is about to write the state, Terraform first creates a lock file next to the state in the bucket (`default.tflock`). If someone else launches an `apply` in the meantime, they run into this:

```console
$ terraform apply

Error: Error acquiring the state lock

Lock Info:
  ID:        b4ee5872-3a67-1c5d-f21e-5a3c2e8b9d10
  Operation: OperationTypeApply
  Who:       ana@anas-laptop
  Created:   2026-07-14 10:32:18 UTC
```

And this, which looks like an error, is exactly what we wanted: Terraform refuses to run until Ana's operation finishes and releases the lock. The message even tells you who holds it and since when, so instead of trampling their work, you ping them or simply wait. With `-lock-timeout=2m` you can tell Terraform to retry for a while instead of failing immediately.

If a lock ever gets stuck (typically because an apply died halfway through, a network drop or an ill-timed Ctrl+C), there's `terraform force-unlock <ID>`. But it's the last resort: before using it, confirm with the team that there really is no operation in progress. If you release the lock while someone else's apply is still running, you'll both end up writing the state at the same time: exactly the race condition the lock was preventing.

## What about the Docker Makefile?

If you use the `terraform.mk` from the [previous post](/en/blog/instalar-terraform/), the only missing piece is letting the container see your Google Cloud credentials. Just add one line to `TF_RUN` that mounts, read-only, the directory where `gcloud` keeps the Application Default Credentials:

```makefile
TF_RUN := docker run --rm -it \
	-v "$(CURDIR)":/workspace -w /workspace \
	-v "$(HOME)/.config/gcloud":/root/.config/gcloud:ro \
	$(TF_IMAGE)
```

The container uses your `gcloud` session's credentials without anything being written to any file in the repository.

## In summary

- The **state** is the map between your code and the real resources. Without it, Terraform is blind. And since it contains secrets in plain text, it should never be committed to the repository.
- In a team, local state causes two problems: everyone has their own version of reality, and two simultaneous applies wipe each other out.
- A **remote backend** (GCS, S3, Azure Storage) solves the first; **locking** solves the second. On GCS it comes built in, nothing to configure; on S3, `use_lockfile = true` is all you need since Terraform 1.10.
- The state bucket gets configured once and properly: **versioning, no public access, and remember to encrypt it**.
- A single bucket can serve the whole company by using a different `prefix` per project and environment.

The full example from this post lives, like the previous ones, in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, under `labs/02-remote-state`.
