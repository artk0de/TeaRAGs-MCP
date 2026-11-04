"""One native actor controller at a time; process-exit notifications, no sleeps."""
import json
import errno
from pathlib import Path
import select
import subprocess
import sys

base = Path(sys.argv[1])
launcher = Path('/Users/Shared/nav-ab/context-efficiency-0555-evals/launch_stage.py')
for stage in ('baseline', 'candidate', 'bounded-prototype'):
    previous = base / stage / 'harness/launch.json'
    if previous.exists():
        launch = json.loads(previous.read_text())
    else:
        output = subprocess.check_output(['/opt/homebrew/bin/python3', str(launcher), str(base / stage)], text=True)
        launch = json.loads(output)
    print(json.dumps({'stage': stage, **launch}), flush=True)
    queue = select.kqueue()
    try:
        event = select.kevent(launch['pid'], filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
        queue.control([event], 1, None)
    except OSError as error:
        if error.errno != errno.ESRCH:
            raise
    finally:
        queue.close()
    print(json.dumps({'stage': stage, 'controller_exited': True}), flush=True)
