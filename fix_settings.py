filepath = 'backend/step2win/settings.py'
with open(filepath, 'r') as f:
    content = f.read()

import re
content = re.sub(r"APP_SIGNING_SECRET = os\.environ\.get\('APP_SIGNING_SECRET', ''\)\nif not APP_SIGNING_SECRET:(\n    APP_SIGNING_SECRET = SECRET_KEY)+", "APP_SIGNING_SECRET = os.getenv('APP_SIGNING_SECRET') or SECRET_KEY", content)

with open(filepath, 'w') as f:
    f.write(content)
