# slnpm

A simple and fast package installer using symbolic link.

[![npm Package Version](https://img.shields.io/npm/v/slnpm)](https://www.npmjs.com/package/slnpm)

The design is heavily inspired by pnpm, which downloads and caches each npm package, then setup hardlink of each file to the project's node_modules.
However, this package setup symbolic link (softlink) of each package's directory.

## Feature

- save network - only need to download each package once
- save disk space - only need to store each package once
- save time - faster than npm and pnpm

## Advantages over pnpm

1. This tool setup symbolic link instead of hardlink, this allows the cache to be used across different file-systems / partitions

2. This tool setup link per package (directory) instead of per file, which takes less time

## Functions

- [x] install packages
  - [x] read package list from package.json
    - [x] support dependencies
    - [x] support devDependencies
    - [x] support peerDependencies
  - [x] add new packages to package.json
  - [ ] support local packages with `link:` and `file:` prefix
  - [x] support "bin" in packages.json (setup symbolic link in node_modules/.bin)
  - [x] recursively install in every package / project
- [x] remove packages
  - [x] remove extra packages not specified in package.json
  - [x] remove specified packages from package.json

## Benchmark

The benchmark is done using this package's dependencies as example.

node_modules and lock files are deleted before the test, and all packages were already cached by the installers.

The test was conducted on laptop with zst-compressed zfs and desktop with zst-compressed btrfs. The result is almost identical.

| Package Installer | Time used |
| ----------------- | --------- |
| **slnpm**         | 0.1s      |
| pnpm              | 1.5s      |
| npm               | 3.1s      |

Remark:

- `--prefer-offline` flag is used in pnpm's test
- The time used is average of 5 runs

## License

This project is licensed with [BSD-2-Clause](./LICENSE)

This is free, libre, and open-source software. It comes down to four essential freedoms [[ref]](https://seirdy.one/2021/01/27/whatsapp-and-the-domestication-of-users.html#fnref:2):

- The freedom to run the program as you wish, for any purpose
- The freedom to study how the program works, and change it so it does your computing as you wish
- The freedom to redistribute copies so you can help others
- The freedom to distribute copies of your modified versions to others
