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

## Deploy from your ops repo

Copy [`workflows/deploy.yml`](workflows/deploy.yml) to `.github/workflows/deploy.yml` of
your ops repo and add two secrets there: `DEPLOY_SSH_KEY` (the deployer key) and
`DEPLOY_ENV` (your `infra/prod/.env`). Then either

- deploy by hand: Actions → *Deploy CoachAven release* → *Run workflow* → the tag, or `npm run release -- vX.Y.Z` from a product checkout (tags, pushes, starts the run — this is what we do); or
- let releases deploy themselves: install a GitHub App of yours on the ops repo and give the
  product repo its id and key as `OPS_APP_ID` / `OPS_APP_PRIVATE_KEY` — every published
  tag then arrives as a `repository_dispatch` and deploys. Only useful when you run your own
  fork of the product repo; for the upstream repo, deploy by hand or watch its releases.

A second installation is a second ops repo with its own two secrets; the product repo does
not know it exists.
