# infra/ — deploy tooling, infrastructure modules, and your installations

```
deploy/     deploy.sh <slug> <command>, systemd unit templates, nginx example, ops.example/ (the
            template for an ops repo)                                              → deploy/README.md
teams/      Terraform module: a Teams installation's bot identity (Entra app, Azure Bot, Teams
            channel) + the app package; publish.sh for the org catalog               → teams/README.md
<slug>/     YOUR installations — each a private ops repo checked out here (projects, prompts,
            deploy.env, secrets, notes). Gitignored by allow-list: nothing under infra/ is tracked
            except the two directories above and this file, whatever the slug.
```

One installation = one ops repo = one `infra/<slug>/`. Every deploy command names the slug
(`npm run ops -- <slug> deploy`); there is no default. The product repo documents mechanisms;
anything that names a host, a tenant, a customer or a person belongs in the ops repo.
