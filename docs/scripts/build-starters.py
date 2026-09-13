"""Build the npm-based quick starts using only Python 3 standard modules."""

import hashlib
import json
from pathlib import Path
import zipfile


docs = Path(__file__).resolve().parents[1]
version = json.loads((docs.parent / 'package.json').read_text())['version']
prefix = f'simfinity-{version}-starters'
files = {'README.md': (docs / 'starters/README.md').read_bytes()}
for backend in ('mongodb', 'postgres'):
    package = (docs / f'starters/package.{backend}.json').read_bytes()
    dependencies = json.loads(package)['dependencies']
    for name, requirement in dependencies.items():
        if name.startswith('@simtlix/') and requirement != version:
            raise ValueError(f'{backend}: {name} must match release {version}')
    files[f'{backend}/package.json'] = package
for name in ('schema.js', 'server.js', 'mcp.js'):
    files[f'mongodb/{name}'] = (docs / f'public/starter/{name}').read_bytes()
files['postgres/server.js'] = (docs / 'examples/postgresql-server.js').read_bytes()
output = docs / f'public/releases/{prefix}.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for name, contents in sorted(files.items()):
        entry = zipfile.ZipInfo(f'{prefix}/{name}', date_time=(2026, 9, 12, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        bundle.writestr(entry, contents)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256.txt').write_text(f'{checksum}  {output.name}\n')
print(f'Built {output.name}: {len(files)} files, SHA-256 {checksum}')
