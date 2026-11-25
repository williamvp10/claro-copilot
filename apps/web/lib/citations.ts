import type { Citation } from '@claro/contracts';

function publicationHref({ id, source }: Citation) {
  if (!source) return undefined;
  const publication = encodeURIComponent(source.publication);
  const key = encodeURIComponent(source.key);
  return `/fuentes/${publication}/${key}?pasaje=${encodeURIComponent(id)}`;
}

function httpsUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

export function advisorCitationHref(citation: Citation) {
  return publicationHref(citation) ?? httpsUrl(citation.url)?.href;
}

export function publicCitationHref(citation: Citation) {
  // The backend only adds a publication locator to sources with a public viewer.
  const external = httpsUrl(citation.url);
  return publicationHref(citation) ??
    (external?.origin === 'https://normograma.crcom.gov.co' ? external.href : undefined);
}
