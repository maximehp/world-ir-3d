import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works when mounted at /video2sim/ by world.server
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000/video2sim',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://127.0.0.1:8000/video2sim',
        changeOrigin: true,
      },
    },
  },
});
