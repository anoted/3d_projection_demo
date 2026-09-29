import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: true },
  // MediaPipe ships its own WASM loader; keep Vite from pre-bundling it.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  build: { chunkSizeWarningLimit: 2000 },
});
