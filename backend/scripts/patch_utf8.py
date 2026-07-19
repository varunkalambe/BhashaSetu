import glob
for f in glob.glob('scripts/*.py'):
    with open(f, 'r', encoding='utf-8') as fh:
        content = fh.read()
    if 'reconfigure' not in content:
        with open(f, 'w', encoding='utf-8') as fh:
            fh.write("import sys\nsys.stdout.reconfigure(encoding='utf-8')\nsys.stderr.reconfigure(encoding='utf-8')\n\n" + content)
        print('patched ' + f)
    else:
        print('already patched ' + f)