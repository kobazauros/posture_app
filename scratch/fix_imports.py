import os
import re

directory = r'c:\Users\rookie\Documents\Projects\posture_app'
js_files = [f for f in os.listdir(directory) if f.endswith('.js') or f == 'index.html']

for filename in js_files:
    path = os.path.join(directory, filename)
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if filename.endswith('.js'):
        new_content = re.sub(r'(\.js)\?v=\d+', r'\1', content)
    else:
        new_content = re.sub(r'(\.js)\?v=\d+', r'\1', content)
        new_content = re.sub(r'(\.css)\?v=\d+', r'\1', new_content)

    if new_content != content:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f'Updated {filename}')
