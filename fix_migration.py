filepath = 'backend/apps/steps/migrations/0002_security_hardening.py'
with open(filepath, 'r') as f:
    content = f.read()
content = content.replace("stepssyncevent", "stepsyncevent")
with open(filepath, 'w') as f:
    f.write(content)
