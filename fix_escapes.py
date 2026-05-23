import os
import glob

# Find all TS/TSX files in the web/src directory
pattern = 'D:/Graph/web/src/**/*.ts*'
files = glob.glob(pattern, recursive=True)

total_fixed = 0
for path in files:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    # Replace escaped backtick \` with real backtick `
    content = content.replace('\\`', '`')
    # Replace double-escaped newlines \\n\\n with single \n\n
    content = content.replace('\\\\n\\\\n', '\\n\\n')

    if content != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'Fixed: {path}')
        total_fixed += 1

print(f'\nTotal files fixed: {total_fixed}')
