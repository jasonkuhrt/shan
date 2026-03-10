set shell := ["zsh", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

install:
  bun install

install-global:
  bun link

install-skills-user:
  bun run shan -- skills install-user

run *args:
  bun run shan -- {{ args }}

build:
  bun run build

format:
  bun run fix:format

format-check:
  bun run check:format

lint:
  bun run check:lint

lint-fix:
  bun run fix:lint

typecheck:
  bun run check:types

test:
  bun run test

coverage:
  bun run check:cov

package-check:
  bun run check:package

exports-check:
  bun run check:exports

ci-check:
  bun run check:ci

check:
  bun run check

pre-commit: format-check lint typecheck

pre-push: check

quality: check
