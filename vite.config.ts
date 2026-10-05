import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { jevApi } from './server/jevApi';

export default defineConfig({ plugins: [react(), jevApi()], server: { port: 3000 } });
