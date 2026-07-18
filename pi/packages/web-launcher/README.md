# pi-web

Global launcher for the local Pi web example.

## Commands

```bash
pi-web
pi-web serve
pi-web build
pi-web doctor
```

## Options

```bash
pi-web --port 4173
pi-web --host 127.0.0.1
pi-web --no-open
```

`pi-web serve` hosts `packages/web-ui/example/dist`.

If the static site has not been built yet, run:

```bash
pi-web build
```
