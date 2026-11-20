---
description: Update my status file, pull, test, commit and push
---
1. Update my `status/<letter>.md`: set the time, move finished items to Done, write what I'm doing now, what I need from others and known problems. Under 15 lines.
2. If we made a decision that affects another area, append one line to `docs/DECISIONS.md`.
3. `git pull --rebase`, then `npm run typecheck && npm test`. If a test in another person's area fails, stop and tell me who owns it; don't fix it.
4. Commit my changes in small commits with one-line imperative messages and no attribution lines, then `git push`.
5. Tell me in two lines what was pushed and whether anyone is waiting on me.
