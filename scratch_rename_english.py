import os
import shutil

base_dir = 'manual'
client_dir = os.path.join(base_dir, 'Сценарий клиента')
spec_dir = os.path.join(base_dir, 'Сценарий специалиста')

new_client_dir = os.path.join(base_dir, 'client_scenario')
new_spec_dir = os.path.join(base_dir, 'spec_scenario')

# Rename directories first
if os.path.exists(client_dir):
    os.rename(client_dir, new_client_dir)
if os.path.exists(spec_dir):
    os.rename(spec_dir, new_spec_dir)

# Helper function to rename and return replacements
def rename_files(dir_path, prefix):
    replacements = {}
    if not os.path.exists(dir_path):
        return replacements
        
    for f in os.listdir(dir_path):
        if f.endswith('.png'):
            # e.g. "01-нажать на начать анализ осанки.png" -> "01"
            safe_name = f.split('-')[0].split('_')[0]
            if safe_name.endswith('a') or safe_name.endswith('b'):
                pass # keep '05a'
            if safe_name == 'Системное меню.png':
                safe_name = 'menu'
                
            # Create a simple english name: client_01.png
            new_name = f"{prefix}_{safe_name}.png"
            new_name = new_name.replace(' ', '')
            
            old_path = os.path.join(dir_path, f)
            new_path = os.path.join(dir_path, new_name)
            os.rename(old_path, new_path)
            
            # Record replacement for HTML
            old_html_path = f"Сценарий {prefix.replace('client', 'клиента').replace('spec', 'специалиста')}/{f}"
            new_html_path = f"{prefix}_scenario/{new_name}"
            replacements[old_html_path] = new_html_path
            
    return replacements

client_reps = rename_files(new_client_dir, 'client')
spec_reps = rename_files(new_spec_dir, 'spec')

# For the hardcoded menu file
if 'Сценарий специалиста/Системное меню.png' not in spec_reps:
    # Manual fallback if split logic missed it
    pass

html_path = 'manual/index.html'
if os.path.exists(html_path):
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    for old, new in client_reps.items():
        content = content.replace(old, new)
    for old, new in spec_reps.items():
        content = content.replace(old, new)
        
    # Also replace any remaining directory references just in case
    content = content.replace('Сценарий клиента/', 'client_scenario/')
    content = content.replace('Сценарий специалиста/', 'spec_scenario/')
    
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(content)

print("Renamed files to english and updated index.html")
