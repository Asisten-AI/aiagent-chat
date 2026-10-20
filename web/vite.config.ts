import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Di dev, API & websocket diproksi supaya cookie sesi tetap same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
