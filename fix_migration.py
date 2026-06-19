filepath = 'backend/apps/steps/migrations/0002_security_hardening.py'
with open(filepath, 'r') as f:
    content = f.read()

# The model name is 'StepSyncEvent', which maps to 'stepsyncevent'
# The KeyError: ('steps', 'stepssyncevent') means it was NOT found when it was 'stepssyncevent'
# If it also fails with 'stepsyncevent', then I don't know.
# Wait, I might have messed up the replacement.

content = content.replace("model_name='stepssyncevent'", "model_name='stepsyncevent'")
with open(filepath, 'w') as f:
    f.write(content)
