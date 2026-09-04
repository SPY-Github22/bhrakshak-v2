SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml

.PHONY: help up down logs migrate seed data demo test lint dev-api dev-dashboard dev-pwa dev-citizen nuke

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Boot the entire platform (postgres+postgis+timescale, redis, mosquitto, minio, martin, api, worker, dashboard, pwa, citizen)
	$(COMPOSE) up -d --build
	@echo "== BhuRakshak =="
	@echo "dashboard  http://localhost:3000"
	@echo "field pwa  http://localhost:5173"
	@echo "citizen    http://localhost:5174"
	@echo "api docs   http://localhost:8000/docs"
	@echo "tiles      http://localhost:3001/zones/7/60/30.pbf"

down: ## Stop everything
	$(COMPOSE) down

nuke: ## Stop and delete volumes (fresh start)
	$(COMPOSE) down -v

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

migrate: ## Apply alembic migrations inside the api container
	$(COMPOSE) exec api alembic upgrade head

revision: ## Create a new empty migration: make revision m="add foo"
	$(COMPOSE) exec api alembic revision -m "$(m)"

seed: ## Seed 4 pilot districts, hex-grid zones, users, roads, i18n templates
	$(COMPOSE) run --rm seed

data: ## Build offline-safe synthetic ML datasets + fixtures (real downloads optional)
	cd ml && $(MAKE) data

demo: ## Full scripted demo state: realistic seed -> storm injection -> metrics fixture check
	$(COMPOSE) run --rm seed python /srv/scripts/seed_realistic.py
	$(COMPOSE) exec api python /srv/demo/storm_injector.py --district "East Khasi Hills" || true
	@echo "Open http://localhost:3000 and press 'Inject Monsoon Cell'."

replay: ## Run 90-second interactive June 2022 Tupul landslide simulation replay
	/home/sudpy/Projects/Bhrakshak/.venv/bin/python demo/replay_tupul_disaster.py

simulate-tupul: ## Run 15-minute time-lapse June 2022 Tupul Manipur disaster simulation
	/home/sudpy/Projects/Bhrakshak/.venv/bin/python scripts/simulate_tupul.py

simulate-lorawan: ## Run virtual ESP32/LoRaWAN edge sensor telemetry publishing simulation
	/home/sudpy/Projects/Bhrakshak/.venv/bin/python scripts/simulate_lorawan.py --iterations 6 --interval 0.2

test: ## Run API tests against the running stack
	$(COMPOSE) exec api pytest -q /srv/apps/api/tests

lint:
	python -m compileall -q apps/api/app apps/worker ml scripts demo

dev-api: ## Run API locally without docker (needs local postgres/redis)
	cd apps/api && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-dashboard:
	cd apps/dashboard && npm run dev

dev-pwa:
	cd apps/field-pwa && npm run dev

dev-citizen:
	cd apps/citizen-pwa && npm run dev
