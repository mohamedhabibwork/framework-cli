# @framework/cli

CLI runtime, command registry, and application/module/auth code generators.

> **Read-only subtree split** — This package is developed inside the main [**mohamedhabibwork/framework**](https://github.com/mohamedhabibwork/framework/tree/main/packages/cli) monorepo and automatically synced to [`mohamedhabibwork/framework-cli`](https://github.com/mohamedhabibwork/framework-cli). Please open issues and pull requests in the main framework repository.

## Ecosystem Links

- **Main Framework Repository**: [mohamedhabibwork/framework](https://github.com/mohamedhabibwork/framework)
- **Package Repository**: [mohamedhabibwork/framework-cli](https://github.com/mohamedhabibwork/framework-cli)
- **Starter Application Template**: [mohamedhabibwork/framework-app](https://github.com/mohamedhabibwork/framework-app)
- **Documentation Repository**: [mohamedhabibwork/framework-docs](https://github.com/mohamedhabibwork/framework-docs)
- **Documentation Site**: [https://framework.habib.cloud](https://framework.habib.cloud)

## Installation

### Inside a Standalone App (via GitHub)

```json
{
  "dependencies": {
    "@framework/cli": "github:mohamedhabibwork/framework-cli"
  }
}
```

```sh
bun install
```

### Creating a New Application

Use the starter application template repository to bootstrap a full application with all framework packages pre-wired:

```sh
gh repo create my-api --template mohamedhabibwork/framework-app --clone
cd my-api
bun install
```

## License

MIT
