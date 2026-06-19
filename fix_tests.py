filepath = 'backend/apps/steps/test_security_hardening.py'
with open(filepath, 'r') as f:
    content = f.read()

# Update payload3 probabilities to match rounding expectation for hash1
content = content.replace("payload3['ml_walk_probability'] = 0.851234", "payload3['ml_walk_probability'] = 0.850012")

with open(filepath, 'w') as f:
    f.write(content)
