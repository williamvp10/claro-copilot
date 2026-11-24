# /// script
# requires-python = ">=3.11"
# dependencies = ["pypdf==6.21.4", "reportlab==4.4.9"]
# ///
"""Build the fictional Claro demo corpus from an explicitly reviewed file list."""
from __future__ import annotations
import argparse
from io import BytesIO
import json
from hashlib import sha256
import os
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from email import policy
from email.parser import BytesParser
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from pypdf import PdfReader

# No directories are globbed. Three reviewed operational bulletins are advisor-only; transcripts and customer records are excluded.
# Documents without an explicit effective date use the exercise snapshot date, not a claimed publication date.
@dataclass(frozen=True)
class Source:
    path: str
    key: str
    title: str
    version: str
    scope: str
    kind: str
    effective_from: str = '2026-11-18'
    official_url: str | None = None

SOURCES = (
    Source('01_documentos/catalogo/Catalogo_Planes_Claro_2026.pdf','catalogo-v1','Catálogo de planes y tarifas','CAT-2026 v1.0','public','catalogo','2026-11-01'),
    Source('06_actualizaciones/Catalogo_Planes_Claro_2026_v2.pdf','catalogo-v2','Catálogo de planes y tarifas','CAT-2026 v2.0','public','catalogo','2026-12-01'),
    Source('01_documentos/faq/FAQ_Atencion_Clientes.md','faq','Preguntas frecuentes de atención','FAQ 2026-11-01','public','soporte','2026-11-01'),
    Source('01_documentos/manuales/Manual_Decodificador_DecoBox4K.pdf','deco','Manual de decodificador DecoBox 4K','MAN-DBX4K Rev. A','public','soporte'),
    Source('01_documentos/manuales/Manual_Modem_ZTX-F680.pdf','modem','Manual de módem ZTX-F680','MAN-ZTX-F680 Rev. B','public','soporte'),
    Source('01_documentos/contratos_politicas/Politica_Retencion_Clientes.docx','retencion','Política de retención','POL-RET-2026 v3.1','advisor','politica'),
    Source('01_documentos/contratos_politicas/Politica_Escalamiento_Atencion.docx','escalamiento','Política de escalamiento','demo-2026-11-18','advisor','politica'),
    Source('01_documentos/contratos_politicas/Politica_Portabilidad_Numerica.docx','portabilidad','Política de portabilidad','POL-POR-2026','advisor','politica'),
    Source('01_documentos/contratos_politicas/Politica_Facturacion_y_Pagos.docx','facturacion','Política de facturación','demo-2026-11-18','advisor','politica'),
    Source('01_documentos/contratos_politicas/Contrato_Servicios_Hogar.docx','contrato-hogar','Contrato de servicios hogar','demo-2026-11-18','advisor','contrato'),
    Source('01_documentos/contratos_politicas/Contrato_Servicios_Movil_Pospago.docx','contrato-movil','Contrato de servicios móviles pospago','demo-2026-11-18','advisor','contrato'),
    Source('01_documentos/correos/01_recordatorio_promo_fibra500.eml','boletin-promo','Alcance de la Promoción Fibra 500','boletin-2026-11-09','advisor','boletin','2026-11-09'),
    Source('01_documentos/correos/02_incidente_masivo_chapinero.eml','boletin-incidente','Incidente de fibra en Chapinero y compensación','boletin-2026-11-13','advisor','boletin','2026-11-13'),
    Source('01_documentos/correos/03_nuevo_refresco_senal_app.eml','boletin-refresco','Refrescar señal de TV desde Mi Claro','boletin-2026-11-03','advisor','boletin','2026-11-03'),
    Source('docs/agente/fuentes-publicas/portabilidad-movil-crc.md','crc-portabilidad','CRC · Guía de portabilidad móvil',
           'CRC 5050 · revisión 2026-11-18','public','politica',
           official_url='https://normograma.crcom.gov.co/crc/compilacion/docs/resolucion_crc_5050_2016.htm'),
)
REPO = Path(__file__).resolve().parents[3]
VIEWABLE = {'catalogo-v1', 'catalogo-v2', 'faq', 'deco', 'modem'}
MAX_CHUNK = 1800
WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def text_of(node: ET.Element) -> str:
    return ''.join(part.text or '' for part in node.iter(WORD + 't')).strip()


