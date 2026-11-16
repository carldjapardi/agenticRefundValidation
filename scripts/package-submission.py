"""Build the local review ZIP; load OPENAI into the environment for the credential check."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json
import os

root = Path(__file__).resolve().parents[1]
secret = os.environ.get('OPENAI', '').strip().encode()
if not secret:
    raise SystemExit('Load OPENAI from .env before packaging so the credential scan can run.')

# Every published file must be named here; new working files are excluded by default.
PUBLICATION_FILES = (
    'src/agents.ts',
    'src/charges.ts',
    'src/decisions.ts',
    'src/loop.ts',
    'src/server.ts',
    'src/session.ts',
    'src/tools.ts',
    'src/triage-replies.ts',
    'web/app.ts',
    'web/index.html',
    'web/style.css',
    'tests/client.test.ts',
    'tests/conversation.test.ts',
    'tests/decisions.test.ts',
    'tests/domain.test.ts',
    'tests/server.test.ts',
    'scripts/evaluate-triage.ts',
    'scripts/package-submission.py',
    'traces/README.md',
    'traces/refund-success.json',
    'traces/verification-failure.json',
    'traces/conversation-recovery.json',
    'traces/refund-question.json',
    'traces/no-refund-requested.json',
    'evidence/overview.png',
    'evidence/refund-success.png',
    'evidence/verification-failure.png',
    'evidence/conversation-recovery.png',
    'evidence/conversational-triage.png',
    'evidence/clean-install-results.txt',
    'evidence/decisions-evaluation.json',
    'evidence/credential-scan.json',
    'evidence/trace-validation.txt',
    'evidence/test-results.txt',
    'evidence/typecheck-results.txt',
    'evidence/limitation-check.txt',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.gitignore',
    '.env.example',
    'README.md',
    'ENGINEERING_NOTE.md',
    'AUDIT.md',
    'FLOWCHART.md',
)


def inputs():
    files = [root / name for name in PUBLICATION_FILES]
    if len(files) != len(set(files)):
        raise SystemExit('Duplicate publication input.')
    missing = [str(path.relative_to(root)) for path in files if not path.is_file()]
    if missing:
        raise SystemExit('Missing publication inputs: ' + ', '.join(missing))
    if any(path.is_symlink() or not path.resolve().is_relative_to(root) for path in files):
        raise SystemExit('Publication inputs must be ordinary files inside the project.')
    return files

for path in inputs():
    if path.name.startswith('.env') and path.name != '.env.example':
        raise SystemExit('Unexpected environment file in submission inputs.')
    if secret in path.read_bytes():
        raise SystemExit('Configured credential found in submission inputs; packaging stopped.')

scan = {
    'configuredCredentialAbsent': True,
    'environmentFileExcluded': True,
    'method': 'Compared configured OPENAI bytes in memory against every selected file and every decompressed ZIP member; no credential value is logged.',
}
(root / 'evidence/credential-scan.json').write_text(json.dumps(scan, indent=2) + '\n')
files = inputs()
(root / 'output').mkdir(exist_ok=True)
archive = root / 'output/finchpay-submission.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for path in files:
        z.write(path, 'finchpay-refund-desk/' + str(path.relative_to(root)))
with ZipFile(archive) as z:
    assert z.testzip() is None
    assert set(z.namelist()) == {'finchpay-refund-desk/' + str(p.relative_to(root)) for p in files}
    for path in files:
        content = z.read('finchpay-refund-desk/' + str(path.relative_to(root)))
        assert content == path.read_bytes()
        assert secret not in content
    assert not any(Path(name).name.startswith('.env') and Path(name).name != '.env.example' for name in z.namelist())

summary = {
    'archive': str(archive), 'files': len(files), 'bytes': archive.stat().st_size,
    'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'integrity': 'PASS: all ZIP bytes match final workspace source and evidence',
    'configuredCredentialAbsent': True, 'environmentFileExcluded': True,
}
(root / 'output/package-verification.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
