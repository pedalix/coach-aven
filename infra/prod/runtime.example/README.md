# runtime.example — template for your ops repo

Copy this directory to a new **private** repository and clone it at `infra/prod/runtime/`:

```bash
cp -r infra/prod/runtime.example /tmp/my-coach-aven-ops && cd /tmp/my-coach-aven-ops
git init -b main && printf '.env\n.env.*\n*.pem\nstate.json\n' > .gitignore
cp .env.example .env            # fill in — stays untracked
git add -A && git commit -m "my CoachAven installation" && git remote add origin <url> && git push -u origin main
git clone <url> <coach-aven checkout>/infra/prod/runtime
```

Then `npm run prod:export` ships it to the box (git push + scp of `.env` and the App key) and
`npm run prod:import` pulls the box's copy back for you to commit. Keep your topology, operator
notes and anything that names your hosts, customers or people in that repo — never here.
