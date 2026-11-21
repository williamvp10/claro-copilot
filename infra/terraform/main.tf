terraform {
  required_version = ">= 1.5.0"
  required_providers {
    dokploy = {
      source  = "ahmedali6/dokploy"
      version = "0.8.0"
    }
  }
}

provider "dokploy" {
  host    = var.dokploy_api_url
  api_key = var.dokploy_api_key
}

resource "dokploy_project" "demo" {
  name        = "Claro Copiloto"
  description = "Claro Copiloto demo"
}

resource "dokploy_environment" "demo" {
  name       = "Demo"
  project_id = dokploy_project.demo.id
}

resource "dokploy_compose" "demo" {
  name              = "claro-copiloto"
  environment_id    = dokploy_environment.demo.id
  source_type       = "git"
  custom_git_url    = var.repository_url
  custom_git_branch = var.repository_ref
  compose_path      = "./infra/compose.yaml"
  auto_deploy       = false
  deploy_on_create  = false
}
