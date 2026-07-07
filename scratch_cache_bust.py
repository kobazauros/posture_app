import re

with open('manual/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Append ?v=2 to all .png image src attributes
content = re.sub(r'src="((?:client_scenario|spec_scenario)/[^"]+\.png)(?:\?v=\d+)?"', r'src="\1?v=2"', content)

with open('manual/index.html', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated index.html")
