# Prepare the private demo corpus

Run this command against the original, locally available `Insumos_Prueba_Consultor_IA` directory. `uv` reads the pinned Python dependency from the script. The output is a JSON array accepted by the backend knowledge ingester; create it in a private location outside the repository and the source directory:

```sh
uv run packages/agent/scripts/prepare_corpus.py \
  --input '/path/to/Insumos_Prueba_Consultor_IA' \
  --output '/path/to/private/claro-corpus.json'
```

The output must not already exist. The script creates it with mode `0600`, fails closed on a missing source or unreadable PDF page, and prints only counts and the catalog v2 effective date. PDF text extraction does not perform OCR. It does not upload or ingest the file. Keep the generated file private and delete it when no longer needed; do not commit it. For an isolated cache, set `UV_CACHE_DIR` to a private writable directory.

The fixed source manifest includes only the two catalogs, public FAQ, two equipment manuals, and the listed policies and contracts. It does not scan directories and excludes emails, transcripts, customer records, audio and other personal material. Catalogs, FAQ and manuals are marked `public` for the exercise; policies and contracts are `advisor` only. These are demo visibility choices, not proof of authorization to publish real documents. The corpus manager must approve scope before use in any other environment.

The script checks each catalog's version and effective date against its PDF header. Catalog v1 is valid from 2026-11-01 until the exclusive v2 start date of 2026-12-01; v2 begins on that date. The FAQ has its own stated 2026-11-01 update date. Manuals, contracts and policies without verified effective dates use the **2026-11-18 exercise snapshot date** as an explicit demo assumption, not a claim of their historical publication date. Review and replace that assumption when authoritative metadata is available. The generated chunks preserve paragraphs, sections, PDF page labels and DOCX table rows; the manifest can be extended only after reviewing source, scope and dates.
