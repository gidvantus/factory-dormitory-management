"""Docker stats exporter: метрики контейнеров через docker API (unix-сокет).

Работает на ЛЮБОМ docker (в отличие от cAdvisor, которому нужен доступ
к слоям хранилища): данные берутся из демона (`docker stats`),
поэтому не зависит от storage driver сервера.

Метрики (Prometheus):
  container_cpu_percent{name,service,project}
  container_memory_usage_bytes{name,service,project}
  container_memory_limit_bytes{name,service,project}
  container_network_rx_bytes_total / container_network_tx_bytes_total
  container_last_seen — unix-время последнего наблюдения (как у cAdvisor):
    пока контейнер работает, обновляется каждый цикл; после остановки
    контейнер исчезает из выдачи, и Prometheus видит устаревшее значение —
    алерт ContainerStopped срабатывает по (time() - container_last_seen).
"""

import json
import os
import socket
import threading
import time
import urllib.parse
from http.client import HTTPConnection

from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, generate_latest

# Экспортёр перенесён без изменений логики из проекта Vahta (там он кормит тот
# же тип стека): оба читают docker API одинаково, и расходиться им незачем.
# Метка `service` берётся из compose-метки сервиса, поэтому в алертах и на
# графиках видны «api», «db», «caddy», а не хеши имён контейнеров. Правка
# здесь — повод поправить и там, иначе два экспортёра начнут врать по-разному.

app = FastAPI(title="Docker stats exporter", docs_url=None, redoc_url=None)

SOCKET_PATH = "/var/run/docker.sock"
REFRESH_SECONDS = 15
# Пусто — снимаем метрики со всех контейнеров хоста (так вёл себя экспортёр до
# появления фильтра). Задан — только этот compose-проект: без него в алерты
# ContainerStopped и HighCpu попадали бы чужие стеки на общей машине.
MONITORED_PROJECT = os.environ.get("MONITORED_PROJECT", "").strip()

CPU = Gauge("container_cpu_percent", "CPU % контейнера", ["name", "service", "project"])
MEM_USAGE = Gauge(
    "container_memory_usage_bytes", "Память контейнера (usage)", ["name", "service", "project"]
)
MEM_LIMIT = Gauge(
    "container_memory_limit_bytes", "Лимит памяти контейнера", ["name", "service", "project"]
)
NET_RX = Gauge("container_network_rx_bytes_total", "Сеть RX (байт)", ["name", "service", "project"])
NET_TX = Gauge("container_network_tx_bytes_total", "Сеть TX (байт)", ["name", "service", "project"])
LAST_SEEN = Gauge(
    "container_last_seen",
    "Unix-время последнего наблюдения контейнера",
    ["name", "service", "project"],
)


class UnixHTTPConnection(HTTPConnection):
    def __init__(self, socket_path: str):
        super().__init__("localhost")
        self._socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self._socket_path)


def docker_get(path: str):
    conn = UnixHTTPConnection(SOCKET_PATH)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        data = resp.read()
        if resp.status != 200:
            return None
        return json.loads(data)
    finally:
        conn.close()


def _cpu_percent(stats: dict) -> float:
    """Тот же расчёт, что у docker stats."""
    cpu = stats.get("cpu_stats", {}).get("cpu_usage", {})
    precpu = stats.get("precpu_stats", {}).get("cpu_usage", {})
    total = stats.get("cpu_stats", {}).get("system_cpu_usage", 0)
    pretotal = stats.get("precpu_stats", {}).get("system_cpu_usage", 0)
    online = stats.get("cpu_stats", {}).get("online_cpus", 1) or 1
    cpu_delta = cpu.get("total_usage", 0) - precpu.get("total_usage", 0)
    sys_delta = total - pretotal
    if sys_delta <= 0 or cpu_delta < 0:
        return 0.0
    return round(cpu_delta / sys_delta * online * 100.0, 2)


def containers_path() -> str:
    """Путь списка контейнеров с фильтром по проекту (если проект задан).

    Фильтр — docker-шный, `label=ключ=значение`: имя compose-проекта лежит в
    метке контейнера, а не в его имени, поэтому переименование контейнера на
    фильтр не влияет.
    """
    if not MONITORED_PROJECT:
        return "/containers/json"
    filters = json.dumps(
        {"label": [f"com.docker.compose.project={MONITORED_PROJECT}"]}, separators=(",", ":")
    )
    return "/containers/json?filters=" + urllib.parse.quote(filters, safe="")


def _refresh() -> None:
    while True:
        try:
            containers = docker_get(containers_path()) or []
            for c in containers:
                cid = c.get("Id", "")
                labels = c.get("Labels", {}) or {}
                name = (c.get("Names") or ["unknown"])[0].lstrip("/")
                service = labels.get("com.docker.compose.service", "")
                project = labels.get("com.docker.compose.project", "")
                lbl = (name, service, project)

                stats = docker_get(f"/containers/{cid}/stats?stream=false")
                if not stats:
                    continue
                mem = stats.get("memory_stats", {}) or {}
                usage = mem.get("usage")
                limit = mem.get("limit")
                net = stats.get("networks", {}) or {}
                rx = sum(n.get("rx_bytes", 0) for n in net.values())
                tx = sum(n.get("tx_bytes", 0) for n in net.values())

                CPU.labels(*lbl).set(_cpu_percent(stats))
                if usage is not None:
                    MEM_USAGE.labels(*lbl).set(usage)
                if limit:
                    MEM_LIMIT.labels(*lbl).set(limit)
                NET_RX.labels(*lbl).set(rx)
                NET_TX.labels(*lbl).set(tx)
                # Сердцебиение: обновляется, пока контейнер работает.
                # Остановленный контейнер пропадает из /containers/json —
                # метрика перестаёт обновляться, и Prometheus видит простой.
                LAST_SEEN.labels(*lbl).set_to_current_time()
        except Exception:
            pass  # следующая итерация
        time.sleep(REFRESH_SECONDS)


@app.on_event("startup")
def _start() -> None:
    threading.Thread(target=_refresh, daemon=True).start()


@app.get("/metrics")
def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
