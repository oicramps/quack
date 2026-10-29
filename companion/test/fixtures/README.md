# Parser fixtures

`*-documented.jsonl` are hand-written from each CLI's documented stream-json format, not recorded. Replace or supplement them with real output:

```sh
QUACK_RECORD=1 node scripts/harness.mjs ask --pr ProjetoParcas/mynah#14 --backend cursor --question "..."
```

Recordings land in `~/.quack/recordings/` and contain code from the repo, so review them before committing.
