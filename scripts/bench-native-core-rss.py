"""Measure the standalone helper peak separately; never call this a process-tree peak."""
import json
import os
import subprocess
import sys

binary, journal = sys.argv[1:]
with open(journal, "rb") as source, open(os.devnull, "wb") as sink:
    child = subprocess.Popen([binary, "instruction-replay-v1"], stdin=source, stdout=sink)
    _, status, usage = os.wait4(child.pid, 0)
    child.returncode = os.waitstatus_to_exitcode(status)
    if child.returncode:
        raise SystemExit(child.returncode)
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    print(json.dumps({"standaloneHelperPeakRssMiB": usage.ru_maxrss / divisor}))
