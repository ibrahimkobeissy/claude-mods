# Contributing to claude-mods

Thanks for helping. Mods, bug fixes, docs and ideas are all welcome.

## Proposing a mod

Not ready to write code? [Open a mod request](https://github.com/ibrahimkobeissy/claude-mods/issues/new?template=mod_request.yml) describing what it should do.

## Adding a mod

1. Fork the repo and create a branch: `git checkout -b mod/my-mod`.
2. Scaffold it: `scripts/new-mod.sh my-mod "One line on what it does"`.
   This copies `template/` to `mods/my-mod/` and lists it in `.claude-plugin/marketplace.json`.
3. Write the hooks in `mods/my-mod/hooks/register.ts`. Try it live with
   `claude --plugin-dir mods/my-mod`; each save hot-reloads it.
4. Add or update `hooks/*.test.ts` for the behaviour, then run `scripts/validate.sh mods/my-mod`.
5. Add a `README.md` in the mod folder (what it does, a screenshot or GIF if it draws anything, its options).
6. Add a row for it to the **Mods** table in the root `README.md`.
7. Open a pull request.

### Checklist a mod needs before merge

- Folder name, `plugin.json` `name` and marketplace entry `name` are the same kebab-case name.
- `scripts/validate.sh` passes (validate + tests).
- It does one thing and says so in its description.
- No network calls, telemetry, or file access outside what its README states.
- Any values it keeps in `$.state` are declared in `types/index.d.ts`, named by `"types"` in `plugin.json`.
- `version` in `plugin.json` is bumped on every change that ships to users (semver).

## Changing an existing mod

Keep the change focused, bump the mod's `version`, and update its README if the behaviour changed.

## Style

TypeScript, 2-space indent, no semicolons, single quotes, matching `template/hooks/register.ts`.
