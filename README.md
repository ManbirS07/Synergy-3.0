# Synergy

Synergy is a distributed browser-compute demo built on SpaceTimeDB. Volunteers open the edge page, contribute compute from their browser, and live dashboards visualize progress in real time.

## Demo Video

Use the link below to watch the project demo:

[Watch Demo](https://drive.google.com/file/d/10dLCMpfZh0s4sxv7-trG5n1uY9umbE0F/view?usp=sharing)

## What This Repo Contains

- SpaceTimeDB hub module in TypeScript (`spacetimedb/src/index.ts`)
- Browser edge client + worker (`src/client/image-render`)
- Server control dashboard (`src/client/dashboard`)
- Mandelbrot live canvas dashboard (`src/client/mandelbrot-dashboard`)
- Additional feature pages for PIN and Matrix workflows (`src/client/pin-*`, `src/client/matrix-*`)
- Generated SpaceTimeDB TypeScript bindings (`src/module_bindings`)

## Architecture

- Hub: authoritative queue/state + reducers in SpaceTimeDB
- Edge node: browser tab requests work, computes in Web Worker, submits results
- Dashboards: subscribe to tables and render live status

## Current Core Data Flow

The active core module uses these tables/reducers:

- Table `chunk_queue`
  - `chunkId` (u64 primary key)
  - `status` (`pending | processing | completed`)
  - `assignedNode` (identity, optional)
  - chunk bounds + dimensions + `pixelData`
- Table `node_status`
  - `nodeId` (identity primary key)
  - `donatedChunks`
  - `lastSeenMicros`
- Reducers
  - `request_work()`
  - `submit_result({ chunkId, pixelData })`
  - `heartbeat()`
  - `reset_grid({...})`

## Project Structure

```text
Synergy-3.0/
  spacetimedb/
    src/
      index.ts
  src/
    client/
      index.html
      dashboard/
      image-render/
      mandelbrot-dashboard/
      pin-crack/
      pin-dashboard/
      matrix-node/
      matrix-dashboard/
      wasm/
    module_bindings/
  package.json
```

## Prerequisites

- Node.js 20+
- SpaceTimeDB CLI installed and logged in (`spacetime login`) when publishing to maincloud

## Local Development Runbook

1. Start local SpaceTimeDB:

```bash
spacetime start
```

2. Publish module to local database `hack`:

```bash
spacetime publish hack --server local --clear-database -y --module-path spacetimedb
```

3. Regenerate bindings after schema/reducer updates:

```bash
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
```

4. Serve static files from `src` root:

```bash
npx serve src -l 4173
```

5. Open pages:

- Launcher: `http://localhost:4173/client/index.html`
- Server dashboard: `http://localhost:4173/client/dashboard/index.html`
- Edge node: `http://localhost:4173/client/image-render/index.html`
- Mandelbrot dashboard: `http://localhost:4173/client/mandelbrot-dashboard/index.html`

Important: serve `src`, not `src/client`, so `/module_bindings/index.js` resolves correctly.

## Maincloud Deployment

1. Publish backend module:

```bash
spacetime publish hack --server maincloud --module-path spacetimedb -y
```

2. Deploy frontend static files (example Vultr flow):

```bash
scp -r D:\Synergy\Synergy-3.0\src\* root@<your-server>:/var/www/synergy
```

3. Reload web server on host (example):

```bash
sudo systemctl reload nginx
```



