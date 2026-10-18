import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Without this Vite finds MapLibre mid-session, answers 504 and the map never loads.
  optimizeDeps: { include: ['maplibre-gl', 'topojson-client'] },
  server: {
    port: 5174,
    strictPort: true,
  },
})