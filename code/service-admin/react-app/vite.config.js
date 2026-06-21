import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O build sai em ../front (service-admin/front), que é a pasta servida pelo
// FastAPI (substitui a antiga "static"). emptyOutDir limpa a pasta a cada build.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../front',
    emptyOutDir: true,
  },
})
