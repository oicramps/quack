# Building the Firefox add-on (for AMO reviewers)

The add-on is built with [WXT](https://wxt.dev) from a Yarn 1 workspace. `extension/` is the add-on; `shared/` holds constants and types it imports.

Requirements: Node.js 22 and Yarn 1.22 (`npm install -g yarn@1.22.19`).

```sh
yarn install --frozen-lockfile
QUACK_STORE=1 yarn workspace @quacksteps/extension wxt build -b firefox
```

The built add-on is in `extension/dist/store/firefox-mv3/` and matches the submitted package.

The add-on talks only to its local native-messaging host (`com.quack.companion`, published separately as the `quack-companion` npm package) and reads `github.com` pull request pages. It sends no data to any server of its own.
