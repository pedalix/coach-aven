# ops.example — template for your ops repo

One ops repo per installation. Copy this directory to a new **private** repository and clone it
at `infra/<slug>/` of your coach-aven checkout — `<slug>` is your short name for the installation
(`acme`, `staging`, …) and the first argument of every deploy command. The whole of `infra/` is
gitignored except the public tooling, so the checkout can never be staged by accident.

```bash
cp -r infra/deploy/ops.example /tmp/coach-aven-ops && cd /tmp/coach-aven-ops
mkdir -p .github && mv workflows .github/workflows   # the deploy workflow, see below
cp deploy.env.example deploy.env    # host, users, remote dir, service name — tracked
cp .env.example .env                # the app's runtime secrets — stays untracked
git init -b main && git add -A && git commit -m "my CoachAven installation"
git remote add origin <url> && git push -u origin main
git clone <url> <coach-aven checkout>/infra/acme
```

Then `npm run ops -- acme export` ships it to the box (git push + scp of `.env` and the App key) and
`npm run ops -- acme import` pulls the box's copy back for you to commit. Keep your topology,
operator notes, plans and anything that names your hosts, customers or people in that repo —
never in the product repo.

```
projects.config.json  projects.d/        the bot's config
deploy.env                               deploy target (tracked)
mirrors.json                             repo mirrors (optional; `orch mirror`, see mirrors.example.json)
.env  github-app-private-key.pem         secrets (ignored; travel by scp)
docs/                                    your notes and plans
teams/                                   a Terraform root calling infra/teams (a Teams installation)
.github/workflows/deploy.yml             your deploy
```

## Deploy from your ops repo

[`workflows/deploy.yml`](workflows/deploy.yml) is the whole deploy workflow. In your ops repo it
needs one secret, `DEPLOY_SSH_KEY` (the deployer key), and one variable, `OPS_SLUG` (your slug).
Deploy by hand: Actions → *Deploy CoachAven release* → *Run workflow* → the tag, or
`npm run release -- vX.Y.Z` from a product checkout (tags, pushes, starts the run). The
`repository_dispatch` path — a GitHub App of yours installed on the ops repo, its id and key given
to the product repo as `OPS_APP_ID` / `OPS_APP_PRIVATE_KEY` — is optional wiring for operators who
run their own fork of the product repo and want every tag to deploy itself.

A second installation is a second ops repo with its own key and slug; the product repo does not
know either exists.

## A Teams installation

`teams/main.tf` in your ops repo calls the public module `infra/teams/` with your tenant,
subscription, bot name and endpoint; `terraform apply` there creates the bot identity and builds
the app package, `infra/teams/publish.sh infra/<slug>/teams` uploads it to your organization's
catalog. State stays in that directory, ignored. See [`../../teams/README.md`](../../teams/README.md).
