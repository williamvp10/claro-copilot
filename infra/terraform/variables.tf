variable "dokploy_api_url" {
  description = "HTTPS URL of the existing Dokploy API, ending in /api."
  type        = string
  validation {
    condition     = can(regex("^https://[^/]+/api/?$", var.dokploy_api_url))
    error_message = "Use an HTTPS Dokploy API URL ending in /api."
  }
}

variable "dokploy_api_key" {
  description = "Dokploy API key, supplied through TF_VAR_dokploy_api_key."
  type        = string
  sensitive   = true
}

variable "repository_url" {
  description = "Credential-free HTTPS Git URL for the approved Compose source."
  type        = string
  validation {
    condition     = can(regex("^https://[^/@:]+/[^?#]+$", var.repository_url)) && !strcontains(var.repository_url, "@")
    error_message = "Use an HTTPS Git URL without embedded credentials, query strings, or fragments."
  }
}

variable "repository_ref" {
  description = "Reviewed Git branch for the Compose source."
  type        = string
  default     = "main"
}
