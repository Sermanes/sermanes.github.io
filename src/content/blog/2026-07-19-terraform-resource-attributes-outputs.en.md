---
title: 'Connecting resources in Terraform with attributes and outputs'
description: "How to reference one resource's attribute from another, how the implicit dependency graph this creates works, and how to expose those values when the run finishes with output blocks."
pubDate: 2026-07-19T12:00:00
tags: ['terraform', 'iac', 'gcp', 'best-practices']
---

> **Note:** This post was written in Spanish and translated into English with AI assistance. [Read the original](/blog/terraform-resource-attributes-outputs/).

In the [variables post](/blog/terraform-variables/) we parameterized the project and the bucket prefix, but the lab's two resources (`primary` and `backup`) still know nothing about each other. In day-to-day work this rarely holds: a firewall rule needs the network's ID, an instance needs the name of the disk you just created, a DNS record needs a load balancer's IP. Terraform solves this with the **attributes a resource has**: once created, every resource exposes a set of values (an ID, a URL, an IP...) that any other resource can read.

## Connecting two resources by attribute

The syntax is `resource_type.name.attribute`. Let's add a third resource to the lab, an object inside the `primary` bucket whose content points at the `backup` bucket:

```hcl
resource "google_storage_bucket_object" "readme" {
  name    = "README.txt"
  bucket  = google_storage_bucket.primary.name
  content = "Backup copy of this bucket lives at ${google_storage_bucket.backup.self_link}"
}
```

Two references in this block: `google_storage_bucket.primary.name` to say which bucket the object lives in, and `google_storage_bucket.backup.self_link` to put the backup bucket's API URL into the content. You don't write `self_link` yourself, unlike `bucket_prefix`: GCP computes it when the resource is created, and Terraform stores it in the state after the `apply`.

Which attributes a resource exposes is documented in the provider docs, under the "Attributes Reference" section of each resource ([registry.terraform.io](https://registry.terraform.io)). Every resource has at least an `id`; most add attributes specific to the service (`self_link` and `url` on a GCS bucket, `arn` on an AWS resource...).

## The dependency graph this creates

The moment you write `google_storage_bucket.backup.self_link` inside the `readme` resource, Terraform understands that `readme` depends on `backup`, without you having to say so anywhere else. This is called an **implicit dependency**, and it's the normal way to chain resources in Terraform: it's inferred from the references already present in the code, with no need to maintain it separately.

Running it, you'll see the creation order already sorted to satisfy those dependencies:

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

`backup` and `primary` don't depend on each other, so Terraform creates them in parallel; `readme` depends on both (on `primary` through the `bucket` argument, on `backup` through `content`), so it waits for both to finish. Nobody wrote that order down anywhere: it comes purely from the references.

There's also `depends_on`, for cases where the dependency is real but no attribute reflects it. For example, a function that reads from a bucket needs the IAM permission on that bucket to already exist, but that permission has no attribute the function can reference in its code: the relationship is real, but invisible to Terraform unless declared with `depends_on`. Use it only when you truly need to: it blocks the whole resource until the other one finishes, whereas an implicit dependency only waits on the specific attributes being used, so Terraform can parallelize more and plan more precisely. If there's a way to express the order with a reference, that's always the preferable option.

## Exposing values with `output`

An `apply` that creates a bucket is useful, but you usually need some piece of the result: the bucket's URL to paste elsewhere, the exact name that got generated... That's what **outputs** are for:

```hcl
output "primary_bucket_url" {
  description = "gs:// URL of the primary bucket, for use with gsutil or another process."
  value       = google_storage_bucket.primary.url
}

output "backup_bucket_self_link" {
  description = "API URL of the backup bucket."
  value       = google_storage_bucket.backup.self_link
}

output "readme_object_id" {
  description = "Full ID of the README.txt object (bucket/name)."
  value       = google_storage_bucket_object.readme.id
}
```

An `output` block takes `value` (required, the value or expression to expose) and `description` (optional but recommended, just like with variables: the output's name doesn't always make clear what it holds). One thing to watch for if you're coming from older or AI-generated docs: the argument is called `description`, not `desc`; with `desc` Terraform doesn't error, but it doesn't do anything either, and the output stays undocumented.

When the `apply` finishes, Terraform prints all the outputs:

```console
Outputs:

backup_bucket_self_link = "https://www.googleapis.com/storage/v1/b/mycompany-lab05-backup"
primary_bucket_url = "gs://mycompany-lab05-primary"
readme_object_id = "mycompany-lab05-primary/README.txt"
```

They can be looked up again afterwards, without touching anything, all at once or one by one:

```bash
terraform output
terraform output primary_bucket_url
```

## Outputs with sensitive data

If an output exposes a password, a private key, or any attribute the provider itself marks as sensitive, it needs to be declared as such:

```hcl
output "db_password" {
  description = "Generated password for the database user."
  value       = google_sql_user.app.password
  sensitive   = true
}
```

With `sensitive = true`, Terraform hides the value in `plan`, `apply`, and `terraform output` (it shows as `<sensitive>`). If the output references an attribute the provider already marks as sensitive, Terraform requires `sensitive = true` and errors if you leave it out. One important thing that doesn't change: the value still ends up in plaintext inside the state. `sensitive` only hides the output in the terminal, it doesn't protect the state; the actual protection for the state (encrypted backend, access permissions) is what we already covered in the [remote state post](/blog/terraform-state-remoto/).

## Summary

- Once created, a resource exposes **attributes** (`id`, plus resource-specific ones like `self_link` or `url`), readable with `type.name.attribute`.
- Referencing an attribute creates an **implicit dependency**: Terraform orders creation on its own, no `depends_on` needed. Use it whenever you can: it gives Terraform more information to parallelize and plan well.
- `depends_on` is the exception, for dependencies that can't be expressed through a reference.
- An **`output`** block exposes a value once the `apply` finishes, and it can be queried afterwards with `terraform output`. It takes `value` and, as good practice, `description` (the correct argument is `description`, not `desc`).
- Outputs exposing sensitive data need `sensitive = true`; this hides the value in the terminal, but doesn't encrypt it in the state.

The full example is in the [terraform-zero-to-hero](https://github.com/sermanes/terraform-zero-to-hero) repository, in the `labs/05-resource-attributes-outputs` folder.
