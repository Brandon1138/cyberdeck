"""Read-only collector comparison; retains aggregate numeric measurements only."""
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import selectors
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone

helper = str(Path(sys.argv[1]).resolve())
output = Path(sys.argv[2])
commands = {"native": [helper], "ps": ["/bin/ps", "-axo", "pid=,ppid=,rss=,%cpu=,lstart="]}


def collect(command):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={**os.environ, "LC_ALL": "C"})
    chunks = []
    size = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = 2 - (time.perf_counter() - start)
                if remaining <= 0:
                    raise TimeoutError("collector-timeout")
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        break
                    size += len(chunk)
                    if size > 1024 * 1024:
                        raise ValueError("collector-output-limit")
                    chunks.append(chunk)
        child.wait(timeout=max(0.001, 2 - (time.perf_counter() - start)))
        if child.returncode:
            raise RuntimeError("collector-failed")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        child.stdout.close()
    wall_ms = (time.perf_counter() - start) * 1000
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_ms = ((after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)) * 1000
    rows = b"".join(chunks).decode("ascii").strip().splitlines()
    return {"wallMs": wall_ms, "childCpuMs": cpu_ms, "outputBytes": size}, rows, child.pid


series = {name: [] for name in commands}
# Alternation limits monotonic host-load drift; warm-ups are not in summaries.
for iteration in range(23):
    for name in (["native", "ps"] if iteration % 2 == 0 else ["ps", "native"]):
        measured, rows, pid = collect(commands[name])
        if name == "native":
            measured["processRows"] = len(rows) - 2
            measured["inaccessibleProcesses"] = int(rows[-1].split("\t")[2])
            own = next((line.split("\t") for line in rows[1:-1] if line.split("\t")[0] == str(pid)), None)
            measured["collectorRssBytes"] = int(own[6]) if own and own[6] != "-" else None
            measured["collectorPhysicalBytes"] = int(own[5]) if own and own[5] != "-" else None
        else:
            measured["processRows"] = len(rows)
            own = next((line.split() for line in rows if line.split()[0] == str(pid)), None)
            measured["collectorRssBytes"] = int(own[2]) * 1024 if own else None
        if iteration >= 3:
            series[name].append(measured)


def summarize(values):
    values = sorted(value for value in values if value is not None)
    if not values:
        return None
    return {"min": values[0], "median": statistics.median(values), "p95": values[max(0, int(len(values) * .95) - 1)], "max": values[-1]}


report = {"schemaVersion": 1, "observedAt": datetime.now(timezone.utc).isoformat(),
          "mode": "read-only-host-collector-comparison", "os": platform.mac_ver()[0],
          "architecture": platform.machine(), "helperSha256": hashlib.sha256(Path(helper).read_bytes()).hexdigest(),
          "warmupPairs": 3, "measuredPairs": 20,
          "results": {name: {key: summarize([sample.get(key) for sample in samples]) for key in samples[0]} for name, samples in series.items()},
          "limitations": ["short-burst-comparison-not-idle-acceptance", "host-load-not-controlled", "child-cpu-excludes-python-driver", "ps-memory-is-rss", "native-output-is-physical-and-rss", "no-vm-attribution", "no-provider-or-container-launch"]}
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
