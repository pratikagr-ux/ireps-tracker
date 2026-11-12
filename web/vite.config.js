import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves this app from
  // https://pratikagr-ux.github.io/ireps-tracker/ (project page, repo name
  // as path prefix, case-sensitive). The dev server still runs at root.
  base: command === 'build' ? '/ireps-tracker/' : '/',
  plugins: [react()],
  server: { port: 3001, open: true },
}));
