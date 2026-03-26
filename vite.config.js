import { defineConfig } from 'vite';

export default defineConfig({
    root: '.',
    base: '/sample_studio/',
    build: {
        rollupOptions: {
            input: './index.html',
        },
    },
});