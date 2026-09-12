"""Build the downloadable starters from verified release archives (Python 3)."""

import base64
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def build(archive_directory):
    docs = Path(__file__).resolve().parents[1]
    manifest_path = docs / 'public/preview/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    prefix = f'simfinity-{manifest["version"]}-preview'
    files = {
        'README.md': (docs / 'preview/README.md').read_bytes(),
        'packages/manifest.json': manifest_path.read_bytes(),
    }
    for package in manifest['packages']:
        filename = package['filename']
        if Path(filename).name != filename:
            raise ValueError(f'Invalid archive name: {filename}')
        contents = (archive_directory / filename).read_bytes()
        sha256 = hashlib.sha256(contents).hexdigest()
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(contents).digest()).decode()
        if sha256 != package['sha256'] or integrity != package['integrity']:
            raise ValueError(f'Archive integrity mismatch: {filename}')
        files[f'packages/{filename}'] = contents
    for backend in ('mongodb', 'postgres'):
        files[f'{backend}/package.json'] = (docs / f'preview/package.{backend}.json').read_bytes()
    for filename in ('schema.js', 'server.js', 'mcp.js'):
        files[f'mongodb/{filename}'] = (docs / f'public/starter/{filename}').read_bytes()
    files['postgres/server.js'] = (docs / 'examples/postgresql-server.js').read_bytes()
    output = docs / f'public/preview/{prefix}.zip'
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for filename, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(f'{prefix}/{filename}', date_time=(2026, 9, 12, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, contents)
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256.txt').write_text(f'{checksum}  {output.name}\n')
    print(f'Built {output.name}: {len(files)} files, SHA-256 {checksum}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 docs/scripts/build-preview.py VERIFIED_ARCHIVE_DIRECTORY')
    build(Path(sys.argv[1]).resolve())