def docx_blocks(path: Path) -> list[tuple[str, str]]:
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
    body = root.find(WORD + 'body')
    if body is None:
        raise ValueError(f'Invalid DOCX: {path.name}')
    blocks: list[tuple[str,str]] = []
    section = 'Documento'
    for node in body:
        if node.tag == WORD + 'p':
            text = text_of(node)
            if not text:
                continue
            style = node.find('./' + WORD + 'pPr/' + WORD + 'pStyle')
            style_name = style.get(WORD + 'val', '') if style is not None else ''
            if style_name.lower().startswith(('heading','titulo','title')) or re.match(r'^\d+\.\s+\D', text):
                section = text[:140]
            blocks.append((section, text))
        elif node.tag == WORD + 'tbl':
            for row in node.findall(WORD + 'tr'):
                cells = [text_of(cell) for cell in row.findall(WORD + 'tc')]
                if any(cells):
                    blocks.append((section, ' | '.join(cells)))
    return blocks


def markdown_blocks(path: Path) -> list[tuple[str,str]]:
    section = 'Documento'
    result: list[tuple[str,str]] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith('#'):
            section = line.lstrip('#').strip()[:140]
        result.append((section, line))
    return result


def pdf_blocks(path: Path) -> tuple[list[tuple[str,str]], str]:
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        raise ValueError(f'Encrypted PDF: {path.name}')
    result: list[tuple[str,str]] = []
    first_page = ''
    for n, page in enumerate(reader.pages, 1):
        raw = page.extract_text() or ''
        if not raw.strip():
            raise ValueError(f'PDF page requires OCR: {path.name} page {n}')
        if n == 1:
            first_page = raw
        section = f'pág. {n}'
        for line in raw.splitlines():
            line = re.sub(r'\s+', ' ', line).strip()
            if not line or 'DOCUMENTO FICTICIO – Uso exclusivo' in line:
                continue
            if re.match(r'^\d+\.\s+\D', line):
                section = f'pág. {n} · {line[:120]}'
            result.append((section, line))
    return result, first_page


def chunks(blocks: list[tuple[str,str]]):
    section, parts, size = '', [], 0
    for next_section, block in blocks:
        # Bound every excerpt, splitting on whitespace if a source paragraph is unusually long.
        words = block.split()
        pieces: list[str] = []
        current = ''
        for word in words:
            if len(word) > MAX_CHUNK:
                raise ValueError('Source contains an oversized token')
            if len(current) + len(word) + 1 > MAX_CHUNK:
                pieces.append(current)
                current = ''
            current = f'{current} {word}'.strip()
        if current:
            pieces.append(current)
        for piece in pieces:
            if parts and (section != next_section or size + len(piece) + 1 > MAX_CHUNK):
                yield section, '\n'.join(parts)
                parts, size = [], 0
            section = next_section
            parts.append(piece)
            size += len(piece) + 1
    if parts:
        yield section, '\n'.join(parts)


def describe_passage(source: Source, section: str, excerpt: str) -> dict:
    text = ''.join(ch for ch in unicodedata.normalize('NFD', section + ' ' + excerpt)
                   if not unicodedata.combining(ch)).lower()
    tags = {source.kind, source.key.split('-v')[0]}
    for tag, pattern in {
        'hogar': r'\bhogar\b|fibra', 'movil': r'movil|pospago|prepago', 'fibra': r'fibra',
        'fibra-500': r'fibra\s*500', 'fibra-300': r'fibra\s*300', 'fibra-900': r'fibra\s*900',
        'portabilidad': r'portab', 'facturacion': r'factur|cobro', 'pago': r'\bpago|\bpse',
        'retencion': r'retencion', 'elegibilidad': r'criterios de elegibilidad|mora mayor',
        'ofertas': r'matriz de ofertas|alternativas de retencion', 'escalamiento': r'escalamiento|supervision',
        'e-202': r'\be[ -]?202\b', 'tv': r'decodificador|\bmi tv\b', 'decobox-4k': r'decobox\s*4k',
        'ztx-f680': r'ztx-?f680', 'modem': r'modem', 'wifi': r'wi[ -]?fi', 'los-roja': r'\blos\b.{0,20}\broj',
        'velocidad': r'velocidad|\bmbps\b', 'promocion': r'promoci', 'reconexion': r'reconec',
    }.items():
        if re.search(pattern, text):
            tags.add(tag)
    if source.key == 'retencion' and 'elegibilidad' in tags:
        tags.add('requisitos')
    page = re.match(r'pág\. (\d+)', section)
    context = f'{source.title}. Sección {section}. Temas: {", ".join(sorted(tags))}.'
    return {'source': source.key, 'section': section, 'tags': sorted(tags), 'context': context,
            **({'page': int(page.group(1))} if page else {})}


