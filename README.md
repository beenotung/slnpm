# snpm

An alternative package installer using symbolic link.

(The package name to be confirmed, due to name conflict on npm registry)

The design is heavily inspired by pnpm, which downloads and caches each npm package, then setup hardlink of each file to the project's node_modules.
However, this package setup symbolic link of each package's directory.

## Feature

- save network - only need to download each package once
- save disk space - only need to store each package once
- save time - faster than npm and pnpm

## Advantages over pnpm

1. setup symbolic link instead of hardlink allows the cache to be used across different file-systems / partitions

2. setup link per package instead of per file takes less time

## Functions

- [x] install packages
  - [x] read package list from package.json
  - [ ] add new packages to package.json
- [ ] remove packages
  - [ ] remove extra packages not specified in package.json
  - [ ] remove from specified packages from package.json

## Benchmark

The benchmark is done using this package as example.

node_modules and lock files are deleted before the test, and all packages were already cached by the installers

| Package Installer | Time used |
| ----------------- | --------- |
| **snpm**          | 81ms      |
| pnpm              | 1.7s      |
| npm               | 3.4s      |

Remark: `--prefer-offline` flag is used in pnpm's test
