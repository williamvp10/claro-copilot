# Dokploy Terraform configuration

This is a configuration for an **existing** Dokploy host. It declares a project, a demo environment, and a Compose source using the community `ahmedali6/dokploy` provider, pinned at 0.8.0. No Dokploy-maintained Terraform provider was found in the provider registry or Dokploy's GitHub organization at preparation time. This community provider is a dependency to review and approve before use; consult its [provider](https://registry.terraform.io/providers/ahmedali6/dokploy/0.8.0/docs), [project](https://registry.terraform.io/providers/ahmedali6/dokploy/0.8.0/docs/resources/project), [environment](https://registry.terraform.io/providers/ahmedali6/dokploy/0.8.0/docs/resources/environment), and [Compose](https://registry.terraform.io/providers/ahmedali6/dokploy/0.8.0/docs/resources/compose) documentation. Neither a VPS, DNS, TLS, registry, secret manager nor deployment is provisioned here.

The Git source points to `infra/compose.yaml` and disables both automatic and initial deployment. Use a credential-free HTTPS Git URL accessible to Dokploy; a private repository requires a separately configured access mechanism and corresponding provider configuration. Pin the approved image digest via `CLARO_IMAGE` in Dokploy and use a deployment command that pulls it without rebuilding; the source branch itself is mutable and is not release evidence. Configure networking, routing, TLS, backups and runtime variables in Dokploy before any separately authorized deployment. See `../README.md` for release checks. The exact Git-source behavior and disabled-deploy semantics must be verified against the chosen Dokploy/provider versions before applying; this module has not been applied to a server.

## Validate and plan

Terraform and provider installation require access to the registry. `terraform init -backend=false` followed by `terraform validate` checks syntax and provider schema without a Dokploy API or real values. It does not test API compatibility, source accessibility, Compose execution, or whether the provider creates or changes remote resources as expected. A real `terraform plan` requires a reachable Dokploy API, its API key, repository URL and appropriate permissions; no mock plan is a substitute. Review the plan carefully, including the possibility that project creation automatically creates a default environment. Import existing resources first where appropriate to avoid duplicates.

```sh
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
# For a real read/plan only, use a controlled shell or secret manager:
export TF_VAR_dokploy_api_url='https://<dokploy-host>/api'
export TF_VAR_dokploy_api_key='<from secret manager>'
export TF_VAR_repository_url='https://<git-host>/<owner>/<repository>.git'
terraform -chdir=infra/terraform plan
```

Do not commit credentials, state, plans, `.terraform`, or variable files containing secrets. Terraform state and plan files may contain sensitive provider or remote resource information even when values are marked sensitive; use encrypted, access-controlled remote state and locking for real work. Runtime secrets are intentionally not set through Terraform; configure them directly in Dokploy, and verify the provider does not overwrite out-of-band values before applying updates. No plan or apply has been performed here.
