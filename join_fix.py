import sys

filepath = 'backend/apps/challenges/views.py'
with open(filepath, 'r') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if "with transaction.atomic():" in line and "join_challenge" in "".join(new_lines[-20:]):
        new_lines.append(line)
        new_lines.append("            user = request.user.__class__.objects.select_for_update().get(id=request.user.id)\n")
    elif "if Participant.objects.filter(challenge=challenge, user=request.user).exists():" in line:
        new_lines.append(line.replace("request.user", "user"))
    elif "user = request.user.__class__.objects.select_for_update().get(id=request.user.id)" in line and len(new_lines) > 220:
        continue # Skip this line
    else:
        new_lines.append(line)

with open(filepath, 'w') as f:
    f.writelines(new_lines)
