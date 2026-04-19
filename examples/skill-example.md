---
name: Reset Stuck Queue Worker
summary: Restart the background queue worker when it stops consuming new jobs
source: manual
created: 2026-04-15
last_used: 2026-04-15
use_count: 1
---

## When to Use
- Queue depth is climbing but nothing is being processed
- `ps aux | grep queue-worker` shows the process is alive but `strace` shows it idle

## Steps

1. Check lock file: `ls -la /var/run/queue-worker.lock`
2. If lock is stale (owning PID is gone), delete it: `rm /var/run/queue-worker.lock`
3. Restart the worker: `systemctl restart queue-worker`
4. Tail logs for 30 seconds: `journalctl -u queue-worker -f`
5. Verify consumption: `redis-cli LLEN queue` should decrement

## Log the outcome

After running, call:

```
node skill-log.js --skill reset-stuck-queue-worker --outcome success
# or on failure:
node skill-log.js --skill reset-stuck-queue-worker --outcome failure --note "lock wasn't the issue — worker was OOMing"
```
