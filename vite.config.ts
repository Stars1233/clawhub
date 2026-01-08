import { createRequire } from 'node:module'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'

const require = createRequire(import.meta.url)
const resvgWasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')

const config = defineConfig({
  plugins: [
    devtools(),
    nitro({
      serverDir: 'server',
      externals: {
        traceInclude: [resvgWasmPath],
      },
    }),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
