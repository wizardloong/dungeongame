# Путь к окружению и Dockerfile
ENV_DIR=env
DOCKER_COMPOSE=docker compose -f $(ENV_DIR)/docker-compose.yml

# Билд окружения
build:
	$(DOCKER_COMPOSE) build

# Старт окружения
up:
	$(DOCKER_COMPOSE) up

# Остановка без удаления данных
stop:
	$(DOCKER_COMPOSE) stop

# Полная остановка и удаление контейнеров
down:
	$(DOCKER_COMPOSE) down

# Перезапуск
reup: down up

# Логи
logs:
	$(DOCKER_COMPOSE) logs -f

# Попасть в контейнер backend
sh:
	$(DOCKER_COMPOSE) exec backend sh

# Проверка статуса
ps:
	$(DOCKER_COMPOSE) ps

# Очистка всего (контейнеров, образов, томов)
prune:
	docker system prune -a --volumes --force