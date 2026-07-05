#!/usr/bin/env bash
# Delegate to the Node.js implementation to avoid code duplication
exec node "$(dirname "$0")/gh-pr-review-comments.cjs" "$@"