def faq_pdf(raw: bytes) -> bytes:
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    from xml.sax.saxutils import escape

    buffer = BytesIO()
    styles = getSampleStyleSheet()
    content = []
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if line:
            heading = line.startswith('#')
            content.extend([Paragraph(escape(line.lstrip('#').strip() if heading else line),
                                      styles['Heading2' if heading else 'BodyText']), Spacer(1, 6)])
    SimpleDocTemplate(buffer, title='Preguntas frecuentes de atención', invariant=1).build(content)
    return buffer.getvalue()


def stage_original(directory: Path, raw: bytes) -> str:
    checksum = sha256(raw).hexdigest()
    stored = directory / checksum
    try:
        fd = os.open(stored, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if stored.is_symlink() or stored.read_bytes() != raw:
            raise ValueError('Existing original has inconsistent content')
    else:
        with os.fdopen(fd, 'wb') as file:
            file.write(raw)
    return checksum


def prepare(root: Path, initial: bool = False, contextual: bool = False) -> list[dict]:
    output = []
    v2_date = next(source.effective_from for source in SOURCES if source.key == 'catalogo-v2')
    for source in SOURCES:
        if initial and source.key == 'catalogo-v2':
            continue
        path = (REPO if source.official_url else root) / source.path
        if not path.is_file():
            raise FileNotFoundError(f'Missing required source: {source.path}')
        if path.suffix == '.pdf':
            blocks, header = pdf_blocks(path)
            if source.key.startswith('catalogo-'):
                match = re.search(r'Versi[oó]n\s+(\d+\.\d+).*?Vigente desde\s+(\d{2}/\d{2}/\d{4})', header, re.I | re.S)
                if not match or datetime.strptime(match.group(2), '%d/%m/%Y').date().isoformat() != source.effective_from or f'v{match.group(1)}' not in source.version:
                    raise ValueError(f'Catalog version or effective date differs from reviewed manifest: {source.path}')
        elif path.suffix == '.docx':
            blocks = docx_blocks(path)
        elif path.suffix == '.md':
            blocks = markdown_blocks(path)
        elif path.suffix == '.eml' and source.scope == 'advisor':
            message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
            body = message.get_body(preferencelist=('plain',))
            if body is None:
                raise ValueError(f'Missing plain text bulletin: {path.name}')
            content = re.sub(r'[\w.+-]+@[\w.-]+\.[a-z]{2,}', '[correo]', body.get_content(), flags=re.I)
            blocks = [('Boletín interno', content)]
        else:
            raise ValueError(f'Unsupported source: {source.path}')
        count = 0
        for count, (section, excerpt) in enumerate(chunks(blocks), 1):
            row = {'id':f'{source.key}-{count:03d}', 'title':f'{source.title} · {section}', 'excerpt':excerpt,
                   'version':source.version, 'scope':source.scope, 'effective_from':source.effective_from,
                   'status':'ready', 'type':source.kind}
            if source.official_url:
                row['url'] = source.official_url
            if source.key == 'catalogo-v1' and not initial:
                row['effective_to'] = v2_date
            if contextual:
                row['metadata'] = describe_passage(source, section, excerpt)
            output.append(row)
        if not count:
            raise ValueError(f'No text extracted: {source.path}')
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Root of Insumos_Prueba_Consultor_IA')
    parser.add_argument('--output', type=Path, required=True, help='New private JSON file outside the repository and source tree')
    parser.add_argument('--manifest', type=Path, help='Write the publication manifest alongside the bundle')
    parser.add_argument('--originals-dir', type=Path, help='Stage only reviewed originals by SHA-256 in a private directory')
    parser.add_argument('--initial', action='store_true', help='Publish the first catalog snapshot for an isolated replay')
    parser.add_argument('--contextual', action='store_true', help='Build the versioned contextual index and checked public source inventory')
    parser.add_argument('--approved-public', type=Path, help='Previously approved public passages, matched by identity and excerpt')
    args = parser.parse_args()
    if args.contextual and not (args.manifest and args.originals_dir):
        parser.error('A contextual publication requires its manifest and original files directory')
    root, target = args.input.resolve(strict=True), args.output.resolve()
    repo = REPO
    if not root.is_dir() or target.is_relative_to(root) or target.is_relative_to(repo):
        parser.error('Output must be outside the source tree and repository')
    manifest_target = args.manifest.resolve() if args.manifest else None
    if manifest_target and (manifest_target.is_relative_to(root) or manifest_target.is_relative_to(repo) or manifest_target == target):
        parser.error('Manifest must be a distinct private file')
    originals = args.originals_dir.resolve() if args.originals_dir else None
    if originals and (not manifest_target or originals.is_relative_to(root) or originals.is_relative_to(repo)):
        parser.error('Originals need a manifest and a directory outside the source tree and repository')
    records = prepare(root, args.initial, args.contextual)
    if args.approved_public:
        approved = json.loads(args.approved_public.read_text(encoding='utf-8'))
        fingerprints = {(row['id'], row['version'], row['excerpt']) for row in approved
                        if row.get('scope') == 'public' and row.get('provider_approved') is True}
        for record in records:
            if record['scope'] == 'public' and (record['id'], record['version'], record['excerpt']) in fingerprints:
                record['provider_approved'] = True
    files = {}
    if manifest_target:
        if originals:
            originals.mkdir(mode=0o700, parents=True, exist_ok=True)
        for source in SOURCES:
            if args.initial and source.key == 'catalogo-v2':
                continue
            path = (REPO if source.official_url else root) / source.path
            raw = path.read_bytes()
            if len(raw) > 10_485_760:
                raise ValueError(f'Original exceeds 10 MiB: {path.name}')
            checksum = sha256(raw).hexdigest()
            passages = [row for row in records if row['id'].rsplit('-', 1)[0] == source.key]
            files[source.key] = {
                'file_name': path.name, 'title': source.title, 'sha256': checksum, 'size_bytes': len(raw),
                'version': source.version, 'scope': source.scope, 'type': source.kind,
                'effective_from': source.effective_from, 'effective_to': passages[0].get('effective_to'),
                'passages': [{'id': row['id'], 'excerpt_sha256': sha256(row['excerpt'].strip().encode('utf-8')).hexdigest(),
                              **({'metadata': row['metadata']} if args.contextual else {})}
                             for row in passages],
            }
            if originals:
                stage_original(originals, raw)
                if args.contextual and source.key in VIEWABLE:
                    files[source.key]['viewable'] = True
                    if source.key == 'faq':
                        pdf = faq_pdf(raw)
                        files[source.key]['derivative_pdf'] = {'sha256': stage_original(originals, pdf), 'size_bytes': len(pdf)}
    # Exclusive creation prevents overwriting existing data or following an existing symlink.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            json.dump(records, file, ensure_ascii=False, indent=2)
            file.write('\n')
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if manifest_target:
        try:
            with os.fdopen(os.open(manifest_target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as file:
                json.dump({'sha256': sha256(target.read_bytes()).hexdigest(),
                           'stage': 'initial' if args.initial else 'current',
                           'sources': {key: value['sha256'] for key,value in files.items()},
                           'files': files,
                           **({'index_schema': 'contextual-v1'} if args.contextual else {}),
                           'count': len(records)}, file, ensure_ascii=False, indent=2)
                file.write('\n')
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    counts = Counter(row['type'] for row in records)
    print(f'Created {len(records)} passages from {len(SOURCES)} reviewed sources; types: {dict(sorted(counts.items()))}; catalog v2 effective: 2026-12-01.')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as exc:
        print(f'Corpus preparation failed: {exc}', file=sys.stderr)
        sys.exit(1)
