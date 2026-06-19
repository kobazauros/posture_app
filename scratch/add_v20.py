import os, re

directory = '.'

js_files = [f for f in os.listdir(directory) if f.endswith('.js') or f == 'index.html' or f.endswith('.css')]

for filename in js_files:
    filepath = os.path.join(directory, filename)
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # First, remove any existing ?v=xx
    new_content = re.sub(r'(\.js)\?v=\d+', r'\1', content)
    new_content = re.sub(r'(\.css)\?v=\d+', r'\1', new_content)

    # Add ?v=21 to imports in JS
    if filename.endswith('.js'):
        new_content = re.sub(r"from '([^']+)\.js\?v=20'", r"from '\1.js?v=21'", new_content)
        new_content = re.sub(r"from '([^']+)\.js'", r"from '\1.js?v=21'", new_content)
    
    # Add ?v=21 to CSS imports in CSS
    if filename.endswith('.css'):
        new_content = re.sub(r"url\(['\"]?([^'\"]+)\.css\?v=20['\"]?\)", r"url('\1.css?v=21')", new_content)
        new_content = re.sub(r"url\(['\"]?([^'\"]+)\.css['\"]?\)", r"url('\1.css?v=21')", new_content)

    # Add ?v=21 to tags in HTML
    if filename == 'index.html':
        new_content = re.sub(r'src="([^"]+)\.js\?v=20"', r'src="\1.js?v=21"', new_content)
        new_content = re.sub(r'src="([^"]+)\.js"', r'src="\1.js?v=21"', new_content)
        new_content = re.sub(r'href="([^"]+)\.css\?v=20"', r'href="\1.css?v=21"', new_content)
        new_content = re.sub(r'href="([^"]+)\.css"', r'href="\1.css?v=21"', new_content)

    if new_content != content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f"Updated {filename}")
