#!/bin/sh
set -e

for dir in fixtures/*; do
    echo Running tests in "$dir"
    cd "$dir"
    npm i --no-package-lock --legacy-peer-deps --prefer-offline
    npm run test
    cd -
done