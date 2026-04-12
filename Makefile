# Makefile — developer task runner for Step2Win
#
# Usage:
#   make dev         Start local infrastructure (Postgres + Redis)
#   make migrate     Apply Django database migrations
#   make test        Run the full Django test suite
#   make worker      Start the Celery worker
#   make beat        Start the Celery beat scheduler
#   make lint        Run ruff linter on the backend
#   make fmt         Auto-fix ruff lint issues
#   make gate        Run the full release gate (tests + lint + build)
#   make schema      Regenerate the OpenAPI schema (Step2Win API.yaml)
#   make shell       Open a Django shell
#   make superuser   Create a Django superuser

.PHONY: dev dev-down migrate test worker beat lint fmt gate schema shell superuser

PYTHON  := python
MANAGE  := cd backend && $(PYTHON) manage.py

# ── Infrastructure ────────────────────────────────────────────────────────────

dev:
	docker compose up -d
	@echo "\nPostgres and Redis are running."
	@echo "Run 'make migrate' to apply migrations, then 'cd backend && python manage.py runserver'."

dev-down:
	docker compose down

# ── Django ────────────────────────────────────────────────────────────────────

migrate:
	$(MANAGE) migrate

test:
	cd backend && $(PYTHON) -m coverage run --source=apps manage.py test
	cd backend && $(PYTHON) -m coverage report --fail-under=70

shell:
	$(MANAGE) shell

superuser:
	$(MANAGE) createsuperuser

schema:
	$(MANAGE) spectacular --color --file "Step2Win API.yaml"
	@echo "Schema written to Step2Win API.yaml"

# ── Celery ────────────────────────────────────────────────────────────────────

worker:
	cd backend && celery -A step2win worker -l info --concurrency=2

beat:
	cd backend && celery -A step2win beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler

# ── Linting ───────────────────────────────────────────────────────────────────

lint:
	cd backend && $(PYTHON) -m ruff check .

fmt:
	cd backend && $(PYTHON) -m ruff check --fix .

# ── Release gate ──────────────────────────────────────────────────────────────

gate:
	$(PYTHON) release_gate.py
