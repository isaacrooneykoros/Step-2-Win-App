filepath = 'backend/test_anticheat.py'
with open(filepath, 'r') as f:
    content = f.read()

content = content.replace("user = User.objects.first()", "user = User.objects.first()\n    if not user:\n        user = User.objects.create_user(username='anticheat_test', password='password123', email='anticheat@example.com', phone_number='254700000000')")

with open(filepath, 'w') as f:
    f.write(content)
