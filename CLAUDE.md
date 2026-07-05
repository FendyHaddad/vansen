# Vansen — Claude instructions

## Git
- **Never commit, branch, or push.** The user makes all commits personally.
- All work happens on the same single branch — never create branches.

## Components
- Angular components always use separate files: `.ts` + `.html` + `.css`. Never inline
  templates or styles.
- Prefer stylesheet classes over inline `style` attributes.

## Build
- Node via nvm: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
