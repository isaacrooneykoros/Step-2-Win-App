import os
import subprocess
import json

with open('backend_test_env.json') as f:
    env = json.load(f)

current_env = os.environ.copy()
current_env.update(env)

print("Running check --deploy...")
# We expect some warnings from check --deploy because we are using test env settings (DEBUG=True etc)
subprocess.run(['python', 'manage.py', 'check', '--deploy'], cwd='backend', env=current_env)
print("Running makemigrations --check...")
subprocess.run(['python', 'manage.py', 'makemigrations', '--check', '--dry-run'], cwd='backend', env=current_env, check=True)
print("Running tests...")
subprocess.run(['python', 'manage.py', 'test', 'apps.challenges', 'apps.users', 'apps.admin_api'], cwd='backend', env=current_env, check=True)
